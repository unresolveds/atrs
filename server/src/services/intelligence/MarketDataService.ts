import mongoose from 'mongoose';
import { MarketSnapshot, type IMarketSnapshot } from '../../models/MarketSnapshot';
import { Product, type IProduct } from '../../models/Product';
import { Competitor, type ICompetitor } from '../../models/Competitor';
import { WpStatsService } from '../WpStatsService';
import { WpOrgClient, type WpPluginInfo } from './wporg/WpOrgClient';
import { meanStars, wpVersionLag } from './wporg/readme';

const wpStats = new WpStatsService();

/** A measured change in one metric across a time window. */
export interface MetricTrend {
  metric: string;
  current: number | null;
  previous: number | null;
  delta: number | null;
  /** Percent change relative to `previous`; null when previous is 0 or missing. */
  pctChange: number | null;
  /** Snapshots available inside the window — the honesty check on the trend. */
  dataPoints: number;
  /** Days actually spanned by the compared snapshots. */
  spanDays: number;
  /** Nominal window requested, for display. */
  window: string;
}

/**
 * Captures and diffs the public market position of products and competitors.
 *
 * Two responsibilities, deliberately kept together: appending snapshots and
 * reading trends out of them. Keeping the reader beside the writer means the
 * trend logic always knows the storage shape, and detectors never touch Mongo
 * directly.
 */
export class MarketDataService {
  /** Minimum gap between stored snapshots, so repeated analyse clicks don't spam the series. */
  private static readonly MIN_SNAPSHOT_GAP_MS = 6 * 60 * 60 * 1000;

  /**
   * Records the current market position of one of our products.
   *
   * Returns null when the product has no `wpOrgSlug` — a standalone product
   * simply has no public market data, which is a coverage fact for the detectors
   * to report rather than an error.
   */
  static async captureProduct(product: IProduct, opts?: { force?: boolean }): Promise<IMarketSnapshot | null> {
    const slug = (product.wpOrgSlug || '').trim();
    if (!slug) return null;

    if (!opts?.force) {
      const recent = await MarketSnapshot.findOne({ productId: product._id })
        .sort({ capturedAt: -1 })
        .lean();
      if (recent && Date.now() - new Date(recent.capturedAt).getTime() < this.MIN_SNAPSHOT_GAP_MS) {
        return MarketSnapshot.hydrate(recent);
      }
    }

    const [info, stats, currentWp] = await Promise.all([
      WpOrgClient.getPlugin(slug),
      // wp-rankings / wphive / patchstack live only in WpStatsService; reuse it
      // rather than duplicating three scrapers.
      wpStats.getStats(slug).catch(() => null),
      WpOrgClient.getCurrentWpVersion(),
    ]);

    if (!info) return null;

    return await MarketSnapshot.create({
      subjectType: 'product',
      productId: product._id,
      storeId: product.storeId,
      wpOrgSlug: slug,
      ...this.snapshotFieldsFrom(info, currentWp),
      ranking: stats?.ranking ?? null,
      memoryUsage: stats?.hive?.memory ?? null,
      speedSeconds: stats?.hive?.speedSeconds ?? null,
      vulnerabilitiesPresent: stats?.patchstack?.present ?? null,
      vulnerabilitiesPatched: stats?.patchstack?.patched ?? null,
      capturedAt: new Date(),
    });
  }

  /**
   * Records a competitor's market position. Only WP.org-listed competitors can
   * be measured; ones tracked by URL alone yield no snapshot.
   */
  static async captureCompetitor(
    competitor: ICompetitor,
    opts?: { force?: boolean },
  ): Promise<IMarketSnapshot | null> {
    const slug = (competitor.wpOrgSlug || '').trim();
    if (!slug) return null;

    if (!opts?.force) {
      const recent = await MarketSnapshot.findOne({ competitorId: competitor._id })
        .sort({ capturedAt: -1 })
        .lean();
      if (recent && Date.now() - new Date(recent.capturedAt).getTime() < this.MIN_SNAPSHOT_GAP_MS) {
        return MarketSnapshot.hydrate(recent);
      }
    }

    const [info, currentWp] = await Promise.all([
      WpOrgClient.getPlugin(slug),
      WpOrgClient.getCurrentWpVersion(),
    ]);
    if (!info) return null;

    const snapshot = await MarketSnapshot.create({
      subjectType: 'competitor',
      competitorId: competitor._id,
      productId: competitor.productId,
      storeId: competitor.storeId,
      wpOrgSlug: slug,
      ...this.snapshotFieldsFrom(info, currentWp),
      capturedAt: new Date(),
    });

    competitor.lastSyncAt = new Date();
    await competitor.save();
    return snapshot;
  }

