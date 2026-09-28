import mongoose, { Schema, Document } from 'mongoose';

/**
 * A point-in-time capture of one product's public market position.
 *
 * The intelligence layer previously had no memory of the outside world: it could
 * see today's install count but not whether that count was climbing or bleeding.
 * Trend claims need at least two observations, so every analysis run appends a
 * snapshot here and detectors diff across the series.
 *
 * `subjectType` distinguishes our own products from tracked competitors, which
 * lets a single collection back both the health trend and the head-to-head
 * comparison without a second time series to keep consistent.
 */
export type MarketSubjectType = 'product' | 'competitor';

export interface IMarketSnapshot extends Document {
  subjectType: MarketSubjectType;
  /** Set when subjectType is 'product'. */
  productId?: mongoose.Types.ObjectId;
  /** Set when subjectType is 'competitor'. */
  competitorId?: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  wpOrgSlug: string;

  activeInstalls: number | null;
  downloaded: number | null;
  /** WP.org's 0–100 rating field, kept in its native scale. */
  rating: number | null;
  numRatings: number;
  ratingHistogram?: { 1: number; 2: number; 3: number; 4: number; 5: number } | null;
  /** Mean 1–5 stars recomputed from the histogram. */
  meanStars: number | null;
  supportThreads: number | null;
  supportThreadsResolved: number | null;

  version: string | null;
  lastUpdated: Date | null;
  testedUpTo: string | null;
  requiresPhp: string | null;
  /** Minor WP releases between "Tested up to" and the current WP release. */
  wpVersionLag: number | null;

  /** Directory rank from wp-rankings.com, when reachable. */
  ranking: number | null;
  memoryUsage: string | null;
  speedSeconds: number | null;
  vulnerabilitiesPresent: number | null;
  vulnerabilitiesPatched: number | null;

  capturedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MarketSnapshotSchema = new Schema(
  {
    subjectType: { type: String, enum: ['product', 'competitor'], required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', index: true },
    competitorId: { type: Schema.Types.ObjectId, ref: 'Competitor', index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    wpOrgSlug: { type: String, required: true, index: true },

    activeInstalls: { type: Number, default: null },
    downloaded: { type: Number, default: null },
    rating: { type: Number, default: null },
    numRatings: { type: Number, default: 0 },
    ratingHistogram: { type: Schema.Types.Mixed, default: null },
    meanStars: { type: Number, default: null },
    supportThreads: { type: Number, default: null },
    supportThreadsResolved: { type: Number, default: null },

    version: { type: String, default: null },
    lastUpdated: { type: Date, default: null },
    testedUpTo: { type: String, default: null },
    requiresPhp: { type: String, default: null },
    wpVersionLag: { type: Number, default: null },

    ranking: { type: Number, default: null },
    memoryUsage: { type: String, default: null },
    speedSeconds: { type: Number, default: null },
    vulnerabilitiesPresent: { type: Number, default: null },
    vulnerabilitiesPatched: { type: Number, default: null },

    capturedAt: { type: Date, required: true, default: Date.now, index: true },
  },
  { timestamps: true },
);

// The dominant read is "latest N snapshots for this subject", for both trend
// detection and the competitor matrix.
MarketSnapshotSchema.index({ productId: 1, capturedAt: -1 });
MarketSnapshotSchema.index({ competitorId: 1, capturedAt: -1 });
MarketSnapshotSchema.index({ wpOrgSlug: 1, capturedAt: -1 });

export const MarketSnapshot = mongoose.model<IMarketSnapshot>('MarketSnapshot', MarketSnapshotSchema);
