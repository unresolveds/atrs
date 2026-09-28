import mongoose, { Schema, Document } from 'mongoose';

export interface IDemo {
  icon: string;
  title: string;
  description: string;
  category: string;
  type: string;
  url: string;
}

export interface IKeyFeature {
  title: string;
  description: string;
  list?: string[];
  mediaUrl?: string;
}

export interface IFeature {
  title: string;
  description: string;
  list?: string[];
}

export interface IScreenshot {
  title: string;
  url: string;
}

export interface IFAQ {
  question: string;
  answer: string;
}

export interface IProductMarketing extends Document {
  storeId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  pluginName: string;
  trailerVideo: string;
  tutorialVideo: string;
  wpOrgUrl: string;
  docsUrl: string;
  heroDescription: string;
  thumbnailImage: string;
  problemList: string[];
  smarterWayList: string[];
  keyFeatures: IKeyFeature[];
  allFeatures: IFeature[];
  proFeaturesDesc: string;
  demos: IDemo[];
  topRatingLink: string;
  screenshots: IScreenshot[];
  faqs: IFAQ[];
  createdAt: Date;
  updatedAt: Date;
}

const DemoSchema = new Schema({
  icon: { type: String, default: '' },
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  category: { type: String, default: '' },
  type: { type: String, default: '' },
  url: { type: String, default: '' }
}, { _id: false });

const KeyFeatureSchema = new Schema({
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  list: [{ type: String }],
  mediaUrl: { type: String, default: '' }
}, { _id: false });

const FeatureSchema = new Schema({
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  list: [{ type: String }]
}, { _id: false });

const ScreenshotSchema = new Schema({
  title: { type: String, default: '' },
  url: { type: String, default: '' }
}, { _id: false });

const FAQSchema = new Schema({
  question: { type: String, default: '' },
  answer: { type: String, default: '' }
}, { _id: false });

const ProductMarketingSchema: Schema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      unique: true // 1-to-1 relationship with Product
    },
    pluginName: { type: String, default: '' },
    trailerVideo: { type: String, default: '' },
    tutorialVideo: { type: String, default: '' },
    wpOrgUrl: { type: String, default: '' },
    docsUrl: { type: String, default: '' },
    heroDescription: { type: String, default: '' },
    thumbnailImage: { type: String, default: '' },
    problemList: [{ type: String }],
    smarterWayList: [{ type: String }],
    keyFeatures: [KeyFeatureSchema],
    allFeatures: [FeatureSchema],
    proFeaturesDesc: { type: String, default: '' },
    demos: [DemoSchema],
    topRatingLink: { type: String, default: '' },
    screenshots: [ScreenshotSchema],
    faqs: [FAQSchema]
  },
  { timestamps: true }
);

export const ProductMarketing = mongoose.model<IProductMarketing>('ProductMarketing', ProductMarketingSchema);
