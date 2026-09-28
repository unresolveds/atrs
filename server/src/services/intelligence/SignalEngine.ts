import mongoose from 'mongoose';
import { Signal, type ISignal } from '../../models/Signal';
import { buildSignalContext, type SignalContext } from './signals/context';
import { SEVERITY_RANK, type DetectedSignal, type SignalCategory } from './signals/types';
import { stabilityDetectors } from './signals/detectors/stability';
import { velocityDetectors } from './signals/detectors/velocity';
import { marketDetectors } from './signals/detectors/market';
import { discoverabilityDetectors } from './signals/detectors/discoverability';
import { competitiveDetectors, competitiveMultiDetectors } from './signals/detectors/competitive';
import { churnDetectors } from './signals/detectors/churn';

/**
 * Runs every detector and reconciles the results against what's already stored.
 *
 * Reconciliation, not insertion, is the important part. A condition that persists
 * across runs must stay one row with a rising `observationCount`, and a condition
 * that has cleared must be marked resolved rather than silently vanishing —
 * otherwise the user can never tell "we fixed it" from "the detector stopped
 * running", and the feedback loop that scores recommendation accuracy has nothing
 * to measure.
 */

/** Detectors returning at most one signal. */
type SingleDetector = (ctx: SignalContext) => DetectedSignal | null;
/** Detectors returning one signal per subject (e.g. per competitor). */
type MultiDetector = (ctx: SignalContext) => DetectedSignal[];

const SINGLE_DETECTORS: SingleDetector[] = [
  ...stabilityDetectors,
  ...velocityDetectors,
  ...marketDetectors,
  ...discoverabilityDetectors,
  ...competitiveDetectors,
  ...churnDetectors,
];

const MULTI_DETECTORS: MultiDetector[] = [...competitiveMultiDetectors];

export interface SignalRunResult {
  signals: ISignal[];
  /** Signals detected for the first time this run. */
  newCount: number;
  /** Signals that were active and are no longer detected. */
  resolvedCount: number;
  /** Detector failures, kept non-fatal so one bad detector can't kill a run. */
  errors: Array<{ detector: string; message: string }>;
  context: SignalContext;
}

export class SignalEngine {
  /**
   * Detects signals for a product and persists the reconciled set.
   *
   * Returns the context alongside the signals because every downstream consumer
   * (insights, roadmap, scorecard) needs the same underlying facts and there is
   * no reason to pay for gathering them twice.
   */
  static async run(
    productId: string | mongoose.Types.ObjectId,
    opts?: { captureSnapshot?: boolean; now?: Date },
  ): Promise<SignalRunResult | null> {
    const context = await buildSignalContext(productId, opts);
    if (!context) return null;

    const detected: DetectedSignal[] = [];
    const errors: SignalRunResult['errors'] = [];

    for (const detector of SINGLE_DETECTORS) {
      try {
        const signal = detector(context);
        if (signal) detected.push(signal);
      } catch (error) {
        // A detector that throws is a bug in that detector, not a reason to lose
        // the other 30 signals. Surface it and continue.
        errors.push({ detector: detector.name, message: error instanceof Error ? error.message : String(error) });
      }
    }

    for (const detector of MULTI_DETECTORS) {
      try {
        detected.push(...detector(context));
      } catch (error) {
        errors.push({ detector: detector.name, message: error instanceof Error ? error.message : String(error) });
      }
    }

    const signals = await this.reconcile(context, detected);

    return {
      signals,
      newCount: signals.filter((s) => s.observationCount === 1).length,
      resolvedCount: await this.resolveStale(context, detected),
      errors,
      context,
    };
  }

