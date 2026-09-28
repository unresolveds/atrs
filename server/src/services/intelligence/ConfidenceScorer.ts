import mongoose from 'mongoose';
import { Insight } from '../../models/Insight';
import { Recommendation } from '../../models/Recommendation';
import type { ISignal } from '../../models/Signal';

/**
 * Computes the confidence attached to insights and recommendations.
 *
 * Previously confidence was whatever number the LLM wrote in its own JSON, which
 * is not a measurement of anything — models are not calibrated on their own
 * reliability and will happily claim 0.9 for a fabricated trend. This scorer
 * builds the number from three things we can actually observe.
 *
 * The framework document specifies:
 *
 *     Confidence = DataDensity × 0.3 + HistoricalAccuracy × 0.4 + LLMLogprobs × 0.3
 *
 * We implement the first two as written. The third is replaced by a
 * **groundedness** term, because Ollama's `/api/generate` does not return
 * logprobs, and a term we cannot compute is worse than no term at all — it would
 * have to be stubbed at a constant, silently converting a 30% weight into a
 * fixed offset. Groundedness measures what we can see: whether the output
 * validated first time and how densely it cited real evidence. That is a
 * genuine proxy for "did the model stay inside the facts", which is what the
 * logprob term was reaching for.
 */

export interface ConfidenceInput {
  /** Signals the claim is built on. */
  signals: Pick<ISignal, 'dataQuality' | 'code' | 'observationCount'>[];
  /** Attempts the LLM needed; 1 means it validated first time. */
  llmAttempts?: number;
  /** Citations the output carried. */
  citationCount?: number;
  /** True when the narrative was produced deterministically, with no LLM. */
  deterministic?: boolean;
}

export interface ConfidenceBreakdown {
  /** Final score, 0..1. */
  confidence: number;
  dataDensity: number;
  historicalAccuracy: number;
  groundedness: number;
  /** Plain-language account of how the score was reached. */
  explanation: string;
}

const WEIGHTS = { dataDensity: 0.3, historicalAccuracy: 0.4, groundedness: 0.3 };

/**
 * Used when a product has no feedback history yet.
 *
 * Deliberately below the midpoint: with nothing learned about this product's
 * accuracy, the honest stance is mild scepticism rather than a neutral 0.5 that
 * reads as "we checked and it's fine".
 */
const HISTORY_PRIOR = 0.45;
/** Feedback events needed before history outweighs the prior. */
const HISTORY_CONFIDENCE_N = 8;

export class ConfidenceScorer {
  /**
   * Data density: how much corroborating evidence exists.
   *
   * Multiple independent signals agreeing is the strongest thing we have, so the
   * count term saturates slowly (5 signals for full marks) and is multiplied by
   * the mean quality of those signals — ten shaky signals should not outscore
   * three solid ones. Repeat observations add a little, since a condition seen
   * across six runs is more real than one seen once.
   */
  static dataDensity(signals: ConfidenceInput['signals']): number {
    if (signals.length === 0) return 0;

    const countScore = Math.min(1, signals.length / 5);
    const meanQuality = signals.reduce((sum, s) => sum + s.dataQuality, 0) / signals.length;
    const persistence = Math.min(
      1,
      signals.reduce((sum, s) => sum + Math.min(s.observationCount, 6), 0) / (signals.length * 4),
    );

    return round(0.5 * countScore * meanQuality + 0.3 * meanQuality + 0.2 * persistence);
  }

