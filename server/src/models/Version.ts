import mongoose, { Schema, Document } from 'mongoose';

export interface IVersion extends Document {
  storeId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  label: string;
  notes?: string;
  status: 'released' | 'unreleased';
  releasedAt?: Date;
  author?: string;
  /** Where this version came from. 'github' rows are managed by the release sync. */
  source?: 'manual' | 'github';
  /** Stable id of the upstream object (the GitHub release/tag id) for idempotent sync. */
  externalId?: string;
  /** Link back to the upstream release page. */
  externalUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const VersionSchema: Schema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    label: { type: String, required: true },
    notes: { type: String, default: '' },
    status: { type: String, enum: ['released', 'unreleased'], default: 'released' },
    releasedAt: { type: Date, required: false },
    author: { type: String, default: '' },
    source: { type: String, enum: ['manual', 'github'], default: 'manual' },
    externalId: { type: String, default: '' },
    externalUrl: { type: String, default: '' },
  },
  { timestamps: true }
);

// Index for productId lookups.
VersionSchema.index({ productId: 1 });
// Idempotent GitHub sync: one row per (product, upstream release). Sparse so the
// many manual versions (no externalId) are exempt from the uniqueness constraint.
VersionSchema.index(
  { productId: 1, source: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: 'string', $gt: '' } } }
);

export const Version = mongoose.model<IVersion>('Version', VersionSchema);
