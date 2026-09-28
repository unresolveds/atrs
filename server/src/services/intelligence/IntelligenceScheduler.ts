import * as cron from 'node-cron';
import { IntelligenceConfig } from '../../models/IntelligenceConfig';
import { Product } from '../../models/Product';
import { HealthScoreService } from './HealthScoreService';
import { InsightEngine } from './InsightEngine';
import { RecommendationService } from './RecommendationService';
import { RoadmapEngine } from './RoadmapEngine';
import { SignalEngine } from './SignalEngine';
import { FreemiusSyncService } from './freemius/FreemiusSyncService';
import { StandoutScorecardService } from './StandoutScorecardService';
import { ChangelogMonitor } from './ChangelogMonitor';

/**
 * Runs analysis on a schedule.
 *
 * Two changes from the original matter. It now computes signals **once** per
 * product and passes that context to every downstream engine, instead of each
 * engine independently re-querying Mongo and re-fetching WordPress.org — the old
 * arrangement made the same external calls four times per product and could leave
 * engines disagreeing because they had read at different instants.
 *
 * And it queries products by `ownerId`. The original used `Product.find({ userId })`
 * against a schema whose field is `ownerId`, so it always matched zero products and
 * scheduled analysis silently did nothing for every user who enabled it.
 */
export class IntelligenceScheduler {
  private static hourlyTask: cron.ScheduledTask | null = null;
  private static feedTask: cron.ScheduledTask | null = null;
  /** Guards against a slow run overlapping the next tick. */
  private static running = false;

  static initialize(): void {
    // Hourly tick; each config decides whether this is its hour.
    this.hourlyTask = cron.schedule('0 * * * *', async () => {
      if (this.running) {
        console.warn('[IntelligenceScheduler] Previous run still in progress; skipping this tick.');
        return;
      }
      this.running = true;
      try {
        await this.runAnalysisForEligibleConfigs();
      } finally {
        this.running = false;
      }
    });

    // Competitor feeds are cheap to poll and time-sensitive, so they run more often
    // than full analysis.
    this.feedTask = cron.schedule('30 */6 * * *', async () => {
      const result = await ChangelogMonitor.monitorAll();
      if (result.newItems > 0) {
        console.log(`[IntelligenceScheduler] Captured ${result.newItems} new competitor changelog item(s).`);
      }

      // Uninstall feedback rides the same tick: it is the same shape of work —
      // a cheap external poll that only writes facts. Failures are logged and
      // swallowed so a Freemius outage cannot stop competitor monitoring.
      try {
        const churn = await FreemiusSyncService.syncAll();
        if (churn.stored > 0) {
          console.log(`[IntelligenceScheduler] Stored ${churn.stored} new uninstall reason(s) across ${churn.products} product(s).`);
        }
        for (const e of churn.errors) console.warn(`[IntelligenceScheduler] Freemius sync: ${e}`);
      } catch (err) {
        console.error('[IntelligenceScheduler] Freemius sync failed:', err instanceof Error ? err.message : err);
      }
    });

    console.log('[IntelligenceScheduler] Initialized background scheduler.');
  }

  private static async runAnalysisForEligibleConfigs(): Promise<void> {
    try {
      const now = new Date();
      const configs = await IntelligenceConfig.find({
        autoAnalysis: true,
        analysisHour: now.getUTCHours(),
      });

      for (const config of configs) {
        const shouldRun =
          config.analysisFrequency === 'daily' ||
          (config.analysisFrequency === 'weekly' && now.getUTCDay() === 0) ||
          (config.analysisFrequency === 'monthly' && now.getUTCDate() === 1);

        if (shouldRun) {
          await this.analyzeAllProductsForUser(config.ownerId.toString());
        }
      }
    } catch (error) {
      console.error('[IntelligenceScheduler] Error running analysis:', error);
    }
  }

  private static async analyzeAllProductsForUser(userId: string): Promise<void> {
    try {
      // `ownerId`, not `userId` — the original queried a field that does not exist
      // on the Product schema, so scheduled analysis never processed anything.
      const products = await Product.find({ ownerId: userId, status: 'active' });
      console.log(`[IntelligenceScheduler] Analyzing ${products.length} product(s) for owner ${userId}`);

      for (const product of products) {
        try {
          await this.analyzeProduct(String(product._id));
        } catch (error) {
          console.error(`[IntelligenceScheduler] Failed to analyze product ${product._id}:`, error);
        }
      }
    } catch (error) {
      console.error(`[IntelligenceScheduler] Failed to load products for owner ${userId}:`, error);
    }
  }

  /**
   * The full analysis pass for one product.
   *
   * Exposed so the manual "Run analysis" action executes exactly the same pipeline
   * as the scheduled run — a scheduled path that diverges from the interactive one
   * is a path nobody notices is broken.
   */
  static async analyzeProduct(productId: string): Promise<{
    signalCount: number;
    insightCount: number;
    roadmapItemCount: number;
    resolvedSignalCount: number;
    detectorErrors: Array<{ detector: string; message: string }>;
  }> {
    // One signal run; every engine below shares its context and its instant.
    const run = await SignalEngine.run(productId);
    if (!run) {
      return {
        signalCount: 0,
        insightCount: 0,
        roadmapItemCount: 0,
        resolvedSignalCount: 0,
        detectorErrors: [],
      };
    }

    const { signals, context } = run;

    await HealthScoreService.generateScore(productId, context.ownerId, 'weekly');

    const insights = await InsightEngine.generate(productId, { signals, context });
    const plan = await RoadmapEngine.generate(productId, { signals, context });

    // Mirror the roadmap into the legacy recommendation collection so both views agree.
    await RecommendationService.generateRecommendations(productId, context.ownerId, { signals, context });

    // Refresh the scorecard so the dashboard need not compute it on request.
    await StandoutScorecardService.generate(productId, { signals, context }).catch((error) =>
      console.error(`[IntelligenceScheduler] Scorecard failed for ${productId}:`, error),
    );

    // Close the learning loop: check whether previously shipped items delivered what
    // they predicted. This is what gives ConfidenceScorer real history to work from.
    await RoadmapEngine.measureOutcomes(productId).catch((error) =>
      console.error(`[IntelligenceScheduler] Outcome measurement failed for ${productId}:`, error),
    );

    if (run.errors.length > 0) {
      console.warn(`[IntelligenceScheduler] ${run.errors.length} detector error(s) for ${productId}:`, run.errors);
    }

    return {
      signalCount: signals.length,
      insightCount: insights.insights.length,
      roadmapItemCount: plan?.items.length ?? 0,
      resolvedSignalCount: run.resolvedCount,
      detectorErrors: run.errors,
    };
  }

  static stop(): void {
    this.hourlyTask?.stop();
    this.feedTask?.stop();
    this.hourlyTask = null;
    this.feedTask = null;
    console.log('[IntelligenceScheduler] Stopped background scheduler.');
  }
}
