import mongoose from 'mongoose';
import { Product, type IProduct } from '../../../models/Product';
import { UninstallFeedback } from '../../../models/UninstallFeedback';
import { unsealSecret } from '../../../utils/crypto';
import {
  FreemiusClient, FreemiusApiError, MAX_PAGE,
  type FreemiusCredentials, type FreemiusUninstall,
} from './FreemiusClient';

/**
 * Pulls uninstall feedback from Freemius into `UninstallFeedback`.
 *
 * Two modes, because one cannot serve both jobs:
 *
 *  - **Incremental** (`syncProduct`) walks `events?type=install.uninstalled`.
 *    Cheap, and the normal scheduled path. The events feed is a recent window
 *    rather than full history — filtered rows exist at offset 0 but not at
 *    offset 100+ — so it catches up but can never reach back.
 *  - **Backfill** (`backfillProduct`) walks `installs` and fetches the uninstall
 *    object for every `is_uninstalled` row. That is one request per churned
 *    install (for Super Video Player, ~9.5k), so it is opt-in, bounded by
 *    `maxRequests`, and resumable via the returned `nextOffset`.
 *
 * Roughly half of uninstalls carry no feedback; a 404 is an expected outcome,
 * counted as `withoutFeedback` rather than treated as an error.
 */

export interface SyncResult {
  productId: string;
  /** Uninstall events examined. */
  examined: number;
  /** Rows written or refreshed. */
  stored: number;
  /** Uninstalls where the user gave no reason. */
  withoutFeedback: number;
  /** Requests spent, so a caller can reason about rate limits. */
  requests: number;
  /** Set by backfill when more remains; pass back as `startOffset` to resume. */
  nextOffset?: number;
  errors: string[];
}

/** Resolved credentials for one product, or null when it isn't connected. */
export function resolveCredentials(product: Pick<IProduct,
  'freemiusProductId' | 'freemiusPublicKey' | 'freemiusSecretKey'>): FreemiusCredentials | null {
  const entityId = (product.freemiusProductId || '').trim();
  const stored = {
    pub: unsealSecret((product.freemiusPublicKey || '').trim()),
    sec: unsealSecret((product.freemiusSecretKey || '').trim()),
  };
  // Env is the fallback for a single-product local setup, matching how the
  // Ollama endpoint resolves. Stored per-product keys win when present.
  const envId = (process.env.FREEMIUS_PRODUCT_ID || '').trim();
  const publicKey = stored.pub || (entityId && entityId === envId ? (process.env.FREEMIUS_PUBLIC_KEY || '').trim() : '');
  const secretKey = stored.sec || (entityId && entityId === envId ? (process.env.FREEMIUS_SECRET_KEY || '').trim() : '');

  if (!entityId || !publicKey || !secretKey) return null;
  return { entityId, publicKey, secretKey, scope: 'plugin' };
}

export class FreemiusSyncService {
  /** Products this owner has connected to Freemius. */
  static async connectedProducts(storeId?: string): Promise<IProduct[]> {
    const filter: Record<string, unknown> = { freemiusProductId: { $nin: ['', null] } };
    if (storeId) filter.storeId = storeId;
    return Product.find(filter).select('+freemiusPublicKey +freemiusSecretKey');
  }

  /**
   * Writes one uninstall record. Upserts on (productId, freemiusInstallId) so
   * overlapping sync windows converge instead of duplicating.
   */
  private static async store(
    product: IProduct,
    installId: number,
    u: FreemiusUninstall,
    install?: { version?: string; country_code?: string; sdk_version?: string },
  ): Promise<void> {
    const when = u.created ? new Date(u.created.replace(' ', 'T') + 'Z') : new Date();
    await UninstallFeedback.updateOne(
      { productId: product._id, freemiusInstallId: installId },
      {
        $set: {
          storeId: product.storeId,
          freemiusUninstallId: u.id,
          reasonId: Number(u.reason_id),
          // The API supplies the label; mapping ids locally would silently go
          // stale, and real ids already exceed the documented range.
          reason: String(u.reason ?? `reason ${u.reason_id}`),
          reasonInfo: String(u.reason_info ?? '').trim().slice(0, 2000),
          uninstalledAt: Number.isNaN(when.getTime()) ? new Date() : when,
          version: install?.version ?? '',
          countryCode: install?.country_code ?? '',
          sdkVersion: install?.sdk_version ?? '',
        },
      },
      { upsert: true },
    );
  }

