import mongoose from 'mongoose';
import { Product, type IProduct } from '../../../models/Product';
import { Issue, type IIssue } from '../../../models/Issue';
import { Version, type IVersion } from '../../../models/Version';
import { Activity, type IActivity } from '../../../models/Activity';
import { Competitor, type ICompetitor } from '../../../models/Competitor';
import type { IMarketSnapshot } from '../../../models/MarketSnapshot';
import { UninstallFeedback, type IUninstallFeedback } from '../../../models/UninstallFeedback';
import { WpOrgClient, type WpPluginInfo } from '../wporg/WpOrgClient';
import { computeCadence, extractFeatures, parseChangelog, type CadenceFacts } from '../wporg/readme';
import { MarketDataService } from '../MarketDataService';
import { ReadmeAuditor, type ListingAudit } from '../ReadmeAuditor';
import { ChangelogMonitor } from '../ChangelogMonitor';

/** One competitor with every fact we could gather about it. */
export interface CompetitorContext {
  competitor: ICompetitor;
  /** Null when the competitor isn't on WP.org or the fetch failed. */
  info: WpPluginInfo | null;
  series: IMarketSnapshot[];
  cadence: CadenceFacts | null;
  /** Features read out of the competitor's real readme, falling back to hand-entered ones. */
  features: string[];
  featureSource: 'readme' | 'manual' | 'none';
  /**
   * Recent changelog-feed items, for competitors tracked by RSS rather than by
   * WordPress.org slug. Without this, commercial off-directory competitors would
   * produce no release signals at all.
   */
  rssItems: Array<{ title: string | null; link: string | null; pubDate: Date | null; capturedAt: Date }>;
}

/**
 * Everything a detector is allowed to look at, gathered once per run.
 *
 * Detectors are pure functions over this object. That keeps them trivially
 * testable (no mocking Mongo or WP.org) and guarantees every detector in a run
 * reasons about the same instant and the same numbers.
 */
export interface SignalContext {
  productId: string;
  ownerId: string;
  product: IProduct;
  now: Date;

  // ATRS-internal truth
  issues: IIssue[];
  versions: IVersion[];
  activities: IActivity[];

  // Public market truth
  wpInfo: WpPluginInfo | null;
  productSeries: IMarketSnapshot[];
  listingAudit: ListingAudit | null;
  cadence: CadenceFacts | null;
  currentWp: string | null;
  ownFeatures: string[];

  /**
   * Stated uninstall reasons pulled from Freemius, newest first. Empty when the
   * product isn't connected — the churn detectors then stay silent rather than
   * reporting a zero they can't justify.
   */
  uninstalls: IUninstallFeedback[];

  competitors: CompetitorContext[];
}

/** How far back internal history is loaded. A year covers annual seasonality without unbounded reads. */
const HISTORY_DAYS = 365;

export async function buildSignalContext(
  productId: string | mongoose.Types.ObjectId,
  opts?: { captureSnapshot?: boolean; now?: Date },
): Promise<SignalContext | null> {
  const product = await Product.findById(productId);
  if (!product) return null;

  const now = opts?.now ?? new Date();
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000);
  const pid = product._id;

  // Appending a snapshot before reading the series means the current run always
  // has today's reading available for its trend comparisons.
  if (opts?.captureSnapshot !== false) {
    await MarketDataService.captureAllForProduct(pid).catch(() => undefined);
  }

  const [issues, versions, activities, competitorDocs, productSeries, currentWp, uninstalls] = await Promise.all([
    // Issues are loaded unfiltered by date: an open critical bug from 18 months
    // ago is precisely the thing an aging-backlog detector must see.
    Issue.find({ productId: pid }).lean() as unknown as Promise<IIssue[]>,
    Version.find({ productId: pid }).lean() as unknown as Promise<IVersion[]>,
    Activity.find({ productId: pid, activityDate: { $gte: since } })
      .sort({ activityDate: -1 })
      .lean() as unknown as Promise<IActivity[]>,
    Competitor.find({ productId: pid, status: 'active' }),
    MarketDataService.getProductSeries(pid),
    WpOrgClient.getCurrentWpVersion(),
    // Same year-long window as the rest of the context; detectors narrow it further.
    // The _id tiebreaker keeps the sort total when two uninstalls share a timestamp.
    UninstallFeedback.find({ productId: pid, uninstalledAt: { $gte: since } })
      .sort({ uninstalledAt: -1, _id: -1 })
      .lean() as unknown as Promise<IUninstallFeedback[]>,
  ]);

  const wpInfo = product.wpOrgSlug ? await WpOrgClient.getPlugin(product.wpOrgSlug) : null;

  const cadence = wpInfo ? computeCadence(parseChangelog(wpInfo.sections['changelog'] || ''), now) : null;
  const listingAudit = wpInfo ? ReadmeAuditor.audit(wpInfo, currentWp) : null;
  const ownFeatures = wpInfo ? extractFeatures(wpInfo) : [];

  const competitors: CompetitorContext[] = [];
  for (const competitor of competitorDocs) {
    const info = competitor.wpOrgSlug ? await WpOrgClient.getPlugin(competitor.wpOrgSlug) : null;
    const readmeFeatures = info ? extractFeatures(info) : [];
    // Prefer the live readme; fall back to whatever the user typed so a
    // non-WP.org competitor still participates in the gap matrix.
    const features = readmeFeatures.length > 0 ? readmeFeatures : competitor.keyFeatures || [];
    competitors.push({
      competitor,
      info,
      series: await MarketDataService.getCompetitorSeries(competitor._id as mongoose.Types.ObjectId),
      cadence: info ? computeCadence(parseChangelog(info.sections['changelog'] || ''), now) : null,
      features,
      featureSource: readmeFeatures.length > 0 ? 'readme' : features.length > 0 ? 'manual' : 'none',
      rssItems: competitor.rssFeedUrl
        ? await ChangelogMonitor.recentItems(competitor._id, 14).catch(() => [])
        : [],
    });
  }

  return {
    productId: String(product._id),
    ownerId: String(product.ownerId),
    product,
    now,
    issues,
    versions,
    activities,
    wpInfo,
    productSeries,
    listingAudit,
    cadence,
    currentWp,
    ownFeatures,
    uninstalls,
    competitors,
  };
}
