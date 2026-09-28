import mongoose from 'mongoose';
import { Issue } from '../../models/Issue';
import { Version } from '../../models/Version';
import { Activity } from '../../models/Activity';
import { HealthScore, type IHealthScore } from '../../models/HealthScore';
import { IntelligenceConfig } from '../../models/IntelligenceConfig';

/**
 * Computes the composite product health score.
 *
 * This service predates the signal layer and is retained because the dashboard
 * and portfolio views are built on it. Its normalisers have been replaced: the
 * originals reported `changelogQuality` as the hardcoded constant 80, set
 * `productActivity` to a copy of `featureVelocity`, and collapsed release health
 * to `releases >= 1 ? 100 : 50` — so three of the six components carried no real
 * information while still consuming the weights the user had configured.
 *
 * Every component now derives from a real measurement, and each normaliser
 * documents the curve it applies.
 */

/** How many days each period covers. */
const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30 } as const;

export type HealthPeriod = keyof typeof PERIOD_DAYS;

export class HealthScoreService {
  /**
   * Minimum age before a cached score is recomputed.
   *
   * The `GET /:productId/health` endpoint used to call `generateScore()` directly,
   * so every page load inserted a new document. That both flooded the collection
   * and broke the trend calculation, which looks for a prior score from before the
   * current period — with rows arriving seconds apart, the comparison always found
   * a near-identical score and reported "stable" indefinitely.
   */
  private static readonly CACHE_TTL_MS = 60 * 60 * 1000;

  /**
   * Returns the current score, computing one only when the cached score is stale.
   * Read endpoints should call this rather than `generateScore`.
   */
  static async getScore(
    productId: string | mongoose.Types.ObjectId,
    storeId: string | mongoose.Types.ObjectId,
    period: HealthPeriod = 'weekly',
    opts?: { force?: boolean },
  ): Promise<IHealthScore> {
    if (!opts?.force) {
      const cached = await HealthScore.findOne({ productId, period }).sort({ computedAt: -1 });
      if (cached && Date.now() - new Date(cached.computedAt).getTime() < this.CACHE_TTL_MS) {
        return cached;
      }
    }
    return this.generateScore(productId, storeId, period);
  }

  /** Computes and persists a fresh score. */
  static async generateScore(
    productId: string | mongoose.Types.ObjectId,
    storeId: string | mongoose.Types.ObjectId,
    period: HealthPeriod = 'weekly',
  ): Promise<IHealthScore> {
    let config = await IntelligenceConfig.findOne({ storeId });
    if (!config) {
      config = new IntelligenceConfig({ storeId });
      await config.save();
    }

    const now = new Date();
    const periodStart = new Date(now.getTime() - PERIOD_DAYS[period] * 86_400_000);

    const [bugMetrics, releaseMetrics, featureMetrics, documentationMetrics] = await Promise.all([
      this.calculateBugMetrics(productId, periodStart, now),
      this.calculateReleaseMetrics(productId, periodStart, now),
      this.calculateFeatureMetrics(productId, periodStart, now),
      this.calculateDocumentationMetrics(productId),
    ]);

    const breakdown = {
      bugHealth: this.normalizeBugHealth(bugMetrics),
      releaseHealth: this.normalizeReleaseHealth(releaseMetrics),
      featureVelocity: this.normalizeFeatureVelocity(featureMetrics, PERIOD_DAYS[period]),
      issueResolution: this.normalizeIssueResolution(bugMetrics),
      productActivity: this.normalizeProductActivity(featureMetrics, releaseMetrics, PERIOD_DAYS[period]),
      changelogQuality: this.normalizeChangelogQuality(documentationMetrics),
    };

    const weights = config.toObject().weights as Record<string, number>;
    let totalWeight = 0;
    let weightedSum = 0;
    for (const [key, weight] of Object.entries(weights)) {
      if (typeof weight === 'number' && weight > 0 && key in breakdown) {
        totalWeight += weight;
        weightedSum += (breakdown as Record<string, number>)[key] * weight;
      }
    }
    const overallScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

    // Compare against the most recent score at least one period old, so a weekly
    // trend actually reflects a week rather than whatever was computed minutes ago.
    const previousScore = await HealthScore.findOne({
      productId,
      period,
      computedAt: { $lte: periodStart },
    })
      .sort({ computedAt: -1 })
      .lean();

    let trend: 'improving' | 'stable' | 'declining' = 'stable';
    let trendDelta = 0;
    if (previousScore) {
      trendDelta = overallScore - previousScore.overallScore;
      if (trendDelta >= 5) trend = 'improving';
      else if (trendDelta <= -5) trend = 'declining';
    }

    return HealthScore.create({
      productId,
      storeId,
      overallScore,
      breakdown,
      metrics: {
        rawBugs: bugMetrics,
        rawReleases: releaseMetrics,
        rawFeatures: featureMetrics,
        rawDocumentation: documentationMetrics,
      },
      trend,
      trendDelta,
      period,
      computedAt: now,
    });
  }

  // --- Metric collection ----------------------------------------------------

