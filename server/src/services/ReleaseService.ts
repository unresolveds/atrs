import { Activity } from '../models/Activity';
import { Version } from '../models/Version';
import { IProduct } from '../models/Product';
import { assembleRelease, toReadmeChangelog, toMarkdown } from '../utils/releaseFormat';

/**
 * Assembles a product's versions + changelog activities into a publishable
 * release payload: a structured per-version model plus ready-to-paste WP.org
 * readme and GitHub Markdown exports.
 */
export class ReleaseService {
  async buildRelease(product: IProduct) {
    const productId = product._id;
    // Scope children to the product's owner so a version/activity that was
    // re-parented across tenants can never surface in someone else's release.
    const storeId = (product as any).storeId;
    const [versions, activities] = await Promise.all([
      Version.find({ productId, storeId }).lean(),
      // Exclude entries still pending review (AI-generated or imported drafts) —
      // they only enter the published changelog once confirmed in the review queue.
      Activity.find({ productId, storeId, needsReview: { $ne: true } }).sort({ displayOrder: 1, activityDate: -1 }).lean(),
    ]);

    const assembled = assembleRelease(versions as any[], activities as any[]);

    const productView = {
      id: String(product._id),
      name: product.name,
      slug: product.slug,
      description: product.description || '',
      icon: product.icon || '',
      banner: product.banner || '',
      githubUrl: product.githubUrl || '',
      wpOrgSlug: product.wpOrgSlug || '',
      category: product.category,
      publicChangelogEnabled: !!product.publicChangelogEnabled,
      listedInDirectory: product.listedInDirectory !== false,
    };

    return {
      product: productView,
      releases: assembled.releases,
      unreleased: assembled.unreleased,
      formats: {
        readme: toReadmeChangelog(assembled),
        markdown: toMarkdown(product.name, assembled),
      },
    };
  }
}
