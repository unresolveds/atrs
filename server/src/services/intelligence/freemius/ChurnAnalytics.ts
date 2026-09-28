import mongoose from 'mongoose';
import { UninstallFeedback } from '../../../models/UninstallFeedback';

/**
 * Read-side aggregation over stored uninstall feedback.
 *
 * Counting happens in Mongo so the UI never derives a figure of its own — the
 * same rule the detectors follow. Nothing here interprets a reason; it groups,
 * counts, and hands back the users' own words.
 */

export interface ReasonBreakdown {
  reasonId: number;
  /** Label as Freemius returned it. */
  reason: string;
  count: number;
  /** Share of reports in the window, 0–100, rounded. */
  share: number;
  /** How many of these carried free text. */
  withText: number;
}

export interface ChurnQuote {
  reasonId: number;
  reason: string;
  text: string;
  uninstalledAt: Date;
  version?: string;
}

/** What a team can actually do about a departure. */
export type ChurnBucket = 'product' | 'positioning' | 'competitive' | 'unactionable';

export interface BucketRollup {
  bucket: ChurnBucket;
  count: number;
  share: number;
  /** Reason labels that landed in this bucket, with counts, for the evidence line. */
  reasons: Array<{ reason: string; count: number }>;
}

export interface VersionChurn {
  version: string;
  count: number;
  /** Of those, how many blamed a failure — a release that broke something. */
  productFailures: number;
  share: number;
}

export interface ChurnTrendPoint {
  /** `YYYY-MM`. */
  month: string;
  total: number;
  productFailures: number;
}

export interface ChurnSummary {
  connected: boolean;
  windowDays: number;
  total: number;
  /** Reports in the window that carried free text. */
  withText: number;
  breakdown: ReasonBreakdown[];
  /** Grouped by what can be done about it — the actionable framing. */
  buckets: BucketRollup[];
  /** Which releases users were on when they left. */
  byVersion: VersionChurn[];
  /** Monthly counts, oldest first, so a direction is visible. */
  trend: ChurnTrendPoint[];
  quotes: ChurnQuote[];
  /** Most recent report, so the UI can show how fresh the data is. */
  lastReportAt: Date | null;
  /** All-time count, to distinguish "no data yet" from "quiet window". */
  totalAllTime: number;
}

/**
 * Freemius reason ids grouped by the response they call for. Ids beyond the
 * documented 1–10 are real — 12–15 appear in live data.
 *
 * `unactionable` is not a dismissal: someone who no longer needs a plugin, or
 * deactivated it temporarily, has not judged the product. Counting them as
 * failure would inflate the number that matters.
 */
const BUCKET_IDS: Record<ChurnBucket, number[]> = {
  // It broke, never worked, or they couldn't work it out.
  product: [4, 5, 8, 12, 10],
  // It worked, but it wasn't what the listing led them to expect.
  positioning: [13, 14],
  competitive: [2],
  unactionable: [1, 3, 6, 9, 15],
};

export function bucketOf(reasonId: number): ChurnBucket {
  for (const [bucket, ids] of Object.entries(BUCKET_IDS)) {
    if (ids.includes(reasonId)) return bucket as ChurnBucket;
  }
  // "Other" (7) and anything new Freemius adds: unknown intent, so it is not
  // claimed as actionable. Its free text is where the signal actually is.
  return 'unactionable';
}

const PRODUCT_FAILURE_IDS = BUCKET_IDS.product;