  static async calculateBugMetrics(productId: string | mongoose.Types.ObjectId, from: Date, to: Date) {
    // Unfiltered by date: an open critical from last year is exactly what the
    // open-defect component needs to see.
    const issues = await Issue.find({ productId }).lean();

    let openCritical = 0;
    let openHigh = 0;
    let openMedium = 0;
    let resolvedInPeriod = 0;
    let createdInPeriod = 0;
    let oldestOpenSevereDays = 0;

    for (const issue of issues) {
      const created = new Date(issue.createdAt);
      if (created >= from && created <= to) createdInPeriod++;
      if (issue.resolvedAt) {
        const resolved = new Date(issue.resolvedAt);
        if (resolved >= from && resolved <= to) resolvedInPeriod++;
      }

      if (issue.status !== 'resolved' && issue.status !== 'closed') {
        if (issue.severity === 'critical') openCritical++;
        else if (issue.severity === 'high') openHigh++;
        else if (issue.severity === 'medium') openMedium++;

        if (issue.severity === 'critical' || issue.severity === 'high') {
          const ageDays = (to.getTime() - created.getTime()) / 86_400_000;
          if (ageDays > oldestOpenSevereDays) oldestOpenSevereDays = Math.floor(ageDays);
        }
      }
    }

    return { openCritical, openHigh, openMedium, resolvedInPeriod, createdInPeriod, oldestOpenSevereDays };
  }

  static async calculateReleaseMetrics(productId: string | mongoose.Types.ObjectId, from: Date, to: Date) {
    const versions = await Version.find({ productId }).lean();
    const released = versions
      .filter((v) => v.status === 'released' && v.releasedAt)
      .sort((a, b) => new Date(b.releasedAt!).getTime() - new Date(a.releasedAt!).getTime());

    const releasesInPeriod = released.filter((v) => {
      const at = new Date(v.releasedAt!);
      return at >= from && at <= to;
    }).length;

    const daysSinceLastRelease = released[0]?.releasedAt
      ? Math.floor((to.getTime() - new Date(released[0].releasedAt).getTime()) / 86_400_000)
      : null;

    // Median gap across the last six releases, resistant to one dormant stretch.
    const gaps: number[] = [];
    for (let i = 0; i < Math.min(released.length - 1, 6); i++) {
      gaps.push(
        (new Date(released[i].releasedAt!).getTime() - new Date(released[i + 1].releasedAt!).getTime()) / 86_400_000,
      );
    }
    gaps.sort((a, b) => a - b);
    const medianGapDays =
      gaps.length === 0
        ? null
        : gaps.length % 2
          ? gaps[Math.floor(gaps.length / 2)]
          : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;

    return {
      releasesInPeriod,
      totalReleases: released.length,
      unreleasedVersions: versions.filter((v) => v.status === 'unreleased').length,
      daysSinceLastRelease,
      medianGapDays: medianGapDays === null ? null : Math.round(medianGapDays * 10) / 10,
    };
  }

  static async calculateFeatureMetrics(productId: string | mongoose.Types.ObjectId, from: Date, to: Date) {
    const activities = await Activity.find({ productId, activityDate: { $gte: from, $lte: to } }).lean();

    let newFeatures = 0;
    let improvements = 0;
    let bugFixes = 0;
    for (const activity of activities) {
      if (activity.type === 'feature') newFeatures++;
      else if (activity.type === 'improvement') improvements++;
      else if (activity.type === 'bug-fix') bugFixes++;
    }

    return { newFeatures, improvements, bugFixes, total: activities.length };
  }

  /**
   * Documentation coverage across the whole release history.
   *
   * This is the real measurement that replaces the hardcoded `changelogQuality: 80`.
   */
  static async calculateDocumentationMetrics(productId: string | mongoose.Types.ObjectId) {
    const [versions, activities] = await Promise.all([
      Version.find({ productId, status: 'released' }).lean(),
      Activity.find({ productId }).select('versionId shortDescription').lean(),
    ]);

    const versionsWithEntries = new Set(activities.filter((a) => a.versionId).map((a) => String(a.versionId)));

    const documented = versions.filter(
      (v) => versionsWithEntries.has(String(v._id)) || (v.notes && v.notes.trim().length > 20),
    ).length;

    // Entries carrying a real description are what make a changelog worth reading,
    // as opposed to a bare list of titles.
    const described = activities.filter((a) => a.shortDescription && a.shortDescription.trim().length > 15).length;

    return {
      releasedVersions: versions.length,
      documentedVersions: documented,
      coveragePercent: versions.length > 0 ? Math.round((documented / versions.length) * 100) : null,
      totalEntries: activities.length,
      describedEntries: described,
      descriptionRate: activities.length > 0 ? Math.round((described / activities.length) * 100) : null,
    };
  }

  // --- Normalisers (0–100) --------------------------------------------------

