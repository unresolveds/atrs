import { User, hashPassword } from '../models/User';
import { Product } from '../models/Product';
import { Activity } from '../models/Activity';
import { Version } from '../models/Version';
import { ProductMarketing } from '../models/ProductMarketing';
import { canonicalVersion, changelogFingerprint } from '../utils/readmeChangelog';

/**
 * Idempotent startup task:
 *  1. Ensure a single root admin exists (created from ROOT_ADMIN_* env vars).
 *  2. Back-fill storeId = rootAdminId on any pre-existing ownerless records.
 *
 * Safe to run on every boot; once everything is owned, step 2 is a no-op.
 */
export async function seedAndMigrate(): Promise<void> {
  await dropLegacyProductSlugIndex();
  // Clean up any duplicate imported entries left by earlier concurrent imports,
  // THEN (re)build the unique index that prevents them recurring. Order matters:
  // the unique index can't build while duplicates still exist.
  await dedupeImportedData();

  const rootAdmin = await ensureRootAdmin();
  if (!rootAdmin) return;

  const storeId = rootAdmin._id;
  const filter = { storeId: { $exists: false } };
  const update = { $set: { storeId } };

  const [products, activities, versions, marketing] = await Promise.all([
    Product.updateMany(filter, update),
    Activity.updateMany(filter, update),
    Version.updateMany(filter, update),
    ProductMarketing.updateMany(filter, update),
  ]);

  const total =
    products.modifiedCount + activities.modifiedCount + versions.modifiedCount + marketing.modifiedCount;
  if (total > 0) {
    console.log(
      `[migrate]: Assigned root admin as owner of ${products.modifiedCount} products, ` +
        `${activities.modifiedCount} activities, ${versions.modifiedCount} versions, ` +
        `${marketing.modifiedCount} marketing records.`
    );
  }
}

/**
 * Removes duplicate rows created by earlier concurrent/overlapping imports and
 * ensures the unique indexes that prevent them from coming back:
 *   - Activities sharing the same (productId, importSourceKey): keep the oldest,
 *     delete the rest.
 *   - Versions sharing the same (productId, label): keep the oldest, repoint any
 *     activities to the survivor, delete the rest.
 * Idempotent — a no-op once the data is clean.
 */
