import { ProductRepository } from '../repositories/ProductRepository';
import { IProduct, Product } from '../models/Product';
import { baseSlug, disambiguateSlug } from '../utils/slug';
import { AuditLogService } from './AuditLogService';

const auditLogService = new AuditLogService();

import { ActivityService } from './ActivityService';
import { ProductMarketingService } from './ProductMarketingService';
import { Activity } from '../models/Activity';
import { Version } from '../models/Version';
import { ProductMarketing } from '../models/ProductMarketing';
import { deleteMediaFiles } from '../utils/fileUtils';
import { storeFilter, assertStoreAccess, requireStoreId} from '../utils/ownership';
import { parseLimit, parsePage } from '../utils/pagination';
import createHttpError from '../utils/httpError';
import { escapeRegex } from '../utils/sanitize';
import { parseReadmeChangelog, canonicalVersion, changelogFingerprint } from '../utils/readmeChangelog';
import type { AuthUser } from '../types/auth';

// Filled into the required shortDescription for changelog entries imported from
// a readme (which only provides a one-line change), so they're easy to spot.
const IMPORTED_CHANGELOG_DESC = 'Imported from WordPress.org changelog — add details.';

export type ImportProgress = {
  type: 'info' | 'success' | 'warn' | 'error';
  slug?: string;
  step: string;
  message: string;
  pluginIndex?: number;
  totalPlugins?: number;
};

export class ProductService {
  private repository: ProductRepository;

  constructor() {
    this.repository = new ProductRepository();
  }

  /**
   * Builds a slug for `name` that is unique within `storeId`'s products.
   * `excludeId` skips the product being updated so it doesn't collide with itself.
   */
  private async uniqueSlugForOwner(name: string, storeId: string, excludeId?: string): Promise<string> {
    const base = baseSlug(name);
    const filter: any = { storeId, slug: { $regex: `^${base}(-\\d+)?$` } };
    if (excludeId) filter._id = { $ne: excludeId };
    const taken = new Set<string>(await Product.find(filter).distinct('slug'));
    return disambiguateSlug(base, taken);
  }

  async createProduct(data: any, user: AuthUser): Promise<IProduct> {
    // uniqueSlugForOwner reads-then-writes, so two concurrent creates for the
    // same owner+name can compute the same slug and collide on the
    // { storeId, slug } unique index. Retry a few times (recomputing the slug,
    // which now sees the winner) before giving up with a clean 409.
    for (let attempt = 0; attempt < 4; attempt++) {
      const slug = await this.uniqueSlugForOwner(data.name, user.id);
      try {
        const product = await this.repository.create({ ...data, slug, storeId: requireStoreId(user) });
        await auditLogService.logEvent('CREATE', 'PRODUCT', product._id.toString(), product.name, 'Added a new product', { id: user.id, name: user.name });
        return product;
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
      }
    }
    throw createHttpError(409, 'Could not generate a unique slug for this product name; please try again.');
  }

  async getProducts(query: any, user: AuthUser): Promise<any> {
    // Scope to the user's own products; admins are unrestricted and may
    // additionally narrow by a specific owner via ?storeId.
    const filter: any = storeFilter(user);
    if (query.search) {
      filter.name = { $regex: escapeRegex(query.search), $options: 'i' };
    }
    if (query.category) {
      filter.category = query.category;
    }
    if (query.status) {
      filter.status = query.status;
    }
    if (query.storeId && user.role === 'admin') {
      filter.storeId = query.storeId;
    }
    const options = {
      page: parsePage(query.page),
      limit: parseLimit(query.limit)
    };
    return await this.repository.findAll(filter, options);
  }

  async getProductById(id: string, user: AuthUser): Promise<IProduct | null> {
    const product = await this.repository.findById(id);
    if (!product) throw createHttpError(404, 'Product not found');
    // Non-admins may only view their own products (404 so ids can't be probed).
    assertStoreAccess(product, user);
    return product;
  }

  /**
   * Public (no auth): every active product across all owners. Powers the public
   * /explore directory. Returns a minimal, safe projection — no owner or
   * internal fields — sorted by name. Each product's changelog/issues links are
   * surfaced per-card only when that product has opted into them.
   */
  async getPublicProducts(): Promise<any[]> {
    // `$ne: false` keeps legacy products (field absent) listed by default.
    const products = await Product.find({ status: 'active', listedInDirectory: { $ne: false } })
      .select('name slug description icon banner category githubUrl wpOrgSlug publicChangelogEnabled publicIssuesEnabled')
      .sort({ name: 1 })
      .lean();

    return products.map((p: any) => ({
      id: String(p._id),
      name: p.name,
      slug: p.slug,
      description: p.description || '',
      icon: p.icon || '',
      banner: p.banner || '',
      category: p.category,
      githubUrl: p.githubUrl || '',
      wpOrgSlug: p.wpOrgSlug || '',
      publicChangelogEnabled: !!p.publicChangelogEnabled,
      publicIssuesEnabled: !!p.publicIssuesEnabled,
    }));
  }