  /**
   * Open-defect load.
   *
   * Weighted by severity, then aged: a critical bug open for months is worse than
   * one filed yesterday, which a flat count cannot express.
   */
  static normalizeBugHealth(m: {
    openCritical: number;
    openHigh: number;
    openMedium?: number;
    oldestOpenSevereDays?: number;
  }): number {
    let score = 100 - m.openCritical * 20 - m.openHigh * 7 - (m.openMedium ?? 0) * 2;

    const age = m.oldestOpenSevereDays ?? 0;
    if (age > 30) {
      // Up to 15 further points for a severe bug left standing, saturating at ~6 months.
      score -= Math.min(15, Math.round(((age - 30) / 150) * 15));
    }

    return clamp(score);
  }

  /**
   * Release health from recency and cadence.
   *
   * The original returned 100 or 50 depending on whether a single release landed in
   * the period, which made a plugin that shipped yesterday indistinguishable from
   * one that shipped six times, and gave a 200-day-dormant plugin a 50. Recency
   * dominates because it is the part users see on the listing.
   */
  static normalizeReleaseHealth(m: {
    releasesInPeriod: number;
    totalReleases?: number;
    daysSinceLastRelease?: number | null;
    unreleasedVersions?: number;
  }): number {
    // No release history at all is a genuine unknown; score at the neutral middle
    // rather than punishing a product that simply has not shipped yet.
    if (m.daysSinceLastRelease === null || m.daysSinceLastRelease === undefined) {
      return m.releasesInPeriod > 0 ? 100 : 50;
    }

    const days = m.daysSinceLastRelease;
    let recency: number;
    if (days <= 30) recency = 100;
    else if (days <= 90) recency = 100 - ((days - 30) / 60) * 30;
    else if (days <= 180) recency = 70 - ((days - 90) / 90) * 30;
    else if (days <= 365) recency = 40 - ((days - 180) / 185) * 40;
    else recency = 0;

    // An established release history earns a bonus, but that bonus is itself scaled
    // by recency. Otherwise a plugin dormant for two years would keep banking credit
    // for releases it shipped long ago — past shipping is not current health, and the
    // score users see on the directory reflects only the latter.
    const cadenceBonus = Math.min(15, ((m.totalReleases ?? 0) / 8) * 15) * (recency / 100);

    // Completed-but-unshipped work is a small drag: value built and not delivered.
    // Applied after capping so the penalty isn't swallowed by the clamp.
    const unreleasedPenalty = Math.min(10, (m.unreleasedVersions ?? 0) * 5);

    return clamp(Math.round(Math.min(100, recency + cadenceBonus) - unreleasedPenalty));
  }

  /**
   * Delivery volume, normalised per 30 days so periods are comparable.
   *
   * The original added a flat 10 points per unit of volume regardless of period
   * length, so a monthly score reached 100 far more easily than a daily one.
   */
  static normalizeFeatureVelocity(m: { newFeatures: number; improvements: number }, periodDays = 7): number {
    // Features count double: they move the product forward rather than maintain it.
    const weighted = m.newFeatures * 2 + m.improvements;
    const per30Days = periodDays > 0 ? (weighted / periodDays) * 30 : weighted;
    // Eight weighted units a month — roughly two features plus four improvements —
    // is a strong pace for a maintained plugin and earns full marks.
    return clamp(Math.round((per30Days / 8) * 100));
  }

  /** Resolution throughput: issues closed against issues opened. */
  static normalizeIssueResolution(m: { resolvedInPeriod: number; createdInPeriod: number }): number {
    // Nothing reported is a healthy period, not an unmeasurable one. Whether that
    // silence means "no bugs" or "no users" is a traction question, and is answered
    // by the traction detectors rather than penalised here.
    if (m.createdInPeriod === 0) return 100;
    return clamp(Math.round((m.resolvedInPeriod / m.createdInPeriod) * 100));
  }

  /**
   * Breadth of activity across changelog work and shipping.
   *
   * Previously this was assigned `featureVelocity` verbatim, so it contributed no
   * independent information while still consuming its configured weight. It now
   * measures overall activity — including the bug-fix work that feature velocity
   * deliberately excludes.
   */
  static normalizeProductActivity(
    features: { total: number; bugFixes: number },
    releases: { releasesInPeriod: number },
    periodDays = 7,
  ): number {
    const per30Days = periodDays > 0 ? (features.total / periodDays) * 30 : features.total;
    // Eight logged changes a month indicates a product under active work.
    const entryScore = Math.min(100, (per30Days / 8) * 100);
    // Shipping is the strongest single piece of evidence that work is happening.
    const releaseScore = releases.releasesInPeriod > 0 ? 100 : 40;
    return clamp(Math.round(entryScore * 0.6 + releaseScore * 0.4));
  }

  /**
   * Changelog quality — the real computation replacing the constant 80.
   *
   * Combines how many releases are documented at all with how many entries carry a
   * description worth reading.
   */
  static normalizeChangelogQuality(m: {
    releasedVersions: number;
    coveragePercent: number | null;
    descriptionRate: number | null;
  }): number {
    // With no releases yet there is nothing to document; neutral rather than zero.
    if (m.releasedVersions === 0) return 50;

    const coverage = m.coveragePercent ?? 0;
    const described = m.descriptionRate ?? 0;
    // Coverage weighs more: an undescribed entry still tells users something changed.
    return clamp(Math.round(coverage * 0.7 + described * 0.3));
  }
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