async function dedupeImportedData(): Promise<void> {
  try {
    // --- Duplicate imported activities ---
    const actDups = await Activity.aggregate([
      { $match: { importSourceKey: { $exists: true, $ne: null } } },
      { $group: { _id: { p: '$productId', k: '$importSourceKey' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    let removedActs = 0;
    for (const g of actDups) {
      // ObjectIds sort by creation time, so [0] is the oldest — the keeper.
      const ids = (g.ids as any[]).map((x) => x.toString()).sort();
      const drop = ids.slice(1);
      if (drop.length) {
        await Activity.deleteMany({ _id: { $in: drop } });
        removedActs += drop.length;
      }
    }
    if (removedActs > 0) {
      console.log(`[migrate]: Removed ${removedActs} duplicate imported changelog entr${removedActs === 1 ? 'y' : 'ies'}.`);
    }

    // --- Duplicate versions (repoint activities before deleting) ---
    const verDups = await Version.aggregate([
      { $group: { _id: { p: '$productId', l: '$label' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    let mergedVers = 0;
    for (const g of verDups) {
      const ids = (g.ids as any[]).map((x) => x.toString()).sort();
      const keep = ids[0];
      const drop = ids.slice(1);
      if (drop.length) {
        await Activity.updateMany({ versionId: { $in: drop } }, { $set: { versionId: keep } });
        await Version.deleteMany({ _id: { $in: drop } });
        mergedVers += drop.length;
      }
    }
    if (mergedVers > 0) {
      console.log(`[migrate]: Merged ${mergedVers} duplicate version row(s).`);
    }

    await backfillChangelogFingerprints();

    // Now that duplicates are gone, ensure the schema indexes (incl. the unique
    // { productId, importSourceKey } and { productId, importFingerprint }) are built.
    await Activity.createIndexes();
  } catch (err: any) {
    console.warn('[migrate]: Duplicate cleanup / index build skipped:', err?.message || err);
  }
}

/**
 * Backfills `importFingerprint` on changelog entries imported from a
 * WordPress.org readme, and clears the duplicates that only the fingerprint can
 * see. `importSourceKey` keys off the readme *heading*, so two headings that
 * resolve to the same Version (`= 1.7.1 =` and `= 1.7.2 =` both linked to 1.7.2,
 * or `= 1.0 =` alongside the SVN tag `1.0.0`) yield two distinct keys and a
 * visibly duplicated line. The fingerprint keys off the version the entry is
 * actually linked to, so those collapse.
 *
 * Runs in three steps:
 *   1. Relink entries whose readme version canonically matches a Version row the
 *      exact-label lookup missed (`1.0` → `1.0.0`) — do this first so step 2
 *      fingerprints against the corrected version.
 *   2. Compute each entry's fingerprint; where several share one, keep the oldest
 *      and delete the rest.
 *   3. Persist the fingerprints so the unique index can be built.
 *
 * Repeats of the same line under genuinely *different* versions are left alone —
 * plugin authors legitimately ship "Update SDK." in release after release.
 * Idempotent: a no-op once every imported entry carries a fingerprint.
 */
async function backfillChangelogFingerprints(): Promise<void> {
  const acts = await Activity.find({ importSourceKey: { $exists: true, $ne: null } })
    .select('productId versionId title importSourceKey importFingerprint')
    .lean();
  if (acts.length === 0) return;

  const versions = await Version.find({}).select('productId label').lean();
  const labelById = new Map<string, string>();
  // Per product: canonical version → Version _id, for relinking near-misses.
  const canonicalIndex = new Map<string, string>();
  for (const v of versions as any[]) {
    labelById.set(v._id.toString(), v.label);
    canonicalIndex.set(`${v.productId.toString()}#${canonicalVersion(v.label)}`, v._id.toString());
  }

  // --- Step 1: relink entries the exact-label lookup missed ---
  const relinks: any[] = [];
  const versionIdOf = new Map<string, string>(); // activityId → versionId used for its fingerprint
  for (const a of acts as any[]) {
    const id = a._id.toString();
    if (a.versionId) { versionIdOf.set(id, a.versionId.toString()); continue; }
    const readmeVersion = String(a.importSourceKey).split('|')[0];
    const match = canonicalIndex.get(`${a.productId.toString()}#${canonicalVersion(readmeVersion)}`);
    if (match) {
      relinks.push({ updateOne: { filter: { _id: a._id }, update: { $set: { versionId: match } } } });
      versionIdOf.set(id, match);
    }
  }
  if (relinks.length > 0) {
    await Activity.bulkWrite(relinks);
    console.log(`[migrate]: Linked ${relinks.length} imported changelog entr${relinks.length === 1 ? 'y' : 'ies'} to a matching version.`);
  }

  // --- Step 2: group by fingerprint, keep the oldest of each group ---
  const groups = new Map<string, { id: string; fp: string }[]>();
  for (const a of acts as any[]) {
    const id = a._id.toString();
    const linkedId = versionIdOf.get(id);
    // Prefer the linked Version's label; fall back to the readme heading stored
    // in the import key so unlinked entries stay distinct per readme version.
    const label = (linkedId && labelById.get(linkedId)) || String(a.importSourceKey).split('|')[0];
    const fp = changelogFingerprint(label, a.title);
    const groupKey = `${a.productId.toString()}#${fp}`;
    const bucket = groups.get(groupKey);
    if (bucket) bucket.push({ id, fp });
    else groups.set(groupKey, [{ id, fp }]);
  }

  const drop: string[] = [];
  const writes: any[] = [];
  for (const bucket of groups.values()) {
    // ObjectIds sort by creation time, so [0] is the oldest — the keeper.
    const sorted = bucket.slice().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const [keep, ...rest] = sorted;
    for (const r of rest) drop.push(r.id);
    const current = (acts as any[]).find((a) => a._id.toString() === keep.id)?.importFingerprint;
    if (current !== keep.fp) {
      writes.push({ updateOne: { filter: { _id: keep.id }, update: { $set: { importFingerprint: keep.fp } } } });
    }
  }

  if (drop.length > 0) {
    await Activity.deleteMany({ _id: { $in: drop } });
    console.log(`[migrate]: Removed ${drop.length} duplicated changelog entr${drop.length === 1 ? 'y' : 'ies'} (same line, same version).`);
  }
  // --- Step 3: persist fingerprints ---
  if (writes.length > 0) {
    await Activity.bulkWrite(writes);
    console.log(`[migrate]: Stamped ${writes.length} changelog entr${writes.length === 1 ? 'y' : 'ies'} with a duplicate-proof fingerprint.`);
  }
}

/**
 * Older builds declared Product.slug as globally unique (index `slug_1`).
 * Slugs are now unique per owner, so drop the legacy global index if present;
 * the new compound index `{ storeId, slug }` is created automatically by Mongoose.
 */
async function dropLegacyProductSlugIndex(): Promise<void> {
  try {
    const indexes = await Product.collection.indexes();
    const legacy = indexes.find((idx) => idx.name === 'slug_1');
    if (legacy) {
      await Product.collection.dropIndex('slug_1');
      console.log('[migrate]: Dropped legacy global Product.slug index (now unique per owner).');
    }
  } catch (err: any) {
    // Collection may not exist yet on a fresh DB — nothing to drop.
    console.warn('[migrate]: Could not check/drop legacy slug index:', err?.message || err);
  }
}

async function ensureRootAdmin() {
  const existing = await User.findOne({ isRoot: true });
  if (existing) return existing;

  const email = process.env.ROOT_ADMIN_EMAIL;
  const password = process.env.ROOT_ADMIN_PASSWORD;
  const name = process.env.ROOT_ADMIN_NAME || 'Root Admin';

  if (!email || !password) {
    console.warn(
      '[migrate]: No root admin found and ROOT_ADMIN_EMAIL / ROOT_ADMIN_PASSWORD are not set. ' +
        'Skipping root admin creation and ownership back-fill.'
    );
    return null;
  }

  const passwordHash = await hashPassword(password);
  const rootAdmin = await User.create({
    name,
    email: email.toLowerCase().trim(),
    passwordHash,
    role: 'admin',
    status: 'active',
    isRoot: true,
  });
  console.log(`[migrate]: Created root admin account (${rootAdmin.email}).`);
  return rootAdmin;
}
