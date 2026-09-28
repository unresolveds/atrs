import { User } from '../models/User';
import { Product } from '../models/Product';
import { Version } from '../models/Version';
import { AuditLogService } from './AuditLogService';
import { assertStoreAccess } from '../utils/ownership';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import { getAuthenticatedUser, listReleases, parseRepo } from '../utils/github';
import createHttpError from '../utils/httpError';
import type { AuthUser } from '../types/auth';

const auditLogService = new AuditLogService();

export interface GitHubStatus {
  connected: boolean;
  login: string | null;
  connectedAt: Date | null;
}

export interface ReleaseSyncResult {
  repo: string;
  total: number;
  created: number;
  updated: number;
  skipped: number;
}

export class GitHubService {
  /**
   * Connects (or replaces) the user's GitHub token. The token is validated
   * against the API first so we never store a dud, then encrypted at rest.
   */
  async connect(token: string, user: AuthUser): Promise<GitHubStatus> {
    const trimmed = token.trim();
    if (!trimmed) throw createHttpError(400, 'A GitHub token is required.');

    const { login } = await getAuthenticatedUser(trimmed); // throws on bad token

    const connectedAt = new Date();
    await User.findByIdAndUpdate(user.id, {
      githubToken: encryptSecret(trimmed),
      githubLogin: login,
      githubConnectedAt: connectedAt,
    });
    return { connected: true, login, connectedAt };
  }

  async disconnect(user: AuthUser): Promise<void> {
    await User.findByIdAndUpdate(user.id, {
      $unset: { githubToken: '', githubLogin: '', githubConnectedAt: '' },
    });
  }

  async getStatus(user: AuthUser): Promise<GitHubStatus> {
    const account = await User.findById(user.id).select('+githubToken githubLogin githubConnectedAt');
    const connected = !!account?.githubToken;
    return {
      connected,
      login: connected ? account?.githubLogin || null : null,
      connectedAt: connected ? account?.githubConnectedAt || null : null,
    };
  }

  /** Returns the user's decrypted token or throws a 400 prompting them to connect. */
  private async requireToken(user: AuthUser): Promise<string> {
    const account = await User.findById(user.id).select('+githubToken');
    if (!account?.githubToken) {
      throw createHttpError(400, 'No GitHub account connected. Connect one in Settings first.');
    }
    try {
      return decryptSecret(account.githubToken);
    } catch {
      // Secret rotated or row corrupted — force a reconnect.
      throw createHttpError(400, 'Stored GitHub token could not be read. Reconnect in Settings.');
    }
  }

  /**
   * Syncs a product's GitHub Releases into Versions. Idempotent: each release
   * maps to exactly one Version (matched by source+externalId), so re-running
   * only adds new releases and refreshes existing github-sourced rows. Manual
   * versions are never touched.
   */
  async syncReleases(productId: string, user: AuthUser): Promise<ReleaseSyncResult> {
    const product = await Product.findById(productId);
    assertStoreAccess(product, user); // 404s for non-owners; admins pass

    const parsed = parseRepo(product!.githubUrl);
    if (!parsed) {
      throw createHttpError(400, 'This product has no valid GitHub repository URL.');
    }

    const token = await this.requireToken(user);
    const releases = await listReleases(token, parsed.owner, parsed.repo);

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const r of releases) {
      const label = r.tagName || r.name;
      if (!label) { skipped++; continue; }

      const externalId = String(r.id);
      const existing = await Version.findOne({ productId, source: 'github', externalId });

      const fields = {
        label,
        notes: r.body || '',
        status: 'released' as const,
        releasedAt: r.publishedAt ? new Date(r.publishedAt) : undefined,
        author: r.author || '',
        externalUrl: r.htmlUrl || '',
      };

      if (existing) {
        // Refresh upstream-owned fields; leave manual edits to label alone if
        // the user renamed it (we only overwrite notes/date/author/url).
        existing.notes = fields.notes;
        existing.releasedAt = fields.releasedAt;
        existing.author = fields.author;
        existing.externalUrl = fields.externalUrl;
        await existing.save();
        updated++;
      } else {
        await Version.create({
          ...fields,
          productId,
          storeId: product!.storeId,
          source: 'github',
          externalId,
        });
        created++;
      }
    }

    await auditLogService.logEvent(
      'UPDATE',
      'PRODUCT',
      String(product!._id),
      product!.name,
      `Synced ${created} new / ${updated} updated version(s) from GitHub (${parsed.owner}/${parsed.repo})`,
      { id: user.id, name: user.name },
    );

    return { repo: `${parsed.owner}/${parsed.repo}`, total: releases.length, created, updated, skipped };
  }
}