  /**
   * Products that haven't had a changelog entry in the last `days` days (or
   * never have one) — surfaced on the dashboard as an "update reminder".
   * "Last updated" = the product's most recent activity date. Owner-scoped.
   */
  async getStaleProducts(user: AuthUser, days: number): Promise<{ days: number; products: any[] }> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const products = await Product.find(storeFilter(user))
      .select('name slug icon category status updatedAt')
      .lean();
    if (products.length === 0) return { days, products: [] };

    const ids = products.map((p: any) => p._id);
    const agg = await Activity.aggregate([
      { $match: { productId: { $in: ids } } },
      { $group: { _id: '$productId', last: { $max: '$activityDate' } } },
    ]);
    const lastMap = new Map<string, Date>(agg.map((a: any) => [String(a._id), a.last]));

    const stale = products
      .map((p: any) => ({
        _id: String(p._id),
        name: p.name,
        slug: p.slug,
        icon: p.icon || '',
        category: p.category,
        status: p.status,
        lastActivityAt: lastMap.get(String(p._id)) || null,
      }))
      .filter((p) => !p.lastActivityAt || new Date(p.lastActivityAt) < cutoff)
      .sort((a, b) => {
        // Most stale first; "never updated" (null) sorts to the very top.
        const ta = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
        const tb = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
        return ta - tb;
      });

