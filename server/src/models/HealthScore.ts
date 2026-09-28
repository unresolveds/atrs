import mongoose, { Schema, Document } from 'mongoose';

export interface IHealthScore extends Document {
  productId: mongoose.Types.ObjectId;
  /**
   * Owner of the product this score belongs to.
   *
   * Added because the portfolio endpoint aggregated `HealthScore` documents with
   * `$match: { storeId }` against a schema that had no such field — so the match
   * never hit and the portfolio widget silently reported zeros for every user.
   */
  storeId: mongoose.Types.ObjectId;
  overallScore: number;
  breakdown: {
    bugHealth: number;
    releaseHealth: number;
    featureVelocity: number;
    issueResolution: number;
    productActivity: number;
    changelogQuality: number;
    // Engineering metrics
    codeChurn?: number;
    commitFrequency?: number;
    prActivity?: number;
    devVelocity?: number;
    techDebtTrend?: number;
  };
  metrics: Record<string, unknown>; // Store raw metrics used to calculate the score
  trend: 'improving' | 'stable' | 'declining';
  trendDelta: number;
  period: 'daily' | 'weekly' | 'monthly';
  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const HealthScoreSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    overallScore: { type: Number, required: true, min: 0, max: 100 },
    breakdown: {
      bugHealth: { type: Number, required: true },
      releaseHealth: { type: Number, required: true },
      featureVelocity: { type: Number, required: true },
      issueResolution: { type: Number, required: true },
      productActivity: { type: Number, required: true },
      changelogQuality: { type: Number, required: true },
      codeChurn: { type: Number },
      commitFrequency: { type: Number },
      prActivity: { type: Number },
      devVelocity: { type: Number },
      techDebtTrend: { type: Number },
    },
    metrics: { type: Schema.Types.Mixed, default: {} },
    trend: { type: String, enum: ['improving', 'stable', 'declining'], required: true },
    trendDelta: { type: Number, required: true, default: 0 },
    period: { type: String, enum: ['daily', 'weekly', 'monthly'], required: true },
    computedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true }
);

// Compound index for getting latest scores quickly
HealthScoreSchema.index({ productId: 1, period: 1, computedAt: -1 });

export const HealthScore = mongoose.model<IHealthScore>('HealthScore', HealthScoreSchema);
