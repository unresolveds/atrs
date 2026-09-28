import mongoose, { Schema, Document } from 'mongoose';

export interface IIntelligenceConfig extends Document {
  storeId: mongoose.Types.ObjectId;
  autoAnalysis: boolean;
  analysisFrequency: 'daily' | 'weekly' | 'monthly';
  analysisHour: number;
  weights: {
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
  enabledModules: Array<'health' | 'insights' | 'recommendations' | 'competitors' | 'portfolio'>;
  enabledMetricCategories: Array<'product_health' | 'engineering' | 'ai_eval'>;
  notifications: {
    anomalies: boolean;
    weeklyDigest: boolean;
    recommendations: boolean;
    competitorAlerts: boolean;
  };
  maxInsightsPerRun: number;
  maxRecommendationsPerRun: number;
  createdAt: Date;
  updatedAt: Date;
}

const IntelligenceConfigSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, unique: true },
    autoAnalysis: { type: Boolean, default: false },
    analysisFrequency: { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'weekly' },
    analysisHour: { type: Number, default: 3 }, // 3 AM
    weights: {
      bugHealth: { type: Number, default: 25 },
      releaseHealth: { type: Number, default: 15 },
      featureVelocity: { type: Number, default: 15 },
      issueResolution: { type: Number, default: 15 },
      productActivity: { type: Number, default: 15 },
      changelogQuality: { type: Number, default: 15 },
      codeChurn: { type: Number, default: 0 },
      commitFrequency: { type: Number, default: 0 },
      prActivity: { type: Number, default: 0 },
      devVelocity: { type: Number, default: 0 },
      techDebtTrend: { type: Number, default: 0 },
    },
    enabledModules: { 
      type: [String], 
      default: ['health', 'insights', 'recommendations'] 
    },
    enabledMetricCategories: {
      type: [String],
      default: ['product_health']
    },
    notifications: {
      anomalies: { type: Boolean, default: true },
      weeklyDigest: { type: Boolean, default: false },
      recommendations: { type: Boolean, default: true },
      competitorAlerts: { type: Boolean, default: false },
    },
    maxInsightsPerRun: { type: Number, default: 10 },
    maxRecommendationsPerRun: { type: Number, default: 5 },
  },
  { timestamps: true }
);

export const IntelligenceConfig = mongoose.model<IIntelligenceConfig>('IntelligenceConfig', IntelligenceConfigSchema);
