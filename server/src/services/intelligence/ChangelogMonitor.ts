import Parser from 'rss-parser';
import type mongoose from 'mongoose';
import { Competitor, type ICompetitor } from '../../models/Competitor';
import { CompetitorSnapshot } from '../../models/CompetitorSnapshot';

/**
 * Watches competitor RSS/Atom changelog feeds.
 *
 * This covers the competitors the WordPress.org API cannot see: commercial plugins
 * sold off-directory that publish a release feed. Its job is narrow — record what
 * shipped, as a snapshot.
 *
 * It previously also created an `Insight` directly, and that write could never
 * succeed: it set `type: 'competitor_release'` (not in the schema enum), omitted
 * the required `storeId` and `confidence`, and passed four fields the schema does
 * not define. Every RSS detection threw a ValidationError which the surrounding
 * try/catch swallowed, so competitor release alerts silently never worked while the
 * logs reported success.
 *
 * Alerting is now the signal layer's job: `detectCompetitorReleased` reads these
 * snapshots and emits a signal that participates in normal reconciliation,
 * deduplication and resolution.
 */
export class ChangelogMonitor {
  private static parser = new Parser();

  /** Captures new feed items for one competitor. Returns how many were new. */
  static async monitorCompetitor(competitor: ICompetitor): Promise<number> {
    if (!competitor.rssFeedUrl) return 0;

    try {
      const feed = await this.parser.parseURL(competitor.rssFeedUrl);
      const items = feed?.items ?? [];
      if (items.length === 0) return 0;

      // Identity for a feed item, preferring the stable guid and falling back to
      // link then title — plenty of plugin feeds omit guid entirely.
      const identityOf = (item: { guid?: string; link?: string; title?: string }) =>
        item.guid || item.link || item.title || '';

      const existing = await CompetitorSnapshot.find({
        competitorId: competitor._id,
        type: 'changelog_rss',
      })
        .sort({ capturedAt: -1 })
        .limit(30)
        .lean();

      // Compare against the whole recent window rather than only the newest
      // snapshot: feeds routinely reorder items, and the original single-item check
      // re-captured an old entry as "new" whenever that happened.
      const seen = new Set(
        existing.map((s) => String(s.data?.identity ?? s.data?.guid ?? '')).filter(Boolean),
      );

      let created = 0;
      // Oldest first, so snapshot capture order matches release order.
      for (const item of [...items].reverse().slice(-10)) {
        const identity = identityOf(item);
        if (!identity || seen.has(identity)) continue;

        await CompetitorSnapshot.create({
          competitorId: competitor._id,
          type: 'changelog_rss',
          data: {
            identity,
            title: item.title ?? null,
            link: item.link ?? null,
            pubDate: item.pubDate ?? null,
            contentSnippet: item.contentSnippet ?? null,
            guid: item.guid ?? null,
          },
          capturedAt: new Date(),
        });
        seen.add(identity);
        created++;
      }

      if (created > 0) {
        competitor.lastSyncAt = new Date();
        await competitor.save();
      }

      return created;
    } catch (error) {
      console.error(`[ChangelogMonitor] Failed to monitor ${competitor.name}:`, error);
      return 0;
    }
  }

  /** Monitors every active competitor that has a feed configured. */
  static async monitorAll(): Promise<{ checked: number; newItems: number }> {
    try {
      const competitors = await Competitor.find({
        status: 'active',
        rssFeedUrl: { $exists: true, $ne: '' },
      });

      let newItems = 0;
      for (const competitor of competitors) {
        newItems += await this.monitorCompetitor(competitor);
      }

      return { checked: competitors.length, newItems };
    } catch (error) {
      console.error('[ChangelogMonitor] Error in monitorAll:', error);
      return { checked: 0, newItems: 0 };
    }
  }

  /**
   * Recent feed items for a competitor, newest first.
   *
   * Read by the competitive detectors so RSS-tracked competitors produce release
   * signals the same way WordPress.org-tracked ones do.
   */
  static async recentItems(
    competitorId: mongoose.Types.ObjectId | string,
    withinDays = 14,
  ): Promise<Array<{ title: string | null; link: string | null; pubDate: Date | null; capturedAt: Date }>> {
    const snapshots = await CompetitorSnapshot.find({
      competitorId,
      type: 'changelog_rss',
      capturedAt: { $gte: new Date(Date.now() - withinDays * 86_400_000) },
    })
      .sort({ capturedAt: -1 })
      .limit(10)
      .lean();

    return snapshots.map((s) => {
      const raw = s.data?.pubDate ? new Date(String(s.data.pubDate)) : null;
      return {
        title: s.data?.title ? String(s.data.title) : null,
        link: s.data?.link ? String(s.data.link) : null,
        // A feed date that won't parse becomes null rather than an Invalid Date
        // that would poison downstream comparisons.
        pubDate: raw && !Number.isNaN(raw.getTime()) ? raw : null,
        capturedAt: new Date(s.capturedAt),
      };
    });
  }
}