  /** Shared mapping from WP.org detail to snapshot columns. */
  private static snapshotFieldsFrom(info: WpPluginInfo, currentWp: string | null) {
    return {
      activeInstalls: info.activeInstalls,
      downloaded: info.downloaded,
      rating: info.rating,
      numRatings: info.numRatings,
      ratingHistogram: info.ratings,
      meanStars: meanStars(info.ratings),
      supportThreads: info.supportThreads,
      supportThreadsResolved: info.supportThreadsResolved,
      version: info.version,
      lastUpdated: info.lastUpdated,
      testedUpTo: info.testedUpTo,
      requiresPhp: info.requiresPhp,
      wpVersionLag: wpVersionLag(info.testedUpTo, currentWp),
    };
  }

  /** Captures the product plus all of its active competitors in one pass. */
  static async captureAllForProduct(
    productId: string | mongoose.Types.ObjectId,
    opts?: { force?: boolean },
  ): Promise<{ product: IMarketSnapshot | null; competitors: IMarketSnapshot[] }> {
    const product = await Product.findById(productId);
    if (!product) return { product: null, competitors: [] };

    const competitors = await Competitor.find({ productId, status: 'active' });
    const [productSnap, competitorSnaps] = await Promise.all([
      this.captureProduct(product, opts),
      // Sequential to stay polite to WP.org; the list is small (a handful).
      (async () => {
        const out: IMarketSnapshot[] = [];
        for (const c of competitors) {
          const snap = await this.captureCompetitor(c, opts);
          if (snap) out.push(snap);
        }
        return out;
      })(),
    ]);

    return { product: productSnap, competitors: competitorSnaps };
  }

  /** Snapshot history for one of our products, newest first. */
  static async getProductSeries(
    productId: string | mongoose.Types.ObjectId,
    limit = 60,
  ): Promise<IMarketSnapshot[]> {
    return MarketSnapshot.find({ productId, subjectType: 'product' })
      .sort({ capturedAt: -1 })
      .limit(limit)
      .lean() as unknown as IMarketSnapshot[];
  }

  /** Snapshot history for a tracked competitor, newest first. */
  static async getCompetitorSeries(
    competitorId: string | mongoose.Types.ObjectId,
    limit = 60,
  ): Promise<IMarketSnapshot[]> {
    return MarketSnapshot.find({ competitorId })
      .sort({ capturedAt: -1 })
      .limit(limit)
      .lean() as unknown as IMarketSnapshot[];
  }

  /**
   * Diffs a numeric field across a window.
   *
   * The comparison baseline is the *oldest snapshot inside the window*, not the
   * immediately preceding one: comparing today against yesterday would report
   * noise as a 30-day trend. When nothing in the window is old enough we return
   * a trend with `previous: null`, and detectors are required to treat that as
   * "unknown" rather than "flat" — silently reporting no change when we simply
   * lack history is exactly the kind of false confidence this layer exists to
   * prevent.
   */
  static computeTrend(
    series: IMarketSnapshot[],
    field: keyof IMarketSnapshot,
    windowDays: number,
  ): MetricTrend {
    const label = `${windowDays}d`;
    const sorted = [...series].sort(
      (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime(),
    );

    const readable = sorted.filter((s) => typeof s[field] === 'number' && s[field] !== null);
    const latest = readable[0];
    if (!latest) {
      return {
        metric: String(field),
        current: null,
        previous: null,
        delta: null,
        pctChange: null,
        dataPoints: 0,
        spanDays: 0,
        window: label,
      };
    }

    const currentValue = latest[field] as unknown as number;
    const cutoff = new Date(latest.capturedAt).getTime() - windowDays * 86_400_000;
    const inWindow = readable.filter((s) => new Date(s.capturedAt).getTime() >= cutoff);
    // Oldest reading still inside the window becomes the baseline.
    const baseline = inWindow[inWindow.length - 1];

    if (!baseline || baseline === latest) {
      return {
        metric: String(field),
        current: currentValue,
        previous: null,
        delta: null,
        pctChange: null,
        dataPoints: inWindow.length,
        spanDays: 0,
        window: label,
      };
    }

    const previousValue = baseline[field] as unknown as number;
    const delta = currentValue - previousValue;
    const spanDays =
      (new Date(latest.capturedAt).getTime() - new Date(baseline.capturedAt).getTime()) / 86_400_000;

    return {
      metric: String(field),
      current: currentValue,
      previous: previousValue,
      delta,
      pctChange: previousValue !== 0 ? Math.round((delta / Math.abs(previousValue)) * 1000) / 10 : null,
      dataPoints: inWindow.length,
      spanDays: Math.round(spanDays * 10) / 10,
      window: label,
    };
  }

  /**
   * Data-quality score for a trend, used as the Signal's `dataQuality`.
   *
   * Rewards both the number of observations and the share of the window actually
   * covered, so a 30-day claim backed by two snapshots 2 days apart scores low
   * even though two points are technically enough to draw a line.
   */
  static trendQuality(trend: MetricTrend, windowDays: number): number {
    if (trend.previous === null || trend.dataPoints < 2) return 0.2;
    const pointScore = Math.min(1, trend.dataPoints / 8);
    const coverage = Math.min(1, trend.spanDays / Math.max(1, windowDays));
    return Math.round((0.35 + 0.35 * pointScore + 0.3 * coverage) * 100) / 100;
  }
}
