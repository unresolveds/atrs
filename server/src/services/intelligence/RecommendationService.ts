import mongoose from 'mongoose';
import {
  Recommendation,
  type IRecommendation,
  type RecommendationCategory,
} from '../../models/Recommendation';
import type { IRoadmapItem, RoadmapCategory } from '../../models/RoadmapItem';
import type { ISignal } from '../../models/Signal';
import type { SignalContext } from './signals/context';
import { RoadmapEngine } from './RoadmapEngine';

/**
 * Projects roadmap items into the `Recommendation` collection.
 *
 * The original produced exactly one recommendation per run, from a prompt that
 * asked the LLM to invent its own `impactScore`, `estimatedROI` and
 * `estimatedHealthDelta` — numbers with no derivation, which made two
 * recommendations impossible to compare. It also sorted `HealthScore` by the
 * non-existent `generatedAt` field, so it often reasoned from a stale score.
 *
 * Recommendations are now a *view* of the roadmap rather than a parallel
 * mechanism. `RoadmapEngine` decides what the work is and scores it with RICE, and
 * this service mirrors those items so the existing recommendation endpoints and UI
 * keep working — and, importantly, so the two views can never disagree about what
 * matters.
 */

/** Maps roadmap categories onto the older recommendation vocabulary. */
const CATEGORY_MAP: Record<RoadmapCategory, RecommendationCategory> = {
  security: 'stability',
  stability: 'stability',
  feature: 'feature',
  growth: 'strategic',
  reputation: 'strategic',
  discoverability: 'strategic',
  compliance: 'stability',
  support: 'resource',
  tech_debt: 'tech_debt',
  process: 'release_planning',
};

/** RICE effort in person-weeks mapped onto the t-shirt sizes the model stores. */
function effortToSize(weeks: number): IRecommendation['estimatedEffort'] {
  if (weeks <= 0.25) return 'xs';
  if (weeks <= 0.75) return 's';
  if (weeks <= 2) return 'm';
  if (weeks <= 4) return 'l';
  return 'xl';
}

/** Horizon drives priority: what the roadmap put in "Now" is what matters now. */
function horizonToPriority(item: IRoadmapItem): IRecommendation['priority'] {
  if (item.category === 'security') return 'critical';
  if (item.horizon === 'now') return 'high';
  if (item.horizon === 'next') return 'medium';
  return 'low';
}

/**
 * Impact on a 0–100 scale, from the RICE score.
 *
 * RICE scores are unbounded (reach can be six figures), so a log scale keeps the
 * mapping meaningful across the whole range instead of saturating every item at 100.
 */
function riceToImpactScore(score: number): number {
  if (score <= 0) return 0;
  // A RICE score of 1 maps to ~0 and 1,000,000 to 100.
  return Math.max(0, Math.min(100, Math.round((Math.log10(score + 1) / 6) * 100)));
}

function riceToRoi(score: number, effortWeeks: number): IRecommendation['estimatedROI'] {
  // Return per unit of effort is what "ROI" means here, so normalise it out.
  const perWeek = effortWeeks > 0 ? score / effortWeeks : score;
  if (perWeek >= 5000) return 'high';
  if (perWeek >= 500) return 'medium';
  return 'low';
}

export class RecommendationService {
  /**
   * Regenerates the roadmap and mirrors it into recommendations.
   *
   * Returns the recommendations in RICE order so a caller taking the first item
   * gets the highest-leverage one.
   */
  static async generateRecommendations(
    productId: string | mongoose.Types.ObjectId,
    _storeId?: string | mongoose.Types.ObjectId,
    opts?: { signals?: ISignal[]; context?: SignalContext; limit?: number },
  ): Promise<IRecommendation[]> {
    const plan = await RoadmapEngine.generate(productId, {
      signals: opts?.signals,
      context: opts?.context,
    });
    if (!plan) return [];

    // `watch` items are setup and measurement tasks, not delivery work; surfacing
    // them as recommendations would crowd out the things worth doing.
    const items = plan.items
      .filter((item) => item.horizon !== 'watch')
      .sort((a, b) => (b.rice?.score ?? 0) - (a.rice?.score ?? 0))
      .slice(0, opts?.limit ?? 12);

    const results: IRecommendation[] = [];

    for (const item of items) {
      const rice = item.rice;
      const doc = await Recommendation.findOneAndUpdate(
        // Keyed on the roadmap item so regeneration updates rather than duplicates —
        // the original inserted a new document on every single run.
        //
        // A dedicated top-level field, not a key inside `sourceMetrics`. Matching
        // `sourceMetrics: { roadmapItemId }` would require the stored subdocument to
        // equal that object exactly, which the `$set` below breaks by writing three
        // further keys into it; and matching the dotted `sourceMetrics.roadmapItemId`
        // while the same update replaces its parent is an ambiguity MongoDB can reject.
        { productId: item.productId, sourceRoadmapItemId: item._id },
        {
          $set: {
            storeId: item.storeId,
            title: item.title,
            description: item.description,
            rationale: item.rationale,
            actionItems: item.actionItems,
            category: CATEGORY_MAP[item.category] ?? 'strategic',
            priority: horizonToPriority(item),
            confidence: rice?.confidence ?? 0.5,
            impactScore: riceToImpactScore(rice?.score ?? 0),
            estimatedEffort: effortToSize(rice?.effort ?? 1),
            estimatedROI: riceToRoi(rice?.score ?? 0, rice?.effort ?? 1),
            // Derived from the roadmap horizon rather than invented: "Now" work is
            // what the scoring says moves the needle most.
            estimatedHealthDelta:
              item.horizon === 'now' ? 8 : item.horizon === 'next' ? 4 : 2,
            source: 'health_analysis',
            sourceIssueIds: item.sourceIssueIds,
            sourceMetrics: {
              roadmapItemId: String(item._id),
              horizon: item.horizon,
              rice,
              signalCodes: item.sourceSignalCodes,
            },
            expiresAt: new Date(Date.now() + 90 * 86_400_000),
          },
          // The user's triage decision survives regeneration.
          $setOnInsert: { status: 'generated', generatedAt: new Date(), statusHistory: [] },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      if (doc) results.push(doc);
    }

    return results;
  }
}
