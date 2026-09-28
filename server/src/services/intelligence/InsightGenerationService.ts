import mongoose from 'mongoose';
import type { IInsight } from '../../models/Insight';
import { InsightEngine } from './InsightEngine';
import type { ISignal } from '../../models/Signal';
import type { SignalContext } from './signals/context';

/**
 * Backwards-compatible entry point for insight generation.
 *
 * The original built each insight by handing an LLM four summary numbers and
 * accepting whatever prose came back, including the confidence score the model
 * assigned to its own output. It also sorted `HealthScore` by `generatedAt` — a
 * field that model does not have — so it frequently analysed an arbitrary
 * historical score rather than the current one, and it appended a fresh duplicate
 * insight on every run with no deduplication.
 *
 * `InsightEngine` replaces all of that: insights are clustered from deterministic
 * signals, carry the evidence they were built from, are deduplicated by
 * fingerprint, and have their confidence computed rather than self-reported. This
 * file remains so the controller and scheduler keep working.
 */
export class InsightGenerationService {
  /**
   * Generates the full insight feed for a product.
   *
   * `storeId` is accepted for signature compatibility but no longer needed —
   * ownership is resolved from the product record inside the signal context, which
   * removes a class of bug where a caller passed the requesting admin's id instead
   * of the owner's.
   */
  static async generateInsights(
    productId: string | mongoose.Types.ObjectId,
    _storeId?: string | mongoose.Types.ObjectId,
    opts?: { signals?: ISignal[]; context?: SignalContext },
  ): Promise<IInsight[]> {
    const result = await InsightEngine.generate(productId, opts);
    return result.insights;
  }

  /**
   * Kept for callers that specifically wanted the health narrative.
   *
   * Returns the stability insight when one exists, otherwise the highest-priority
   * insight available, so a caller asking for "the health summary" always gets the
   * most consequential thing known about the product rather than nothing.
   */
  static async generateHealthSummary(
    productId: string | mongoose.Types.ObjectId,
    _storeId?: string | mongoose.Types.ObjectId,
  ): Promise<IInsight | null> {
    const result = await InsightEngine.generate(productId);
    return result.insights.find((i) => i.type === 'stability') ?? result.insights[0] ?? null;
  }

  /** Kept for callers that specifically wanted the defect-trend narrative. */
  static async generateBugTrendInsight(
    productId: string | mongoose.Types.ObjectId,
    _storeId?: string | mongoose.Types.ObjectId,
  ): Promise<IInsight | null> {
    const result = await InsightEngine.generate(productId);
    return result.insights.find((i) => i.type === 'stability') ?? null;
  }
}
