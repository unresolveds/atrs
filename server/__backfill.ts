/** Historical backfill runner. Prints progress unbuffered so a stall is visible. */
import mongoose from 'mongoose';
import fs from 'fs';
import { Product } from './src/models/Product';
import { UninstallFeedback } from './src/models/UninstallFeedback';
import { FreemiusSyncService, resolveCredentials } from './src/services/intelligence/freemius/FreemiusSyncService';

const env: Record<string, string> = {};
for (const l of fs.readFileSync('../.env', 'utf8').split(/\r?\n/)) {
  const t = l.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i < 0) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
process.env.FREEMIUS_PRODUCT_ID = env.FREEMIUS_PRODUCT_ID;
process.env.FREEMIUS_PUBLIC_KEY = env.FREEMIUS_PUBLIC_KEY;
process.env.FREEMIUS_SECRET_KEY = env.FREEMIUS_SECRET_KEY;

const log = (m: string) => { process.stdout.write(m + '\n'); };

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  log('mongo connected');

  // Select by the Freemius link, never by name: two products here share a name
  // and only one is connected, so a name match silently picked the wrong one.
  const product = await Product.findOne({ freemiusProductId: { $nin: ['', null] } })
    .select('+freemiusPublicKey +freemiusSecretKey');
  if (!product) { log('NO PRODUCT IS LINKED TO FREEMIUS'); return; }
  log(`product: ${product.name}`);
  log(`  _id=${product._id}`);
  log(`  freemiusProductId=${product.freemiusProductId || '(EMPTY)'}`);

  const creds = resolveCredentials(product);
  log(`  credentials resolve: ${creds ? 'YES (entity ' + creds.entityId + ')' : 'NO — backfill cannot run'}`);
  if (!creds) {
    log('  env FREEMIUS_PRODUCT_ID=' + (process.env.FREEMIUS_PRODUCT_ID || '(unset)'));
    log('  -> the product id must match the env one for the env keys to apply');
    return;
  }

  let offset = Number(process.env.START_OFFSET || 0);
  const rounds = Number(process.env.ROUNDS || 40);
  const started = Date.now();

  for (let round = 1; round <= rounds; round++) {
    const r = await FreemiusSyncService.backfillProduct(product, { startOffset: offset, maxRequests: 500 });
    const rows = await UninstallFeedback.countDocuments({ productId: product._id });
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    log(
      `round ${String(round).padStart(2)} | offset ${String(offset).padStart(5)} ` +
      `| examined ${String(r.examined).padStart(4)} stored ${String(r.stored).padStart(4)} ` +
      `noFeedback ${String(r.withoutFeedback).padStart(4)} req ${String(r.requests).padStart(4)} ` +
      `| ROWS ${rows} | ${mins}m`,
    );
    if (r.errors.length) log('   errors: ' + r.errors.slice(0, 2).join(' | '));
    if (r.nextOffset === undefined) { log('BACKFILL COMPLETE'); break; }
    offset = r.nextOffset;
  }

  const final = await UninstallFeedback.countDocuments({ productId: product._id });
  log(`final row count: ${final}`);
  await mongoose.disconnect();
}
main().catch(async (e) => { log('FAILED: ' + e.message); await mongoose.disconnect(); process.exit(1); });