  /** Incremental catch-up for one product. */
  static async syncProduct(product: IProduct, opts: { maxEvents?: number } = {}): Promise<SyncResult> {
    const result: SyncResult = {
      productId: String(product._id), examined: 0, stored: 0, withoutFeedback: 0, requests: 0, errors: [],
    };
    const creds = resolveCredentials(product);
    if (!creds) { result.errors.push('Product is not connected to Freemius.'); return result; }

    const client = new FreemiusClient(creds);
    const maxEvents = opts.maxEvents ?? 200;
    let offset = 0;

    try {
      while (result.examined < maxEvents) {
        const events = await client.listEventsOfType('install.uninstalled', offset, MAX_PAGE);
        result.requests++;
        if (events.length === 0) break;

        for (const ev of events) {
          if (!ev.install_id) continue;
          result.examined++;

          // Already recorded — the window overlaps by design, so this is the
          // common case and worth skipping before spending a request.
          const known = await UninstallFeedback.exists({
            productId: product._id, freemiusInstallId: ev.install_id,
          });
          if (known) continue;

          const u = await client.getUninstall(ev.install_id);
          result.requests++;
          if (!u) { result.withoutFeedback++; continue; }
          await this.store(product, ev.install_id, u);
          result.stored++;
        }

        if (events.length < MAX_PAGE) break;
        offset += events.length;
      }
    } catch (err) {
      result.errors.push(err instanceof FreemiusApiError
        ? `Freemius ${err.status} on ${err.path}: ${err.message}`
        : err instanceof Error ? err.message : String(err));
    }
    return result;
  }

  /**
   * Opt-in historical backfill. Bounded by `maxRequests` and resumable, because
   * a full pass is thousands of calls and must not monopolise a scheduler tick.
   */
  static async backfillProduct(
    product: IProduct,
    opts: { startOffset?: number; maxRequests?: number } = {},
  ): Promise<SyncResult> {
    const result: SyncResult = {
      productId: String(product._id), examined: 0, stored: 0, withoutFeedback: 0, requests: 0, errors: [],
    };
    const creds = resolveCredentials(product);
    if (!creds) { result.errors.push('Product is not connected to Freemius.'); return result; }

    const client = new FreemiusClient(creds);
    const maxRequests = opts.maxRequests ?? 500;
    let offset = opts.startOffset ?? 0;

    try {
      while (result.requests < maxRequests) {
        const installs = await client.listInstalls(offset, MAX_PAGE);
        result.requests++;
        if (installs.length === 0) { result.nextOffset = undefined; return result; }

        // If the budget runs out part-way through a page, the page must be
        // re-scanned on resume rather than stepped over — advancing past it
        // would skip those installs permanently. Re-scanning is nearly free
        // because rows already stored are skipped before spending a request.
        let exhaustedMidPage = false;
        for (const inst of installs) {
          if (!inst.is_uninstalled) continue;
          if (result.requests >= maxRequests) { exhaustedMidPage = true; break; }
          result.examined++;

          const known = await UninstallFeedback.exists({
            productId: product._id, freemiusInstallId: inst.id,
          });
          if (known) continue;

          const u = await client.getUninstall(inst.id);
          result.requests++;
          if (!u) { result.withoutFeedback++; continue; }
          await this.store(product, inst.id, u, inst);
          result.stored++;
        }

        if (exhaustedMidPage) { result.nextOffset = offset; return result; }

        offset += installs.length;
        // A short page means the collection is exhausted.
        if (installs.length < MAX_PAGE) { result.nextOffset = undefined; return result; }
      }
      // Ran out of budget with work remaining.
      result.nextOffset = offset;
    } catch (err) {
      result.nextOffset = offset;
      result.errors.push(err instanceof FreemiusApiError
        ? `Freemius ${err.status} on ${err.path}: ${err.message}`
        : err instanceof Error ? err.message : String(err));
    }
    return result;
  }

  /** Scheduled entry point: incremental sync across every connected product. */
  static async syncAll(): Promise<{ products: number; stored: number; errors: string[] }> {
    const products = await this.connectedProducts();
    let stored = 0;
    const errors: string[] = [];
    for (const p of products) {
      const r = await this.syncProduct(p);
      stored += r.stored;
      for (const e of r.errors) errors.push(`${p.name}: ${e}`);
    }
    return { products: products.length, stored, errors };
  }
}

/** Exposed for the detector layer so it and the sync agree on the model reference. */
export { UninstallFeedback };
export type { mongoose };
