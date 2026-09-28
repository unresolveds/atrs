import mongoose, { Schema, Document } from 'mongoose';

export type RecommendationCategory = 
  | 'feature'
  | 'bugfix'
  | 'stability'
  | 'performance'
  | 'tech_debt'
  | 'release_planning'
  | 'sprint_planning'
  | 'resource'
  | 'strategic';

export type RecommendationStatus = 
  | 'generated'
  | 'reviewed'
  | 'accepted'
  | 'dismissed'
  | 'deferred'
  | 'triaged'
  | 'in_progress'
  | 'implemented'
  | 'measured'
  | 'expired';

export type RecommendationSource =
  | 'health_analysis'
  | 'insight'
  | 'anomaly'
  | 'feature_requests'
  | 'competitive'
  | 'sprint_planner'
  | 'release_planner'
  | 'portfolio';

export interface IRecommendation extends Document {
  productId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  
  title: string;
  description: string;
  rationale: string;
  actionItems: string[];
  
  category: RecommendationCategory;
  priority: 'critical' | 'high' | 'medium' | 'low';
  
  confidence: number;
  impactScore: number;
  estimatedEffort: 'xs' | 's' | 'm' | 'l' | 'xl';
  estimatedROI: 'high' | 'medium' | 'low';
  estimatedHealthDelta: number;
  estimatedConfidenceDelta?: number;
  
  source: RecommendationSource;
  /**
   * The roadmap item this recommendation mirrors.
   *
   * A dedicated top-level field rather than a key inside `sourceMetrics`: the
   * regeneration upsert filters on it while also `$set`-ing `sourceMetrics` wholesale,
   * and filtering on a dotted path whose parent the same update replaces is an
   * ambiguity MongoDB can reject outright.
   */
  sourceRoadmapItemId?: mongoose.Types.ObjectId;
  sourceInsightId?: mongoose.Types.ObjectId;
  sourceFeatureRequestIds?: mongoose.Types.ObjectId[];
  sourceIssueIds?: mongoose.Types.ObjectId[];
  sourceMetrics: Record<string, unknown>;
  
  status: RecommendationStatus;
  statusHistory: Array<{
    status: RecommendationStatus;
    changedAt: Date;
    changedBy?: mongoose.Types.ObjectId;
    note?: string;
  }>;
  
  acceptedBy?: mongoose.Types.ObjectId;
  acceptedAt?: Date;
  dismissReason?: string;
  deferUntil?: Date;
  
  linkedFeatureRequestId?: mongoose.Types.ObjectId;
  implementedVersion?: string;
  outcomeNote?: string;
  outcomeMeasured?: boolean;
  
  userFeedback?: 'helpful' | 'not_helpful';
  userNote?: string;
  
  generatedAt: Date;
  reviewedAt?: Date;
  expiresAt: Date; // TTL
  
  createdAt: Date;
  updatedAt: Date;
}

const RecommendationSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    
    title: { type: String, required: true },
    description: { type: String, required: true },
    rationale: { type: String, required: true },
    actionItems: [{ type: String }],
    
    category: { type: String, required: true },
    priority: { type: String, enum: ['critical', 'high', 'medium', 'low'], required: true },
    
    confidence: { type: Number, required: true, min: 0, max: 1 },
    impactScore: { type: Number, required: true, min: 0, max: 100 },
    estimatedEffort: { type: String, enum: ['xs', 's', 'm', 'l', 'xl'], required: true },
    estimatedROI: { type: String, enum: ['high', 'medium', 'low'], required: true },
    estimatedHealthDelta: { type: Number, required: true },
    estimatedConfidenceDelta: { type: Number },
    
    source: { type: String, required: true },
    sourceRoadmapItemId: { type: Schema.Types.ObjectId, ref: 'RoadmapItem', index: true },
    sourceInsightId: { type: Schema.Types.ObjectId, ref: 'Insight' },
    sourceFeatureRequestIds: [{ type: Schema.Types.ObjectId, ref: 'FeatureRequest' }],
    sourceIssueIds: [{ type: Schema.Types.ObjectId, ref: 'Issue' }],
    sourceMetrics: { type: Schema.Types.Mixed, default: {} },
    
    status: { type: String, required: true, default: 'generated' },
    statusHistory: [
      {
        status: { type: String, required: true },
        changedAt: { type: Date, required: true, default: Date.now },
        changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        note: String
      }
    ],
    
    acceptedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    acceptedAt: { type: Date },
    dismissReason: { type: String },
    deferUntil: { type: Date },
    
    linkedFeatureRequestId: { type: Schema.Types.ObjectId, ref: 'FeatureRequest' },
    implementedVersion: { type: String },
    outcomeNote: { type: String },
    outcomeMeasured: { type: Boolean, default: false },
    
    userFeedback: { type: String, enum: ['helpful', 'not_helpful'] },
    userNote: { type: String },
    
    generatedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

RecommendationSchema.index({ storeId: 1, status: 1, priority: 1 });
RecommendationSchema.index({ storeId: 1, category: 1 });
RecommendationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Recommendation = mongoose.model<IRecommendation>('Recommendation', RecommendationSchema);
