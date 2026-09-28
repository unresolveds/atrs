import mongoose, { Schema, Document } from 'mongoose';

/**
 * One uninstall with a stated reason, pulled from Freemius.
 *
 * Deliberately narrow: the reason, when it happened, and coarse dimensions that
 * make the reason interpretable (which version, which country). The Freemius
 * install record also carries the site URL and title — real customer sites —
 * and those are not stored here, because nothing in the analysis needs to
 * identify a site and holding them would make this collection a liability.
 * `freemiusInstallId` is kept so a specific report can be traced back to
 * Freemius by someone who has dashboard access.
 *
 * Rows are facts, not derived values: every churn figure the intelligence layer
 * reports is counted from these rows by a detector.
 */
export interface IUninstallFeedback extends Document {
  productId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  /** Freemius install id — the natural key, used to upsert idempotently. */
  freemiusInstallId: number;
  /** Freemius' own uninstall record id, when present. */
  freemiusUninstallId?: number;
  /** Numeric reason code. Real values exceed the 1–10 the public docs list. */
  reasonId: number;
  /** Human label as returned by the API. Never mapped locally — Freemius owns this vocabulary. */
  reason: string;
  /** Free text, only when the user chose "Other". User-authored, so treated as untrusted display data. */
  reasonInfo?: string;
  /** When the uninstall was recorded by Freemius. */
  uninstalledAt: Date;
  /** Product version at uninstall, when known — lets a reason be tied to a release. */
  version?: string;
  /** ISO country code, for coarse segmentation. */
  countryCode?: string;
  sdkVersion?: string;
  createdAt: Date;
  updatedAt: Date;
}

const UninstallFeedbackSchema: Schema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    freemiusInstallId: { type: Number, required: true },
    freemiusUninstallId: { type: Number },
    reasonId: { type: Number, required: true, index: true },
    reason: { type: String, required: true },
    reasonInfo: { type: String, default: '' },
    uninstalledAt: { type: Date, required: true, index: true },
    version: { type: String, default: '' },
    countryCode: { type: String, default: '' },
    sdkVersion: { type: String, default: '' },
  },
  { timestamps: true },
);

// The sync re-reads overlapping windows, so the same uninstall arrives more than
// once; the natural key makes those writes idempotent.
UninstallFeedbackSchema.index({ productId: 1, freemiusInstallId: 1 }, { unique: true });
// Detectors read "this product, this window, grouped by reason".
UninstallFeedbackSchema.index({ productId: 1, uninstalledAt: -1 });

export const UninstallFeedback = mongoose.model<IUninstallFeedback>(
  'UninstallFeedback',
  UninstallFeedbackSchema,
);
