import mongoose, { Schema, Document } from 'mongoose';

export interface IProduct extends Document {
  storeId: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  description?: string;
  githubUrl?: string;
  banner?: string;
  icon?: string;
  wpOrgSlug?: string;
  wpReadme?: string;
  /** Absolute local path to the product's source repo, watched by the code-activity tracker. */
  repoPath?: string;
  /**
   * Freemius product ("plugin") id, linking this product to its Freemius account
   * so uninstall feedback can be pulled. The keys below are product-scoped, so
   * each tracked product carries its own pair.
   */
  freemiusProductId?: string;
  /** Sealed at rest and never serialized — see `utils/crypto.ts`. */
  freemiusPublicKey?: string;
  freemiusSecretKey?: string;
  /** When true, the product's changelog is served on the public /changelog/:id page. */
  publicChangelogEnabled?: boolean;
  /** When true, the product's issues are served on the public /issues/:id page. */
  publicIssuesEnabled?: boolean;
  /** When true (default), the product appears in the public /explore directory. */
  listedInDirectory?: boolean;
  category: 'plugin' | 'block' | 'theme' | 'standalone';
  status: 'active' | 'inactive';
  createdAt: Date;
  updatedAt: Date;
}

const ProductSchema: Schema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    name: { type: String, required: true },
    // Slug is unique per owner (see compound index below), not globally — two
    // different owners may each have a product that slugifies to the same value.
    slug: { type: String, required: true },
    description: { type: String, default: '' },
    // Optional: standalone (non-WP) products may have no public repo URL.
    githubUrl: { type: String, default: '' },
    banner: { type: String, default: '' },
    icon: { type: String, default: '' },
    wpOrgSlug: { type: String, default: '' },
    wpReadme: { type: String, default: '' },
    repoPath: { type: String, default: '' },
    freemiusProductId: { type: String, default: '' },
    // Write-only credentials: `select: false` keeps them out of every ordinary
    // read, so they cannot reach an API response by accident. Stored sealed.
    freemiusPublicKey: { type: String, select: false },
    freemiusSecretKey: { type: String, select: false },
    publicChangelogEnabled: { type: Boolean, default: false },
    publicIssuesEnabled: { type: Boolean, default: false },
    listedInDirectory: { type: Boolean, default: true },
    category: {
      type: String,
      enum: ['plugin', 'block', 'theme', 'standalone'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  { timestamps: true }
);

// Slug is unique within an owner's namespace, not globally.
ProductSchema.index({ storeId: 1, slug: 1 }, { unique: true });
// Indexes for filter queries.
ProductSchema.index({ status: 1 });
ProductSchema.index({ category: 1 });

export const Product = mongoose.model<IProduct>('Product', ProductSchema);
