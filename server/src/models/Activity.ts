import mongoose, { Schema, Document } from 'mongoose';
 const ACTIVITY_TYPES = [
  'feature',
  'improvement',
  'enhancement',
  'bug-fix',
  'security',
  'performance',
  'refactor',
  'ui',
  'accessibility',
  'localization',
  'documentation',
  'dependency',
  'breaking-change',
  'deprecation',
  'removal',
  'maintenance',
  'other',
] as const;
 type ActivityType = typeof ACTIVITY_TYPES[number];
export interface IActivityItem {
  title: string;
  description?: string;
  mediaType?: 'image' | 'gif' | 'video';
  mediaUrl?: string;
  mediaUrls?: string[];
}

export interface IActivity extends Document {
  storeId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  type: ActivityType;
  title: string;
  shortDescription: string;
  tier?: 'free' | 'pro';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  referenceUrl?: string;
  versionId?: mongoose.Types.ObjectId;
  /** Issues this changelog entry resolves (bug-fix entries only). */
  relatedIssueIds?: mongoose.Types.ObjectId[];
  displayOrder?: number;
  mediaType?: 'image' | 'gif' | 'video';
  mediaUrl?: string;
  mediaUrls?: string[];
  tags?: string[];
  items: IActivityItem[];
  activityDate: Date;
  assigneeIds?: mongoose.Types.ObjectId[];
  estimatedHours?: number;
  actualHours?: number;
  /** Legacy flag from the removed code-activity tracker; retained for existing docs. */
  autoTracked?: boolean;
  /** Source file (relative to repo) an AI-generated draft entry was derived from. */
  filePath?: string;
  /**
   * Stable identity for entries imported from a WordPress.org readme changelog
   * (`version|normalized-title` at import time). Lets a re-import recognize a
   * line it already created even after the user edits its title/description, so
   * manual edits are never clobbered or duplicated.
   */
  importSourceKey?: string;
  /**
   * Content identity of an imported entry: `canonicalVersion|normalizedTitle`,
   * built from the version the entry is actually LINKED to. Backs the unique
   * index that makes it impossible to hold the same change line twice for one
   * version — see `changelogFingerprint`.
   */
  importFingerprint?: string;
  /**
   * Flags an entry whose data was auto-derived with low certainty and warrants a
   * human glance — currently set when a WordPress.org changelog line's type was
   * guessed (no explicit "Fix:/Add:" prefix). Cleared once a user confirms it.
   */
  needsReview?: boolean;
  /** Why the entry needs review (e.g. 'uncertain-type'). */
  reviewReason?: string;
  /** Confidence of the import-time type classification, if applicable. */
  importConfidence?: 'high' | 'medium' | 'low';
  createdAt: Date;
  updatedAt: Date;
}

const ActivityItemSchema: Schema = new Schema(
  {
    title: { type: String, required: true },
    description: { type: String, required: false },
    mediaType: {
      type: String,
      enum: ['image', 'gif', 'video'],
      required: false,
    },
    mediaUrl: { type: String, required: false },
    mediaUrls: [{ type: String, required: false }],
  },
  { _id: false }
);

const ActivitySchema: Schema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    type: {
      type: String,
      enum:ACTIVITY_TYPES,
      required: true,
    },
    title: { type: String, required: true },
    shortDescription: { type: String, required: true },
    tier: {
      type: String,
      enum: ['free', 'pro'],
      required: false,
    },
    tags: [{ type: String }],
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      required: false,
    },
    referenceUrl: { type: String, required: false },
    versionId: {
      type: Schema.Types.ObjectId,
      ref: 'Version',
      required: false,
    },
    relatedIssueIds: [{ type: Schema.Types.ObjectId, ref: 'Issue', required: false }],
    displayOrder: { type: Number, required: false },
    mediaType: {
      type: String,
      enum: ['image', 'gif', 'video'],
      required: false,
    },
    mediaUrl: { type: String, required: false },
    mediaUrls: [{ type: String, required: false }],
    items: [ActivityItemSchema],
    activityDate: { type: Date, required: true },
    assigneeIds: [{ type: Schema.Types.ObjectId, ref: 'User', required: false, index: true }],
    estimatedHours: { type: Number, required: false },
    actualHours: { type: Number, required: false },
    autoTracked: { type: Boolean, default: false, index: true },
    filePath: { type: String, required: false },
    importSourceKey: { type: String, required: false, index: true },
    importFingerprint: { type: String, required: false },
    needsReview: { type: Boolean, default: false, index: true },
    reviewReason: { type: String, required: false },
    importConfidence: { type: String, enum: ['high', 'medium', 'low'], required: false },
  },
  { timestamps: true }
);

// Indexes for report/filter queries.
ActivitySchema.index({ activityDate: -1 });
ActivitySchema.index({ productId: 1 });
ActivitySchema.index({ type: 1 });
// Compound index supporting owner-scoped trend/annual aggregations.
ActivitySchema.index({ storeId: 1, activityDate: 1, type: 1 });
// Enforce one changelog entry per (product, import key) so a re-import or two
// concurrent imports can never create duplicate entries — the DB rejects the
// second insert. Partial so it only applies to imported entries (manual/AI
// entries have no importSourceKey and are unaffected).
ActivitySchema.index(
  { productId: 1, importSourceKey: 1 },
  { unique: true, partialFilterExpression: { importSourceKey: { $exists: true } } }
);
// The content identity: one normalized change line per resolved version, per
// product. importSourceKey keys off the *readme heading*, so two headings that
// resolve to the same Version (e.g. "1.7.1" and "1.7.2" both linked to 1.7.2,
// or "1.0" and "1.0.0") produce two distinct keys and slip past that index —
// this one catches them. Genuine repeats of the same line under different
// versions have different fingerprints and are kept, by design.
ActivitySchema.index(
  { productId: 1, importFingerprint: 1 },
  { unique: true, partialFilterExpression: { importFingerprint: { $exists: true } } }
);

export const Activity = mongoose.model<IActivity>('Activity', ActivitySchema);