  /**
   * Historical accuracy: has this product's owner found our output useful before?
   *
   * Blends explicit feedback (thumbs up/down) with implicit outcomes (accepted
   * and implemented recommendations). Shrinks toward `HISTORY_PRIOR` when the
   * sample is small, so two lucky thumbs-up can't push a new product to 100%.
   */
  static async historicalAccuracy(
    productId: string | mongoose.Types.ObjectId,
    storeId: string | mongoose.Types.ObjectId,
  ): Promise<{ score: number; sampleSize: number }> {
    const [insightFeedback, recFeedback, recOutcomes] = await Promise.all([
      Insight.find({ storeId, userFeedback: { $exists: true, $ne: null } })
        .select('userFeedback productId')
        .lean(),
      Recommendation.find({ storeId, userFeedback: { $exists: true, $ne: null } })
        .select('userFeedback productId')
        .lean(),
      Recommendation.find({ storeId, status: { $in: ['accepted', 'implemented', 'measured', 'dismissed'] } })
        .select('status productId')
        .lean(),
    ]);

    // Signals from this product count double: relevance is product-specific, but
    // a brand-new product would otherwise have no history to learn from at all.
    let positive = 0;
    let total = 0;
    const weigh = (docProductId: unknown, good: boolean) => {
      const weight = String(docProductId) === String(productId) ? 2 : 1;
      total += weight;
      if (good) positive += weight;
    };

    for (const doc of [...insightFeedback, ...recFeedback]) {
      weigh(doc.productId, doc.userFeedback === 'helpful');
    }
    for (const doc of recOutcomes) {
      weigh(doc.productId, doc.status !== 'dismissed');
    }

    if (total === 0) return { score: HISTORY_PRIOR, sampleSize: 0 };

    const observed = positive / total;
    // Shrink toward the prior in proportion to how thin the sample is.
    const weight = total / (total + HISTORY_CONFIDENCE_N);
    return { score: round(weight * observed + (1 - weight) * HISTORY_PRIOR), sampleSize: total };
  }

  /**
   * Groundedness: did the model stay inside the evidence it was given?
   *
   * A deterministic narrative scores 1.0 — it cannot hallucinate because no model
   * wrote it. Otherwise we reward first-attempt validation and citation density,
   * both of which correlate with the model working from the supplied facts rather
   * than from its priors.
   */
  static groundedness(input: ConfidenceInput): number {
    if (input.deterministic) return 1;

    const attempts = input.llmAttempts ?? 1;
    // Each retry means the first output was rejected, which is evidence of a
    // model struggling with this input.
    const attemptScore = attempts <= 1 ? 1 : attempts === 2 ? 0.7 : 0.45;

    const citations = input.citationCount ?? 0;
    const available = input.signals.length || 1;
    // Citing most of the available evidence indicates the narrative is built from
    // it; citing one of eight signals suggests the rest was invention.
    const citationScore = Math.min(1, citations / Math.min(3, available));

    return round(0.55 * attemptScore + 0.45 * citationScore);
  }

  /** Composes the final confidence with a human-readable account of the arithmetic. */
  static async score(
    productId: string | mongoose.Types.ObjectId,
    storeId: string | mongoose.Types.ObjectId,
    input: ConfidenceInput,
  ): Promise<ConfidenceBreakdown> {
    const dataDensity = this.dataDensity(input.signals);
    const { score: historicalAccuracy, sampleSize } = await this.historicalAccuracy(productId, storeId);
    const groundedness = this.groundedness(input);

    const confidence = round(
      dataDensity * WEIGHTS.dataDensity +
        historicalAccuracy * WEIGHTS.historicalAccuracy +
        groundedness * WEIGHTS.groundedness,
    );

    const historyNote =
      sampleSize === 0
        ? 'no feedback history yet, so this term sits at the cautious default'
        : `based on ${sampleSize} prior feedback signal${sampleSize === 1 ? '' : 's'}`;

    return {
      confidence,
      dataDensity,
      historicalAccuracy,
      groundedness,
      explanation:
        `Confidence ${pct(confidence)} = data density ${pct(dataDensity)} (${input.signals.length} supporting ` +
        `signal${input.signals.length === 1 ? '' : 's'}) × 30% + historical accuracy ${pct(historicalAccuracy)} ` +
        `(${historyNote}) × 40% + groundedness ${pct(groundedness)} ` +
        `(${input.deterministic ? 'computed without a language model' : `${input.citationCount ?? 0} citation(s), ${input.llmAttempts ?? 1} generation attempt(s)`}) × 30%.`,
    };
  }
}

const round = (n: number) => Math.max(0, Math.min(1, Math.round(n * 100) / 100));
const pct = (n: number) => `${Math.round(n * 100)}%`;
