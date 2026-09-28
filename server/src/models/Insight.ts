import mongoose, { Schema, Document } from 'mongoose';
import type { Evidence } from '../services/intelligence/signals/types';

export type InsightType =
  | 'health_summary'
  | 'bug_trend'
  | 'release_insight'
  | 'feature_recommendation'
  | 'anomaly'
  | 'competitive'
  | 'general'
  // Added with the grounded pipeline: each maps to a signal category so an
  // insight can be filtered to the concern it addresses.
  | 'stability'
  | 'velocity'
  | 'traction'
  | 'reputation'
  | 'support'
  | 'discoverability'
  | 'compliance'
  | 'coverage';

export type InsightSeverity = 'info' | 'warning' | 'critical' | 'opportunity';
export type InsightStatus = 'new' | 'viewed' | 'acknowledged' | 'dismissed' | 'actioned';

export interface IInsight extends Document {
  productId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  type: InsightType;
  severity: InsightSeverity;
  title: string;
  narrative: string;
  confidence: number;

  /**
   * How the confidence number was reached. Stored so a user can challenge a
   * score instead of being asked to trust it.
   */
  confidenceBreakdown?: {
    dataDensity: number;
    historicalAccuracy: number;
    groundedness: number;
    explanation: string;
  };

  /** Signal codes this insight was built from — also the citation allow-list. */
  signalCodes: string[];
  /** Signal documents backing it, for click-through. */
  signalIds: mongoose.Types.ObjectId[];
  /** Verifiable facts copied from the signals, so the trail survives signal resolution. */
  evidence: Evidence[];
  /**
   * True when the narrative was templated deterministically because no language
   * model was reachable. Surfaced in the UI so users know which they're reading.
   */
  deterministic: boolean;

  /**
   * Stable identity across runs, derived from the contributing signal codes.
   * Lets a recurring concern update in place rather than duplicating every run,
   * which is what made the old feed unusable after a handful of analyses.
   */
  fingerprint: string;

  status: InsightStatus;
  userFeedback?: 'helpful' | 'not_helpful';
  userNote?: string;
  generatedAt: Date;
  expiresAt?: Date; // For TTL index
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

const InsightSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    type: {
      type: String,
      enum: [
        'health_summary',
        'bug_trend',
        'release_insight',
        'feature_recommendation',
        'anomaly',
        'competitive',
        'general',
        'stability',
        'velocity',
        'traction',
        'reputation',
        'support',
        'discoverability',
        'compliance',
        'coverage',
      ],
      required: true,
    },
    severity: { type: String, enum: ['info', 'warning', 'critical', 'opportunity'], required: true },
    title: { type: String, required: true },
    narrative: { type: String, required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    confidenceBreakdown: { type: Schema.Types.Mixed },

    signalCodes: { type: [String], default: [] },
    signalIds: [{ type: Schema.Types.ObjectId, ref: 'Signal' }],
    evidence: { type: [EvidenceSchema], default: [] },
    deterministic: { type: Boolean, default: false },
    // Not `required` at the schema level: documents created before the grounded
    // pipeline have no fingerprint, and marking it required would make those
    // legacy rows unsaveable on any later status update.
    fingerprint: { type: String, index: true },

    status: {
      type: String,
      enum: ['new', 'viewed', 'acknowledged', 'dismissed', 'actioned'],
      default: 'new',
    },
    userFeedback: { type: String, enum: ['helpful', 'not_helpful'] },
    userNote: { type: String },
    generatedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

// Indexes
InsightSchema.index({ storeId: 1, status: 1 });
// One live insight per concern per product — the upsert key for regeneration.
// Sparse so the pre-existing rows without a fingerprint don't collide on null.
InsightSchema.index({ productId: 1, fingerprint: 1 }, { unique: true, sparse: true });
InsightSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Insight = mongoose.model<IInsight>('Insight', InsightSchema);
