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

export interface ChurnSummary {
  connected: boolean;
  windowDays: number;
  total: number;
  /** Reports in the window that carried free text. */
  withText: number;
  breakdown: ReasonBreakdown[];
  quotes: ChurnQuote[];
  /** Most recent report, so the UI can show how fresh the data is. */
  lastReportAt: Date | null;
  /** All-time count, to distinguish "no data yet" from "quiet window". */
  totalAllTime: number;
}

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

    const total = grouped.reduce((sum, g) => sum + g.count, 0);
    const breakdown: ReasonBreakdown[] = grouped.map((g) => ({
      reasonId: g._id,
      reason: g.reason || `Reason ${g._id}`,
      count: g.count,
      // Guarded against an empty window so this never produces NaN.
      share: total > 0 ? Math.round((g.count / total) * 100) : 0,
      withText: g.withText,
    }));

    return {
      connected: opts.connected ?? true,
      windowDays,
      total,
      withText: breakdown.reduce((s, b) => s + b.withText, 0),
      breakdown,
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
