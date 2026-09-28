import mongoose, { Schema, Document } from 'mongoose';

/**
 * A store is the tenancy boundary: every product, activity, issue, signal and
 * report belongs to exactly one, and nothing is visible across the line except
 * to a platform admin.
 *
 * It is also the unit a person works in. A user who signs up alone still gets a
 * store — there is no separate "personal mode", because a second mode would mean
 * branching every scoped query in the codebase. Working solo is simply a store
 * with one member, and inviting someone changes nothing about how data is read.
 *
 * Settings that used to live in the global `app.config.json` sit here instead,
 * so two stores can run different branding, different Ollama models and
 * different thresholds. What stays global is deployment-level only — the port,
 * the database URI and the media backend.
 */

export type StoreRole = 'owner' | 'manager' | 'developer';

/** Ordered by authority; used by `roleAtLeast`. */
export const STORE_ROLES: StoreRole[] = ['developer', 'manager', 'owner'];

export interface IStoreBranding {
  companyName: string;
  logoUrl: string;
  accentColor: string;
  accentDynamic: boolean;
  thankYouEnabled: boolean;
  thankYouTitle: string;
  thankYouMessage: string;
}

export interface IStoreIntelligence {
  /** Ollama model used for changelog generation and narrative prose. */
  model: string;
  ollamaMode: 'local' | 'cloud';
  ollamaCloudUrl: string;
  /** Sealed at rest; never selected by default. */
  ollamaCloudKey?: string;
  /** Days without a changelog update before a product is flagged stale. */
  staleAlertDays: number;
}

export interface IStore extends Document {
  name: string;
  slug: string;
  /** The user who created it. Always also a member with role 'owner'. */
  ownerId: mongoose.Types.ObjectId;
  description?: string;
  logoUrl?: string;
  branding: IStoreBranding;
  intelligence: IStoreIntelligence;
  createdAt: Date;
  updatedAt: Date;
}

const StoreSchema: Schema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    description: { type: String, default: '' },
    logoUrl: { type: String, default: '' },
    branding: {
      companyName: { type: String, default: '' },
      logoUrl: { type: String, default: '' },
      accentColor: { type: String, default: '' },
      accentDynamic: { type: Boolean, default: false },
      thankYouEnabled: { type: Boolean, default: true },
      thankYouTitle: { type: String, default: '' },
      thankYouMessage: { type: String, default: '' },
    },
    intelligence: {
      model: { type: String, default: 'qwen2.5-coder' },
      ollamaMode: { type: String, enum: ['local', 'cloud'], default: 'local' },
      ollamaCloudUrl: { type: String, default: '' },
      // Write-only: sealed via utils/crypto and never returned by the API.
      ollamaCloudKey: { type: String, select: false },
      staleAlertDays: { type: Number, default: 7, min: 1, max: 365 },
    },
  },
  { timestamps: true },
);

export const Store = mongoose.model<IStore>('Store', StoreSchema);

/** True when `role` carries at least the authority of `required`. */
export function roleAtLeast(role: StoreRole | undefined, required: StoreRole): boolean {
  if (!role) return false;
  return STORE_ROLES.indexOf(role) >= STORE_ROLES.indexOf(required);
}
