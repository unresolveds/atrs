import mongoose, { Schema, Document } from 'mongoose';
import type {
  SignalCategory,
  SignalCode,
  SignalDirection,
  SignalSeverity,
  Evidence,
  SignalMetric,
} from '../services/intelligence/signals/types';

/**
 * A persisted Signal — the audit trail for every AI claim.
 *
 * Signals are upserted on their `fingerprint` rather than inserted, so a
 * condition that persists across runs keeps one row with a growing observation
 * history instead of flooding the collection. `resolvedAt` is stamped when a
 * later run no longer detects the condition, which is what lets us tell the user
 * "this cleared 3 days ago" and lets the confidence model learn whether acting
 * on it helped.
 */
export interface ISignal extends Document {
  productId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  competitorId?: mongoose.Types.ObjectId;

  code: SignalCode;
  category: SignalCategory;
  direction: SignalDirection;
  severity: SignalSeverity;
  title: string;
  detail: string;
  metric?: SignalMetric;
  evidence: Evidence[];
  dataQuality: number;

  fingerprint: string;
  /** True while the condition is still being detected. */
  active: boolean;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  resolvedAt?: Date;
  /**
   * How many runs have observed this condition — feeds trend persistence and the
   * confidence model's data-density term. Maintained solely by `$inc`; see the schema
   * definition for why it carries no default.
   */
  observationCount: number;

  createdAt: Date;
  updatedAt: Date;
}

const EvidenceSchema = new Schema(
  {
    label: { type: String, required: true },
    value: { type: String, required: true },
    source: { type: String, required: true },
    ref: { type: String },
  },
  { _id: false },
);

const SignalSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    competitorId: { type: Schema.Types.ObjectId, ref: 'Competitor' },

    code: { type: String, required: true, index: true },
    category: { type: String, required: true },
    direction: { type: String, enum: ['positive', 'negative', 'neutral'], required: true },
    severity: { type: String, enum: ['info', 'low', 'medium', 'high', 'critical'], required: true },
    title: { type: String, required: true },
    detail: { type: String, required: true },
    metric: { type: Schema.Types.Mixed },
    evidence: { type: [EvidenceSchema], default: [] },
    dataQuality: { type: Number, required: true, min: 0, max: 1, default: 0.5 },

    fingerprint: { type: String, required: true },
    active: { type: Boolean, required: true, default: true, index: true },
    firstDetectedAt: { type: Date, required: true, default: Date.now },
    lastDetectedAt: { type: Date, required: true, default: Date.now },
    resolvedAt: { type: Date },
    /**
     * Incremented by the reconcile upsert, never defaulted.
     *
     * A schema `default` here would be a runtime bug: Mongoose applies defaults on
     * upsert via `$setOnInsert`, and MongoDB rejects an update that touches the same
     * path with both `$setOnInsert` and `$inc` ("would create a conflict"). Leaving
     * `$inc` as the sole writer means a first insert lands at 1 and each later
     * detection adds one.
     */
    observationCount: { type: Number },
  },
  { timestamps: true },
);

// Fingerprint is the upsert key — one row per (product, code, discriminator).
SignalSchema.index({ fingerprint: 1 }, { unique: true });
SignalSchema.index({ productId: 1, active: 1, severity: 1 });

export const Signal = mongoose.model<ISignal>('Signal', SignalSchema);