    return { days, products: stale };
  }

  async updateProduct(id: string, data: any, user: AuthUser): Promise<IProduct | null> {
    const existing = await this.repository.findById(id);
    if (!existing) throw createHttpError(404, 'Product not found');
    if (user.role !== 'admin' && existing.storeId.toString() !== user.id) {
      throw createHttpError(403, 'Forbidden: You do not have permission to edit this product');
    }
    delete data.storeId; // ownership is not editable through this path
    if (data.name) {
      data.slug = await this.uniqueSlugForOwner(data.name, existing!.storeId.toString(), id);
    }
    const product = await this.repository.update(id, data);
    if (product) {
      await auditLogService.logEvent('UPDATE', 'PRODUCT', product._id.toString(), product.name, 'Updated product details', { id: user.id, name: user.name });
    }
    return product;
  }

  async bulkDeleteProducts(ids: string[], user: AuthUser): Promise<{ deleted: number; errors: string[] }> {
    let deleted = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        await this.deleteProduct(id, user);
        deleted++;
      } catch (err: any) {
        errors.push(`${id}: ${err.message}`);
      }
    }
    return { deleted, errors };
  }

  async fetchWpOrgPlugins(username: string): Promise<any[]> {
    const url =
      `https://api.wordpress.org/plugins/info/1.2/?action=query_plugins` +
      `&request[author]=${encodeURIComponent(username)}` +
      `&request[per_page]=100` +
      `&request[fields][icons]=1&request[fields][banners]=1` +
      `&request[fields][tags]=1&request[fields][short_description]=1` +
      `&request[fields][versions]=1`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch from WordPress.org API');
    const data: any = await response.json();
    return data.plugins || [];
  }

  /**
   * Fetch a single plugin's info directly by its slug (no author username
   * required). Used by the onboarding "import a specific plugin" path. Returns
   * the plugin object in the same shape as fetchWpOrgPlugins(), or null when the
   * slug doesn't resolve to a published plugin.
   */
  async fetchWpOrgPluginBySlug(slug: string): Promise<any | null> {
    const url =
      `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information` +
      `&request[slug]=${encodeURIComponent(slug)}` +
      `&request[fields][icons]=1&request[fields][banners]=1` +
      `&request[fields][tags]=1&request[fields][short_description]=1` +
      `&request[fields][versions]=1`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data: any = await response.json();
    // The API returns { error: "Plugin not found." } for unknown slugs.
    if (!data || data.error || !data.slug) return null;
    return data;
  }

  /**
   * Fetch version tags and their metadata (release date, author, release notes)
   * directly from WordPress.org's Subversion repository using WebDAV.
   * Bypasses WAF blocks that affect Trac browser and Trac RSS.
   */
  private async fetchSvnVersionData(
    slug: string
  ): Promise<{ label: string; releasedAt: Date | null; author: string; notes: string }[]> {
    try {
      const tagsUrl = `https://plugins.svn.wordpress.org/${encodeURIComponent(slug)}/tags/`;

      // 1. Fetch tags list with Depth: 1 to get revision, author and date of each tag folder
      const propBody = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:">
  <prop>
    <version-name/>
    <creator-displayname/>
    <creationdate/>
  </prop>
</propfind>`;

      const propRes = await fetch(tagsUrl, {
        method: 'PROPFIND',
        headers: {
          'Depth': '1',
          'Content-Type': 'text/xml',
          'User-Agent': 'SVN/1.9.5 ATRS/1.0',
        },
        body: propBody,
      });

      if (!propRes.ok) {
        console.warn(`[WP Import] ${slug}: PROPFIND failed with status ${propRes.status}`);
        return [];
      }

      const propText = await propRes.text();
      const tags: { label: string; revision: number; creator: string; created: string }[] = [];
      const responseRegex = /<D:response([\s\S]*?)<\/D:response>/gi;
      let match: RegExpExecArray | null;

      while ((match = responseRegex.exec(propText)) !== null) {
        const block = match[1];
        const hrefMatch = block.match(/<D:href>([^<]+)<\/D:href>/);
        const versionMatch = block.match(/<lp1:version-name>([^<]+)<\/lp1:version-name>/);
        const creatorMatch = block.match(/<lp1:creator-displayname>([^<]+)<\/lp1:creator-displayname>/);
        const createdMatch = block.match(/<lp1:creationdate>([^<]+)<\/lp1:creationdate>/);

        const href = hrefMatch ? hrefMatch[1] : '';
        const rawRev = versionMatch ? versionMatch[1] : '';
        const creator = creatorMatch ? creatorMatch[1] : '';
        const created = createdMatch ? createdMatch[1] : '';

        // Extract label from href (e.g. "/image-viewer/tags/1.0.0/" or "/image-viewer/tags/1.0.0")
        if (href && href !== `/${slug}/tags/` && href !== `/${slug}/tags`) {
          const parts = href.replace(/\/$/, '').split('/');
          const label = parts[parts.length - 1];
          const revision = parseInt(rawRev, 10);
          if (label && label !== 'tags' && !isNaN(revision)) {
            tags.push({ label, revision, creator, created });
          }
        }
      }

      console.log(`[WP Import] ${slug}: Found ${tags.length} tags from SVN PROPFIND`);
      if (tags.length === 0) return [];

      // 2. Fetch comments for all tag revisions in parallel batches (bypasses slow range scans)
      const commentsMap = new Map<number, string>();
      try {
        const uniqueRevisions = Array.from(new Set(tags.map(t => t.revision)));
        const reportUrl = `https://plugins.svn.wordpress.org/${encodeURIComponent(slug)}/`;
        const batchSize = 10;

        for (let i = 0; i < uniqueRevisions.length; i += batchSize) {
          const batch = uniqueRevisions.slice(i, i + batchSize);
          await Promise.all(
            batch.map(async (rev) => {
              try {
                const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<S:log-report xmlns:S="svn:">
  <S:start-revision>${rev}</S:start-revision>
  <S:end-revision>${rev}</S:end-revision>
  <S:path></S:path>
</S:log-report>`;

                const reportRes = await fetch(reportUrl, {
                  method: 'REPORT',
                  headers: {
                    'Content-Type': 'text/xml',
                    'User-Agent': 'SVN/1.9.5 ATRS/1.0',
                  },
                  body: reportBody,
                });

                if (reportRes.ok) {
                  const reportText = await reportRes.text();
                  const commentMatch = reportText.match(/<D:comment>([\s\S]*?)<\/D:comment>/);
                  if (commentMatch) {
                    commentsMap.set(rev, commentMatch[1].trim());
                  }
                }
              } catch (err: any) {
                console.warn(`[WP Import] ${slug}: Failed to fetch comment for revision ${rev}: ${err.message}`);
              }
            })
          );
        }
      } catch (err: any) {
        console.warn(`[WP Import] ${slug}: Parallel SVN comment queries failed: ${err.message}`);
      }

      // 3. Map everything into the final format
      return tags.map(t => {
        const releasedAt = t.created ? new Date(t.created) : null;
        return {
          label: t.label,
          releasedAt: releasedAt && !isNaN(releasedAt.getTime()) ? releasedAt : null,
          author: t.creator || '',
          notes: commentsMap.get(t.revision) || '',
        };
      });
    } catch (err: any) {
      console.error(`[WP Import] ${slug}: fetchSvnVersionData failed:`, err);
      return [];
    }
  }

  /**
   * Fetch the raw readme.txt from the plugin's SVN trunk.
   */
  private async fetchSvnReadme(slug: string): Promise<string> {
    try {
      const res = await fetch(`https://plugins.svn.wordpress.org/${encodeURIComponent(slug)}/trunk/readme.txt`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ATRS/1.0)' },
      });
      if (!res.ok) return '';
      return await res.text();
    } catch {
      return '';
    }
  }

  async wpOrgPreview(username: string, user: AuthUser): Promise<any[]> {
    const plugins = await this.fetchWpOrgPlugins(username);
    const existingSlugs = await Product.find({
      storeId: requireStoreId(user),
      wpOrgSlug: { $in: plugins.map((p: any) => p.slug) },
    }).distinct('wpOrgSlug');

    return plugins.map((p: any) => {
      const tags: string[] = Object.keys(p.tags || {});
      const isBlock = tags.some(t =>
        ['block', 'blocks', 'gutenberg', 'gutenberg-blocks', 'gutenberg-block'].includes(t.toLowerCase())
      );
      return {
        slug: p.slug,
        name: p.name,
        shortDescription: p.short_description || '',
        icon: p.icons?.['2x'] || p.icons?.['1x'] || '',
        banner: p.banners?.high || p.banners?.low || '',
        tags,
        category: isBlock ? 'block' : 'plugin',
        alreadyImported: existingSlugs.includes(p.slug),
      };
    });
  }

  /**
   * Resolve a list of slugs directly (no author lookup) into the same preview
   * shape as {@link wpOrgPreview}, so the slug import flow can show the
   * "select / will update" list before importing. Unknown slugs are dropped.
   */
  async wpOrgPreviewBySlug(slugs: string[], user: AuthUser): Promise<any[]> {
    const resolved = (await Promise.all(slugs.map((s) => this.fetchWpOrgPluginBySlug(s)))).filter(Boolean);

    const existingSlugs = await Product.find({
      storeId: requireStoreId(user),
      wpOrgSlug: { $in: resolved.map((p: any) => p.slug) },
    }).distinct('wpOrgSlug');

    return resolved.map((p: any) => {
      const tags: string[] = Object.keys(p.tags || {});
      const isBlock = tags.some(t =>
        ['block', 'blocks', 'gutenberg', 'gutenberg-blocks', 'gutenberg-block'].includes(t.toLowerCase())
      );
      return {
        slug: p.slug,
        name: p.name,
        shortDescription: p.short_description || '',
        icon: p.icons?.['2x'] || p.icons?.['1x'] || '',
        banner: p.banners?.high || p.banners?.low || '',
        tags,
        category: isBlock ? 'block' : 'plugin',
        alreadyImported: existingSlugs.includes(p.slug),
      };
    });
  }

  async importFromWpOrg(
    username: string,
    slugs: string[],
    user: AuthUser,
    onProgress?: (event: ImportProgress) => void,
    isCancelled?: () => boolean
  ): Promise<any> {
    const emit = (e: ImportProgress) => { if (onProgress) onProgress(e); };
    const cancelled = () => (isCancelled ? isCancelled() : false);

    let toImport: any[];
    if (username && username.trim()) {
      // Author-based: fetch the user's whole catalogue, then keep the selected slugs.
      emit({ type: 'info', step: 'fetch-api', message: `Fetching plugins from WordPress.org for user "${username}"...` });
      console.log(`[WP Import] importFromWpOrg called: username=${username}, slugs=${JSON.stringify(slugs)}`);
      const plugins = await this.fetchWpOrgPlugins(username);
      console.log(`[WP Import] WP API returned ${plugins.length} plugins`);
      toImport = plugins.filter((p: any) => slugs.includes(p.slug));
      emit({ type: 'info', step: 'fetch-api', message: `WordPress.org API returned ${plugins.length} plugins, ${toImport.length} selected for import` });
    } else {
      // Slug-based (no username): resolve each slug directly via plugin_information.
      emit({ type: 'info', step: 'fetch-api', message: `Looking up ${slugs.length} plugin(s) by slug on WordPress.org...` });
      console.log(`[WP Import] importFromWpOrg called: slug-only, slugs=${JSON.stringify(slugs)}`);
      const resolved = await Promise.all(slugs.map((s) => this.fetchWpOrgPluginBySlug(s)));
      toImport = resolved.filter(Boolean);
      const missing = slugs.filter((_s, i) => !resolved[i]);
      missing.forEach((s) => emit({ type: 'warn', step: 'fetch-api', slug: s, message: `Plugin "${s}" not found on WordPress.org` }));
      emit({ type: 'info', step: 'fetch-api', message: `Resolved ${toImport.length} of ${slugs.length} plugin(s) for import` });
    }
    console.log(`[WP Import] ${toImport.length} plugins to import: ${toImport.map((p: any) => p.slug).join(', ')}`);

    const created: any[] = [];
    const updated: any[] = [];
    const errors: string[] = [];

    let wasCancelled = false;
    for (let idx = 0; idx < toImport.length; idx++) {
      // Cancellation is checked between plugins; the in-flight plugin (if any)
      // always finishes so we never leave a half-written product behind.
      if (cancelled()) { wasCancelled = true; break; }

      const plugin = toImport[idx];
      const pctx = { slug: plugin.slug, pluginIndex: idx + 1, totalPlugins: toImport.length };
      const tags = Object.keys(plugin.tags || {});
      const isBlock = tags.some(t =>
        ['block', 'blocks', 'gutenberg', 'gutenberg-blocks', 'gutenberg-block'].includes(t.toLowerCase())
      );

      try {
        // Build version data from SVN WebDAV, and fetch readme in parallel.
        emit({ ...pctx, type: 'info', step: 'fetch-svn', message: `Fetching SVN version tags & readme.txt...` });
        const [tracTags, readme] = await Promise.all([
          this.fetchSvnVersionData(plugin.slug),
          this.fetchSvnReadme(plugin.slug),
        ]);
        emit({ ...pctx, type: 'info', step: 'fetch-svn', message: `Found ${tracTags.length} version tags, readme ${readme ? `fetched (${(readme.length / 1024).toFixed(1)} KB)` : 'not found'}` });

        const wpData = {
          name: plugin.name,
          description: plugin.short_description || '',
          category: (isBlock ? 'block' : 'plugin') as IProduct['category'],
          wpOrgSlug: plugin.slug,
          icon: plugin.icons?.['2x'] || plugin.icons?.['1x'] || '',
          banner: plugin.banners?.high || plugin.banners?.low || '',
          wpReadme: readme,
        };

        const existing = await Product.findOne({ storeId: requireStoreId(user), wpOrgSlug: plugin.slug });
        let product: any;
        if (existing) {
          emit({ ...pctx, type: 'info', step: 'db-sync', message: `Updating existing product in database...` });
          product = await this.repository.update(existing._id.toString(), wpData);
          if (product) {
            await auditLogService.logEvent('UPDATE', 'PRODUCT', product._id.toString(), product.name, 'Updated product from WordPress.org import', { id: user.id, name: user.name });
            updated.push(product);
            emit({ ...pctx, type: 'success', step: 'db-sync', message: `Product updated successfully` });
          }
        } else {
          emit({ ...pctx, type: 'info', step: 'db-sync', message: `Creating new product in database...` });
          product = await this.createProduct({
            ...wpData,
            githubUrl: `https://wordpress.org/plugins/${plugin.slug}`,
          }, user);
          created.push(product);
          emit({ ...pctx, type: 'success', step: 'db-sync', message: `Product created successfully` });
        }

        // Sync Version records from Trac tags: create new ones, update existing
        // ones that are missing releasedAt / notes metadata.
        if (product && tracTags.length > 0) {
          emit({ ...pctx, type: 'info', step: 'version-sync', message: `Syncing ${tracTags.length} versions...` });
          const existingVersions = await Version.find({ productId: product._id }).lean();
          const existingByLabel = new Map(existingVersions.map((v: any) => [v.label, v]));
          console.log(`[WP Import] ${plugin.slug}: ${tracTags.length} trac tags, ${existingVersions.length} existing versions`);

          const toInsert: any[] = [];
          const bulkOps: any[] = [];

          for (const tag of tracTags) {
            const existing = existingByLabel.get(tag.label);
            if (!existing) {
              // Brand new version — insert.
              toInsert.push({
                productId: product._id,
                storeId: product.storeId,
                label: tag.label,
                notes: tag.notes,
                status: 'released',
                releasedAt: tag.releasedAt,
                author: tag.author,
              });
            } else {
              // The version exists in ATRS AND is present among WordPress.org's
              // release tags — so it is, by definition, released. Reconcile:
              //   - flip a locally "unreleased" version to "released" (a version
              //     drafted here before it shipped — now confirmed live), and
              //   - backfill any missing releasedAt / notes / author metadata.
              const set: any = {};
              if (existing.status === 'unreleased') {
                set.status = 'released';
                set.releasedAt = tag.releasedAt ?? existing.releasedAt ?? new Date();
              }
              if (tag.releasedAt && !existing.releasedAt) set.releasedAt = tag.releasedAt;
              if (tag.notes && !existing.notes) set.notes = tag.notes;
              if (tag.author && !existing.author) set.author = tag.author;
              if (Object.keys(set).length > 0) {
                bulkOps.push({ updateOne: { filter: { _id: existing._id }, update: { $set: set } } });
              }
            }
          }

          console.log(`[WP Import] ${plugin.slug}: ${toInsert.length} to insert, ${bulkOps.length} to update`);
          if (toInsert.length > 0) {
            await Version.insertMany(toInsert, { ordered: false });
            console.log(`[WP Import] ${plugin.slug}: inserted ${toInsert.length} versions`);
          }
          if (bulkOps.length > 0) {
            await Version.bulkWrite(bulkOps);
            console.log(`[WP Import] ${plugin.slug}: updated ${bulkOps.length} versions`);
          }

          // Reconcile changelog entries the same way: any activity still flagged
          // "unreleased" that belongs to a version WordPress.org now reports as
          // released is, by definition, released too. Preserve other tags by
          // swapping just the unreleased→released tag (not overwriting the array).
          let reconciledActs = 0;
          const releasedLabels = new Set(tracTags.map((t) => t.label));
          const releasedVersionIds = existingVersions
            .filter((v: any) => releasedLabels.has(v.label))
            .map((v: any) => v._id);
          if (releasedVersionIds.length > 0) {
            const stale = await Activity.find({
              productId: product._id,
              versionId: { $in: releasedVersionIds },
              tags: 'unreleased',
            })
              .select('_id')
              .lean();
            if (stale.length > 0) {
              const staleIds = stale.map((a: any) => a._id);
              await Activity.updateMany({ _id: { $in: staleIds } }, { $pull: { tags: 'unreleased' } });
              await Activity.updateMany({ _id: { $in: staleIds } }, { $addToSet: { tags: 'released' } });
              reconciledActs = staleIds.length;
              console.log(`[WP Import] ${plugin.slug}: reconciled ${reconciledActs} unreleased→released changelog entries`);
            }
          }

          emit({
            ...pctx,
            type: 'success',
            step: 'version-sync',
            message: `Versions synced: ${toInsert.length} inserted, ${bulkOps.length} updated${reconciledActs > 0 ? `, ${reconciledActs} entries marked released` : ''}`,
          });
        } else {
          emit({ ...pctx, type: 'info', step: 'version-sync', message: `No version tags to sync` });
          console.log(`[WP Import] ${plugin.slug}: skipping version sync (product=${!!product}, tracTags=${tracTags.length})`);
        }

        // Parse the readme.txt Changelog section into changelog entries
        // (activities), one per change line. Deduped by version + title so a
        // re-import only adds new lines and never clobbers manual edits.
        if (product && readme) {
          try {
            const parsed = parseReadmeChangelog(readme);
            if (parsed.length > 0) {
              emit({ ...pctx, type: 'info', step: 'changelog', message: `Parsing changelog from readme...` });

              const versionDocs = await Version.find({ productId: product._id }).select('label releasedAt').lean();
              const versionByLabel = new Map(versionDocs.map((v: any) => [v.label, v]));
              // Second index on the canonical numeric form so a readme heading
              // of "1.0" still resolves to the SVN tag "1.0.0" rather than
              // importing an entry with no version at all.
              const versionByCanonical = new Map(versionDocs.map((v: any) => [canonicalVersion(v.label), v]));
              const labelByVersionId = new Map(versionDocs.map((v: any) => [v._id.toString(), v.label]));

              const norm = (s: string) => s.trim().toLowerCase();
              const existingActs = await Activity.find({ productId: product._id })
                .select('title versionId importSourceKey importFingerprint')
                .lean();
              // Dedup against three identities so a re-import skips a line it
              // has already created:
              //  - importSourceKey: the stable key stamped at import time. This
              //    survives the user editing the title/description, so their
              //    manual edits are never re-inserted or clobbered.
              //  - version|title: legacy fallback for entries imported before
              //    importSourceKey existed (and for manually-authored entries
              //    that happen to match a readme line).
              //  - importFingerprint: the content identity, keyed on the version
              //    the entry is LINKED to and a punctuation-insensitive title.
              //    importSourceKey alone keys off the readme heading, so two
              //    headings resolving to one Version ("1.7.1"/"1.7.2" both
              //    linked to 1.7.2) produced two keys and a visible duplicate.
              const existingKeys = new Set<string>();
              for (const a of existingActs as any[]) {
                if (a.importSourceKey) existingKeys.add(a.importSourceKey);
                const label = a.versionId ? (labelByVersionId.get(a.versionId.toString()) || '') : '';
                existingKeys.add(`${label}|${norm(a.title)}`);
                if (a.importFingerprint) existingKeys.add(a.importFingerprint);
                // Entries imported before importFingerprint existed: derive it
                // the same way, falling back to the readme label recorded in the
                // legacy key when the entry never linked to a Version.
                const fpLabel = label || (a.importSourceKey ? String(a.importSourceKey).split('|')[0] : '');
                existingKeys.add(changelogFingerprint(fpLabel, a.title));
              }

              const toInsertActs: any[] = [];
              for (const block of parsed) {
                const v: any =
                  versionByLabel.get(block.version) ?? versionByCanonical.get(canonicalVersion(block.version));
                const activityDate = block.releasedAt || v?.releasedAt || new Date();
                for (const item of block.items) {
                  const key = `${block.version}|${norm(item.title)}`;
                  // Fingerprint on the resolved version so two readme headings
                  // that land on the same Version can't both be inserted.
                  const fingerprint = changelogFingerprint(v?.label || block.version, item.title);
                  if (existingKeys.has(key) || existingKeys.has(fingerprint)) continue;
                  existingKeys.add(key);
                  existingKeys.add(fingerprint);
                  // The readme rarely tags every line with an explicit
                  // "Fix:/Add:" prefix, so the type is often a guess. Flag any
                  // entry whose type wasn't derived from an explicit prefix
                  // (confidence below "high") for quick human review.
                  const needsReview = item.confidence !== 'high';
                  toInsertActs.push({
                    productId: product._id,
                    storeId: product.storeId,
                    type: item.type,
                    title: item.title,
                    shortDescription: IMPORTED_CHANGELOG_DESC,
                    tags: ['released'],
                    ...(v ? { versionId: v._id } : {}),
                    activityDate,
                    importSourceKey: key,
                    importFingerprint: fingerprint,
                    needsReview,
                    importConfidence: item.confidence,
                    ...(needsReview ? { reviewReason: 'uncertain-type' } : {}),
                  });
                }
              }

              if (toInsertActs.length > 0) {
                // ordered:false + tolerate E11000: the unique
                // { productId, importSourceKey } index rejects any entry a
                // concurrent/overlapping import already inserted, so races
                // silently skip the dupes instead of creating them or failing.
                let insertedCount = toInsertActs.length;
                try {
                  await Activity.insertMany(toInsertActs, { ordered: false });
                } catch (bulkErr: any) {
                  if (bulkErr?.code === 11000 || bulkErr?.writeErrors) {
                    const dupes = (bulkErr.writeErrors?.length) ?? 0;
                    insertedCount = Math.max(0, toInsertActs.length - dupes);
                    console.log(`[WP Import] ${plugin.slug}: skipped ${dupes} duplicate changelog ${dupes === 1 ? 'entry' : 'entries'} (already imported)`);
                  } else {
                    throw bulkErr;
                  }
                }
                emit({ ...pctx, type: 'success', step: 'changelog', message: `Created ${insertedCount} changelog ${insertedCount === 1 ? 'entry' : 'entries'} from readme` });
              } else {
                emit({ ...pctx, type: 'info', step: 'changelog', message: `Changelog already up to date` });
              }
            }
          } catch (err: any) {
            // Never fail the whole import over changelog parsing.
            emit({ ...pctx, type: 'warn', step: 'changelog', message: `Changelog import skipped: ${err.message}` });
          }
        }

        emit({ ...pctx, type: 'success', step: 'done', message: `✓ Import complete` });
      } catch (err: any) {
        errors.push(`${plugin.slug}: ${err.message}`);
        emit({ ...pctx, type: 'error', step: 'error', message: `✗ Failed: ${err.message}` });
      }
    }

    // If the import was cancelled, roll back every product created in this
    // session (cascading their versions). Products that already existed and
    // were merely *updated* are left untouched — only new rows are removed.
    let rolledBack = 0;
    if (wasCancelled) {
      emit({
        type: 'warn',
        step: 'cancel',
        message: created.length
          ? `Import cancelled — rolling back ${created.length} newly created product(s)...`
          : `Import cancelled — nothing to roll back.`,
      });

      for (let i = 0; i < created.length; i++) {
        const p = created[i];
        const rctx = { slug: p.wpOrgSlug, pluginIndex: i + 1, totalPlugins: created.length };
        emit({ ...rctx, type: 'info', step: 'rollback', message: `Removing created product "${p.name}"...` });
        try {
          await this.deleteProduct(p._id.toString(), user);
          rolledBack++;
          emit({ ...rctx, type: 'success', step: 'rollback', message: `Removed "${p.name}"` });
        } catch (err: any) {
          errors.push(`rollback ${p.wpOrgSlug}: ${err.message}`);
          emit({ ...rctx, type: 'error', step: 'rollback', message: `Failed to remove "${p.name}": ${err.message}` });
        }
      }

      const cancelSummary = `Import cancelled: rolled back ${rolledBack} created, kept ${updated.length} updated, ${errors.length} error(s)`;
      emit({ type: 'warn', step: 'summary', message: cancelSummary });
      // Created rows no longer exist — report them as rolled back, not created.
      return { created: [], updated, errors, cancelled: true, rolledBack };
    }

    const summary = `Import finished: ${created.length} created, ${updated.length} updated, ${errors.length} error(s)`;
    emit({ type: errors.length > 0 ? 'warn' : 'success', step: 'summary', message: summary });

    return { created, updated, errors, cancelled: false, rolledBack: 0 };
  }

  async deleteProduct(id: string, user: AuthUser): Promise<IProduct | null> {
    const existing = await this.repository.findById(id);
    if (!existing) throw createHttpError(404, 'Product not found');
    if (user.role !== 'admin' && existing.storeId.toString() !== user.id) {
      throw createHttpError(403, 'Forbidden: You do not have permission to delete this product');
    }

    // Try a transactional cascade first. On a standalone mongod (no replica
    // set) transactions are unsupported and Mongo throws — in that case we fall
    // back to a non-transactional sequential cascade. Either way, errors are
    // surfaced (not silently swallowed) so a half-completed delete is visible.
    let result: IProduct | null;
    try {
      result = await this.deleteProductTransactional(id, existing!, user);
    } catch (err: any) {
      if (this.isTransactionUnsupported(err)) {
        console.warn('[ProductService]: transactions unsupported (standalone mongod); falling back to sequential cascade delete.');
        result = await this.deleteProductSequential(id, user);
      } else {
        throw err;
      }
    }
    return result;
  }

  /** Returns true when the error indicates transactions aren't supported (standalone mongod). */
  private isTransactionUnsupported(err: any): boolean {
    const message: string = err?.message || '';
    const code = err?.code;
    return (
      err?.codeName === 'IllegalOperation' ||
      code === 20 ||
      code === 263 ||
      /Transaction numbers are only allowed on a replica set member or mongos/i.test(message) ||
      /transactions are not supported/i.test(message) ||
      /replica set/i.test(message) ||
      /retryable writes/i.test(message)
    );
  }

  /** Cascade delete inside a Mongoose transaction (requires a replica set). */
  private async deleteProductTransactional(id: string, product: IProduct, user: AuthUser): Promise<IProduct | null> {
    // Collect child media URLs BEFORE the cascade removes the docs, so the
    // files can be cleaned up after the commit (the transaction can't include
    // the filesystem).
    const childMedia = await this.collectChildMediaUrls(id);

    const session = await Product.startSession();
    try {
      await session.withTransaction(async () => {
        await Activity.deleteMany({ productId: id }, { session });
        await Version.deleteMany({ productId: id }, { session });
        await ProductMarketing.deleteMany({ productId: id }, { session });
        await Product.deleteOne({ _id: id }, { session });
      });
    } finally {
      await session.endSession();
    }

    // DB rows are gone and committed; now log + clean up files (best-effort,
    // outside the transaction since the filesystem can't participate in it).
    await this.afterDeleteCleanup(id, product, user);
    deleteMediaFiles(childMedia);
    return product;
  }

  /** Public cascade counts for progress reporting (activities/versions/marketing). */
  async getCascadeCounts(productId: string): Promise<{ activities: number; versions: number; marketing: number }> {
    const [activities, versions, marketing] = await Promise.all([
      Activity.countDocuments({ productId }),
      Version.countDocuments({ productId }),
      ProductMarketing.countDocuments({ productId }),
    ]);
    return { activities, versions, marketing };
  }

  /** Gathers every uploaded-media URL referenced by a product's activities and marketing doc. */
  private async collectChildMediaUrls(productId: string): Promise<string[]> {
    const urls: (string | undefined)[] = [];

    const activities = await Activity.find({ productId }, 'mediaUrl mediaUrls items').lean();
    for (const act of activities as any[]) {
      urls.push(act.mediaUrl, ...(act.mediaUrls || []));
      act.items?.forEach((item: any) => {
        urls.push(item.mediaUrl, ...(item.mediaUrls || []));
      });
    }

    const marketing = await ProductMarketing.find(
      { productId },
      'trailerVideo tutorialVideo thumbnailImage keyFeatures screenshots demos'
    ).lean();
    for (const mkt of marketing as any[]) {
      urls.push(mkt.trailerVideo, mkt.tutorialVideo, mkt.thumbnailImage);
      mkt.keyFeatures?.forEach((kf: any) => urls.push(kf.mediaUrl));
      mkt.screenshots?.forEach((ss: any) => urls.push(ss.url));
      mkt.demos?.forEach((d: any) => urls.push(d.icon));
    }

    return urls.filter(Boolean) as string[];
  }

  /**
   * Non-transactional cascade for standalone mongod. Deletes related entities
   * via their services (so media files are cleaned up) in a safe order, then
   * the product. Any failure is surfaced rather than swallowed.
   */
  private async deleteProductSequential(id: string, user: AuthUser): Promise<IProduct | null> {
    const errors: string[] = [];

    // Delete children first so a failure leaves the product (and its known
    // children) rather than orphaning children under a deleted product.
    try {
      const activities = await Activity.find({ productId: id });
      if (activities.length > 0) {
        const activityService = new ActivityService();
        await activityService.bulkDeleteActivities(activities.map(a => a._id.toString()), user);
      }
    } catch (err: any) {
      errors.push(`activities: ${err?.message || err}`);
    }

    try {
      const marketingService = new ProductMarketingService();
      await marketingService.deleteMarketingData(id, user);
    } catch (err: any) {
      errors.push(`marketing: ${err?.message || err}`);
    }

    try {
      await Version.deleteMany({ productId: id });
    } catch (err: any) {
      errors.push(`versions: ${err?.message || err}`);
    }

    if (errors.length > 0) {
      // Surface the cascade failure; the product is intentionally not deleted
      // so the operation is not left half-done silently.
      throw new Error(`Failed to delete related entities for product ${id}: ${errors.join('; ')}`);
    }

    const product = await this.repository.delete(id);
    if (product) {
      await auditLogService.logEvent('DELETE', 'PRODUCT', product._id.toString(), product.name, 'Deleted a product', { id: user.id, name: user.name });
      deleteMediaFiles([product.icon, product.banner]);
    }
    return product;
  }

  /** Audit log + product media cleanup after a transactional cascade commit. */
  private async afterDeleteCleanup(id: string, product: IProduct, user: AuthUser): Promise<void> {
    await auditLogService.logEvent('DELETE', 'PRODUCT', product._id.toString(), product.name, 'Deleted a product', { id: user.id, name: user.name });
    // Product icon/banner files.
    deleteMediaFiles([product.icon, product.banner]);
    // Best-effort cleanup of media referenced by the now-deleted marketing doc
    // is skipped here because the doc is already removed in the transaction;
    // file orphans are tolerable and never block the delete.
  }
}
