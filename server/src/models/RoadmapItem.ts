import mongoose, { Schema, Document } from 'mongoose';
import type { Evidence } from '../services/intelligence/signals/types';

/**
 * One prioritised item on a product's roadmap.
 *
 * The platform previously had no roadmap at all — `RecommendationService` emitted
 * a single free-text suggestion per run with an LLM-invented "impact score" and
 * no way to compare two of them. This model exists so roadmap items are
 * *comparable*: every item carries a RICE score built from real inputs, a record
 * of how each RICE factor was derived, and the evidence that put it on the list.
 *
 * `expectedOutcome` is what closes the learning loop. An item that predicts
 * "support resolution rate rises above 60%" can be checked against reality after
 * it ships, which is what feeds `ConfidenceScorer`'s historical-accuracy term.
 */

export type RoadmapHorizon = 'now' | 'next' | 'later' | 'watch';

export type RoadmapCategory =
  | 'security'
  | 'stability'
  | 'feature'
  | 'growth'
  | 'reputation'
  | 'discoverability'
  | 'compliance'
  | 'support'
  | 'tech_debt'
  | 'process';

export type RoadmapStatus =
  | 'proposed'
  | 'accepted'
  | 'in_progress'
  | 'shipped'
  | 'dismissed'
  | 'deferred';

/**
 * RICE factors, each recorded with the reasoning that produced it.
 *
 * Storing the basis strings alongside the numbers is the difference between a
 * score a user can argue with and one they have to take on faith.
 */
export interface RiceScore {
  /** Users affected per quarter, derived from real install counts where available. */
  reach: number;
  /** Standard RICE impact multiplier: 0.25, 0.5, 1, 2 or 3. */
  impact: number;
  /** 0..1, taken from the data quality of the supporting signals. */
  confidence: number;
  /** Person-weeks. */
  effort: number;
  /** (reach × impact × confidence) / effort. */
  score: number;

  reachBasis: string;
  impactBasis: string;
  confidenceBasis: string;
  effortBasis: string;
}

/** A checkable prediction about what shipping this item should change. */
export interface ExpectedOutcome {
  /** Metric name matching a signal metric where possible, e.g. 'supportResolutionRate'. */
  metric: string;
  direction: 'increase' | 'decrease' | 'resolve';
  /** Target value, when the prediction is quantitative. */
  targetValue?: number;
  unit?: string;
  /** Plain-language statement of the prediction. */
  statement: string;
  /** Days after shipping at which the outcome should be measurable. */
  measureAfterDays: number;
}

export interface IRoadmapItem extends Document {
  productId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;

  title: string;
  description: string;
  /** Why this is on the roadmap, in terms of the evidence. */
  rationale: string;

  horizon: RoadmapHorizon;
  category: RoadmapCategory;
  rice: RiceScore;
  /** Position within the horizon, ascending. */
  rank: number;

  actionItems: string[];
  /** Testable conditions for "done". */
  acceptanceCriteria: string[];
  expectedOutcome?: ExpectedOutcome;

  /** Signal codes that generated this item — the citation allow-list. */
  sourceSignalCodes: string[];
  sourceSignalIds: mongoose.Types.ObjectId[];
  /** Issues this item would close. */
  sourceIssueIds: mongoose.Types.ObjectId[];
  /** Competitors whose capabilities motivated it. */
  sourceCompetitorIds: mongoose.Types.ObjectId[];
  evidence: Evidence[];
  /** True when the prose was templated rather than model-written. */
  deterministic: boolean;

  status: RoadmapStatus;
  statusHistory: Array<{
    status: RoadmapStatus;
    changedAt: Date;
    changedBy?: mongoose.Types.ObjectId;
    note?: string;
  }>;

  /** Version the item is slated for, once planned. */
  targetVersionLabel?: string;
  shippedVersionLabel?: string;
  shippedAt?: Date;

  /** Filled in when the expected outcome is checked after shipping. */
  outcomeMeasuredAt?: Date;
  outcomeAchieved?: boolean;
  outcomeNote?: string;

  userFeedback?: 'helpful' | 'not_helpful';
  userNote?: string;

  /** Stable identity so regeneration updates rather than duplicates. */
  fingerprint: string;
  generatedAt: Date;
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

const RoadmapItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },

    title: { type: String, required: true },
    description: { type: String, required: true },
    rationale: { type: String, required: true },

    horizon: { type: String, enum: ['now', 'next', 'later', 'watch'], required: true, index: true },
    category: {
      type: String,
      enum: [
        'security',
        'stability',
        'feature',
        'growth',
        'reputation',
        'discoverability',
        'compliance',
        'support',
        'tech_debt',
        'process',
      ],
      required: true,
    },
    rice: { type: Schema.Types.Mixed, required: true },
    rank: { type: Number, required: true, default: 0 },

    actionItems: { type: [String], default: [] },
    acceptanceCriteria: { type: [String], default: [] },
    expectedOutcome: { type: Schema.Types.Mixed },

    sourceSignalCodes: { type: [String], default: [] },
    sourceSignalIds: [{ type: Schema.Types.ObjectId, ref: 'Signal' }],
    sourceIssueIds: [{ type: Schema.Types.ObjectId, ref: 'Issue' }],
    sourceCompetitorIds: [{ type: Schema.Types.ObjectId, ref: 'Competitor' }],
    evidence: { type: [EvidenceSchema], default: [] },
    deterministic: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ['proposed', 'accepted', 'in_progress', 'shipped', 'dismissed', 'deferred'],
      required: true,
      default: 'proposed',
      index: true,
    },
    statusHistory: [
      {
        status: { type: String, required: true },
        changedAt: { type: Date, required: true, default: Date.now },
        changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        note: String,
      },
    ],

    targetVersionLabel: { type: String },
    shippedVersionLabel: { type: String },
    shippedAt: { type: Date },

    outcomeMeasuredAt: { type: Date },
    outcomeAchieved: { type: Boolean },
    outcomeNote: { type: String },

    userFeedback: { type: String, enum: ['helpful', 'not_helpful'] },
    userNote: { type: String },

    fingerprint: { type: String, required: true },
    generatedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

// One item per concern per product; the upsert key for regeneration.
RoadmapItemSchema.index({ productId: 1, fingerprint: 1 }, { unique: true });
RoadmapItemSchema.index({ productId: 1, horizon: 1, rank: 1 });
RoadmapItemSchema.index({ storeId: 1, status: 1 });

export const RoadmapItem = mongoose.model<IRoadmapItem>('RoadmapItem', RoadmapItemSchema);
