/**
 * Moves an existing database onto the store tenancy model.
 *
 * Before the refactor every document carried `ownerId`, the id of the user who
 * created it. Documents now belong to a store. This creates one store, puts
 * every existing user in it, re-points every scoped collection at it, and drops
 * the stale `ownerId`.
 *
 * Safe to run more than once: each step skips what is already correct, so a
 * partial run can simply be repeated.
 *
 *   npx tsx scripts/bootstrapStores.ts                 # report only
 *   npx tsx scripts/bootstrapStores.ts --apply         # make the changes
 *   npx tsx scripts/bootstrapStores.ts --apply --name "bPlugins"
 */
import fs from 'fs';
import path from 'path';

// Load .env before anything reads a secret from process.env.
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
  }
}

import mongoose from 'mongoose';
import { Store } from '../src/models/Store';
import { User } from '../src/models/User';
import { baseSlug } from '../src/utils/slug';

/** Every collection whose documents belong to a store. */
const SCOPED_COLLECTIONS = [
  'products', 'activities', 'versions', 'issues', 'productmarketings',
  'uninstallfeedbacks', 'competitors', 'signals', 'insights', 'recommendations',
  'roadmapitems', 'healthscores', 'marketsnapshots', 'intelligenceconfigs', 'dailylogs',
];

const apply = process.argv.includes('--apply');
const nameArg = process.argv.indexOf('--name');
const storeName = nameArg > -1 ? process.argv[nameArg + 1] : 'Default Store';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log(apply ? 'APPLYING CHANGES\n' : 'DRY RUN — nothing will be written. Re-run with --apply.\n');

  // 1. The store. Reuse one if bootstrap already ran.
  let store = await Store.findOne().sort({ createdAt: 1, _id: 1 });
  const owner =
    (await User.findOne({ isRoot: true })) ??
    (await User.findOne({ role: 'admin' })) ??
    (await User.findOne().sort({ createdAt: 1, _id: 1 }));
  if (!owner) throw new Error('No users exist — nothing to bootstrap.');

  if (store) {
    console.log(`store: reusing "${store.name}" (${store._id})`);
  } else if (apply) {
    store = await Store.create({
      name: storeName,
      slug: baseSlug(storeName),
      ownerId: owner._id,
      description: 'Created by the store bootstrap.',
    });
    console.log(`store: created "${store.name}" (${store._id}), owned by ${owner.name}`);
  } else {
    console.log(`store: would create "${storeName}" owned by ${owner.name}`);
  }
  const storeId = store?._id;

  // 2. Members. The chosen owner leads; everyone else starts as a developer,
  //    the least authority — promoting is easy, un-leaking is not.
  const withoutStore = await User.countDocuments({ $or: [{ storeId: null }, { storeId: { $exists: false } }] });
  console.log(`\nusers without a store: ${withoutStore}`);
  if (apply && storeId) {
    await User.updateOne({ _id: owner._id }, { $set: { storeId, storeRole: 'owner' } });
    const res = await User.updateMany(
      { _id: { $ne: owner._id }, $or: [{ storeId: null }, { storeId: { $exists: false } }] },
      { $set: { storeId, storeRole: 'developer' } },
    );
    console.log(`  ${owner.name} -> owner, ${res.modifiedCount} other user(s) -> developer`);
  }

  // 3. Documents. `ownerId` held a user id and is meaningless now; every
  //    document in this deployment belongs to the single store.
  console.log('\ncollections:');
  let totalRepointed = 0;
  for (const name of SCOPED_COLLECTIONS) {
    const exists = await db.listCollections({ name }).hasNext();
    if (!exists) continue;
    const col = db.collection(name);
    const total = await col.countDocuments();
    if (total === 0) continue;

    const needsStore = await col.countDocuments(
      storeId ? { $or: [{ storeId: { $exists: false } }, { storeId: { $ne: storeId } }] } : {},
    );
    const staleOwner = await col.countDocuments({ ownerId: { $exists: true } });
    console.log(`  ${name.padEnd(22)} ${String(total).padStart(6)}  to re-point: ${String(needsStore).padStart(6)}  stale ownerId: ${staleOwner}`);

    if (apply && storeId) {
      // Indexes built on ownerId have to go first. A unique (ownerId, slug)
      // index turns into a unique (null, slug) index the moment ownerId is
      // unset, and every document then collides on the second write.
      for (const index of await col.indexes()) {
        const keys = Object.keys((index.key ?? {}) as Record<string, unknown>);
        if (keys.includes('ownerId') && index.name) {
          await col.dropIndex(index.name);
          console.log(`    dropped stale index ${index.name}`);
        }
      }
      if (needsStore > 0) {
        const r = await col.updateMany({}, { $set: { storeId } });
        totalRepointed += r.modifiedCount;
      }
      if (staleOwner > 0) await col.updateMany({ ownerId: { $exists: true } }, { $unset: { ownerId: '' } });
    }
  }

  if (apply) console.log(`\nre-pointed ${totalRepointed} document(s) to ${storeId}`);
  else console.log('\nnothing written. Re-run with --apply to perform the migration.');

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('bootstrap failed:', e.message);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