export class ChurnAnalytics {
  static async summarize(
    productId: string | mongoose.Types.ObjectId,
    opts: { windowDays?: number; connected?: boolean; quoteLimit?: number } = {},
  ): Promise<ChurnSummary> {
    const windowDays = opts.windowDays ?? 90;
    const pid = new mongoose.Types.ObjectId(String(productId));
    const since = new Date(Date.now() - windowDays * 86_400_000);

    const [grouped, quotes, totalAllTime, latest] = await Promise.all([
      UninstallFeedback.aggregate<{ _id: number; reason: string; count: number; withText: number }>([
        { $match: { productId: pid, uninstalledAt: { $gte: since } } },
        {
          $group: {
            _id: '$reasonId',
            reason: { $last: '$reason' },
            count: { $sum: 1 },
            withText: {
              $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$reasonInfo', ''] } }, 0] }, 1, 0] },
            },
          },
        },
        { $sort: { count: -1, _id: 1 } },
      ]),
      // Free text is the highest-value part, so it is returned in full rather
      // than summarised. Sorted with an _id tiebreaker so paging stays stable.
      UninstallFeedback.find({
        productId: pid,
        uninstalledAt: { $gte: since },
        reasonInfo: { $nin: ['', null] },
      })
        .sort({ uninstalledAt: -1, _id: -1 })
        .limit(opts.quoteLimit ?? 50)
        .select('reasonId reason reasonInfo uninstalledAt version')
        .lean(),
      UninstallFeedback.countDocuments({ productId: pid }),
      UninstallFeedback.findOne({ productId: pid }).sort({ uninstalledAt: -1, _id: -1 }).select('uninstalledAt').lean(),
    ]);

    const [versionRows, trendRows] = await Promise.all([
      UninstallFeedback.aggregate<{ _id: string; count: number; productFailures: number }>([
        { $match: { productId: pid, uninstalledAt: { $gte: since }, version: { $nin: ['', null] } } },
        {
          $group: {
            _id: '$version',
            count: { $sum: 1 },
            productFailures: {
              $sum: { $cond: [{ $in: ['$reasonId', PRODUCT_FAILURE_IDS] }, 1, 0] },
            },
          },
        },
        { $sort: { count: -1, _id: 1 } },
        { $limit: 12 },
      ]),
      UninstallFeedback.aggregate<{ _id: string; total: number; productFailures: number }>([
        { $match: { productId: pid, uninstalledAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$uninstalledAt' } },
            total: { $sum: 1 },
            productFailures: {
              $sum: { $cond: [{ $in: ['$reasonId', PRODUCT_FAILURE_IDS] }, 1, 0] },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const total = grouped.reduce((sum, g) => sum + g.count, 0);
    const breakdown: ReasonBreakdown[] = grouped.map((g) => ({
      reasonId: g._id,
      reason: g.reason || `Reason ${g._id}`,
      count: g.count,
      // Guarded against an empty window so this never produces NaN.
      share: total > 0 ? Math.round((g.count / total) * 100) : 0,
      withText: g.withText,
    }));

    // Rolled up from the same counts the breakdown uses, so the two can never
    // disagree about how many people left for a given reason.
    const bucketMap = new Map<ChurnBucket, BucketRollup>();
    for (const row of breakdown) {
      const bucket = bucketOf(row.reasonId);
      const cur = bucketMap.get(bucket) ?? { bucket, count: 0, share: 0, reasons: [] };
      cur.count += row.count;
      cur.reasons.push({ reason: row.reason, count: row.count });
      bucketMap.set(bucket, cur);
    }
    const buckets = [...bucketMap.values()]
      .map((b) => ({
        ...b,
        share: total > 0 ? Math.round((b.count / total) * 100) : 0,
        reasons: b.reasons.sort((x, y) => y.count - x.count),
      }))
      .sort((a, b) => b.count - a.count);

    return {
      connected: opts.connected ?? true,
      windowDays,
      total,
      withText: breakdown.reduce((s, b) => s + b.withText, 0),
      breakdown,
      buckets,
      byVersion: versionRows.map((v) => ({
        version: v._id,
        count: v.count,
        productFailures: v.productFailures,
        share: total > 0 ? Math.round((v.count / total) * 100) : 0,
      })),
      trend: trendRows.map((t) => ({
        month: t._id,
        total: t.total,
        productFailures: t.productFailures,
      })),
      quotes: (quotes as any[]).map((q) => ({
        reasonId: q.reasonId,
        reason: q.reason,
        text: q.reasonInfo,
        uninstalledAt: q.uninstalledAt,
        version: q.version || undefined,
      })),
      lastReportAt: (latest as any)?.uninstalledAt ?? null,
      totalAllTime,
    };
  }
}
