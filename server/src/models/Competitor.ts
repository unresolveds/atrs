import mongoose, { Schema, Document } from 'mongoose';

export interface ICompetitor extends Document {
  storeId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  name: string;
  url?: string;
  type: 'direct' | 'indirect' | 'alternative';
  wpOrgSlug?: string;
  rssFeedUrl?: string;
  keyFeatures: string[];
  status: 'active' | 'inactive';
  lastSyncAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CompetitorSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    name: { type: String, required: true, trim: true },
    url: { type: String, trim: true },
    type: { type: String, enum: ['direct', 'indirect', 'alternative'], default: 'direct' },
    wpOrgSlug: { type: String, trim: true },
    rssFeedUrl: { type: String, trim: true },
    keyFeatures: { type: [String], default: [] },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    lastSyncAt: { type: Date }
  },
  { timestamps: true }
);

export const Competitor = mongoose.model<ICompetitor>('Competitor', CompetitorSchema);