  /**
   * Upserts detected signals on their fingerprint.
   *
   * `firstDetectedAt` is only set on insert (via `$setOnInsert`) so the age of a
   * condition survives re-detection — "open for 40 days" is the part users act
   * on. A signal that had been resolved and is now detected again gets reopened
   * with its original first-detection date intact, because that's the honest
   * account of a regression.
   */
  private static async reconcile(ctx: SignalContext, detected: DetectedSignal[]): Promise<ISignal[]> {
    if (detected.length === 0) return [];

    const ops = detected.map((s) => ({
      updateOne: {
        filter: { fingerprint: s.fingerprint },
        update: {
          $set: {
            productId: new mongoose.Types.ObjectId(ctx.productId),
            ownerId: new mongoose.Types.ObjectId(ctx.ownerId),
            ...(s.competitorId ? { competitorId: new mongoose.Types.ObjectId(s.competitorId) } : {}),
            code: s.code,
            category: s.category,
            direction: s.direction,
            severity: s.severity,
            title: s.title,
            detail: s.detail,
            metric: s.metric,
            evidence: s.evidence,
            dataQuality: s.dataQuality,
            active: true,
            lastDetectedAt: s.detectedAt,
          },
          // `1` rather than `''`: Mongoose's UpdateFilter type only accepts
          // `true | '' | 1` and infers a bare '' as the wider `string`.
          $unset: { resolvedAt: 1 as const },
          $setOnInsert: { firstDetectedAt: s.detectedAt },
          $inc: { observationCount: 1 },
        },
        upsert: true,
      },
    }));

    await Signal.bulkWrite(ops);

    const saved = (await Signal.find({
      fingerprint: { $in: detected.map((s) => s.fingerprint) },
    }).lean()) as unknown as ISignal[];

    // Ranked in memory rather than by Mongo. `severity` is a string enum, so a
    // `.sort({ severity: -1 })` orders it alphabetically — which puts 'info' above
    // 'critical' and silently inverts the priority every consumer depends on.
    return saved.sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.dataQuality - a.dataQuality ||
        new Date(b.lastDetectedAt).getTime() - new Date(a.lastDetectedAt).getTime(),
    );
  }

  /**
   * Marks previously-active signals that this run didn't detect as resolved.
   *
   * Scoped to the product so one product's run can't resolve another's, and it
   * deliberately doesn't delete: the resolved row is the evidence that acting on
   * the signal worked, which is what the confidence model learns from.
   */
  private static async resolveStale(ctx: SignalContext, detected: DetectedSignal[]): Promise<number> {
    const stillActive = detected.map((s) => s.fingerprint);
    const result = await Signal.updateMany(
      {
        productId: new mongoose.Types.ObjectId(ctx.productId),
        active: true,
        fingerprint: { $nin: stillActive },
      },
      { $set: { active: false, resolvedAt: ctx.now } },
    );
    return result.modifiedCount ?? 0;
  }

  /** Currently-active signals for a product, most severe first. */
  static async getActive(
    productId: string | mongoose.Types.ObjectId,
    opts?: { category?: SignalCategory; minSeverity?: keyof typeof SEVERITY_RANK },
  ): Promise<ISignal[]> {
    const query: Record<string, unknown> = { productId, active: true };
    if (opts?.category) query.category = opts.category;

    const signals = (await Signal.find(query).lean()) as unknown as ISignal[];
    const floor = opts?.minSeverity ? SEVERITY_RANK[opts.minSeverity] : -1;

    return signals
      .filter((s) => SEVERITY_RANK[s.severity] >= floor)
      // Mongo can't sort by our severity ordering, so rank in memory. Ties break
      // on data quality: a well-evidenced medium beats a shaky one.
      .sort(
        (a, b) =>
          SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
          b.dataQuality - a.dataQuality ||
          new Date(b.lastDetectedAt).getTime() - new Date(a.lastDetectedAt).getTime(),
      );
  }

  /** Recently resolved signals — the "what improved" view. */
  static async getRecentlyResolved(
    productId: string | mongoose.Types.ObjectId,
    withinDays = 30,
  ): Promise<ISignal[]> {
    return Signal.find({
      productId,
      active: false,
      resolvedAt: { $gte: new Date(Date.now() - withinDays * 86_400_000) },
    })
      .sort({ resolvedAt: -1 })
      .lean() as unknown as Promise<ISignal[]>;
  }
}
