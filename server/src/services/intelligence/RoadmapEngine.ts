import mongoose from 'mongoose';
import { z } from 'zod';
import { RoadmapItem, type IRoadmapItem, type RoadmapHorizon } from '../../models/RoadmapItem';
import type { ISignal } from '../../models/Signal';
import { SignalEngine } from './SignalEngine';
import { PromptRunner } from './llm/PromptRunner';
import { ProductDossier } from './ProductDossier';
import { computeRice } from './roadmap/rice';
import {
  candidatesFromFeatureGaps,
  candidatesFromIssues,
  candidatesFromSignals,
  type Candidate,
} from './roadmap/candidates';
import type { SignalContext } from './signals/context';

/**
 * Builds a prioritised, capacity-aware roadmap from evidence.
 *
 * The pipeline is deliberately ordered so the model influences nothing that
 * matters:
 *
 *   signals + issues + feature gaps  →  candidates (deterministic table)
 *   candidates                       →  RICE scores (deterministic arithmetic)
 *   RICE + capacity + policy         →  Now / Next / Later horizons (deterministic)
 *   horizons                         →  optional prose polish (LLM, validated)
 *
 * Everything a user would act on — what's on the list, how it's ranked, which
 * horizon it lands in, what "done" means — is computed. The LLM is offered the
 * chance to rewrite the title and description more naturally, and if it refuses,
 * fails validation, or isn't running, the deterministic text ships instead.
 */

/** Capacity in person-weeks per horizon, once weekly throughput is known. */
const NOW_WEEKS = 6;
const NEXT_WEEKS = 12;

/**
 * Assumed throughput when no hours have been logged.
 *
 * One person-week per calendar week — the single-maintainer case that describes
 * most WordPress plugins. Stated in the returned plan rather than hidden, since
 * it directly determines how much work lands in "Now".
 */
const DEFAULT_WEEKLY_CAPACITY = 1;

/** Categories that bypass capacity and always land in "Now". */
const ALWAYS_NOW = new Set(['security']);

const PolishSchema = z.object({
  title: z.string().min(8).max(100),
  description: z.string().min(60).max(900),
  citations: z.array(z.string()).min(1),
});

const POLISH_SYSTEM = `You are a product analyst refining roadmap copy for the maintainer of a WordPress plugin.

You are given a roadmap item that was derived from measured evidence, and the observations behind it.

Absolute rules:
- Do NOT change what the item is about, its scope, or its priority.
- Do NOT introduce any number, date, competitor, feature or claim that is not in the OBSERVATIONS or the DRAFT.
- Do NOT soften or dramatise. Keep the assessment exactly as strong as the evidence supports.
- Improve only clarity and specificity of the wording.
- Cite the observation codes the item rests on.
- Plain prose. No bullet lists, no headings, no marketing language, no emoji.`;

export interface RoadmapPlan {
  productId: string;
  items: IRoadmapItem[];
  /** Capacity assumptions used for horizon assignment, surfaced for the UI. */
  capacity: {
    weeklyPersonWeeks: number;
    basis: string;
    nowCapacityWeeks: number;
    nextCapacityWeeks: number;
    nowCommittedWeeks: number;
    nextCommittedWeeks: number;
  };
  /** Items whose prose was templated rather than model-written. */
  deterministicCount: number;
  generatedAt: Date;
}

export class RoadmapEngine {
  static async generate(
    productId: string | mongoose.Types.ObjectId,
    opts?: { signals?: ISignal[]; context?: SignalContext; polish?: boolean },
  ): Promise<RoadmapPlan | null> {
    let signals = opts?.signals;
    let context = opts?.context;

    if (!signals || !context) {
      const run = await SignalEngine.run(productId);
      if (!run) return null;
      signals = run.signals;
      context = run.context;
    }

    // Only active, negative-or-neutral signals drive work. Positive signals are
    // credited on the scorecard, not turned into tasks.
    const actionable = signals.filter((s) => s.direction !== 'positive');

    const candidates = this.dedupe([
      ...candidatesFromSignals(context, actionable),
      ...candidatesFromFeatureGaps(context, actionable),
      ...candidatesFromIssues(context, actionable),
    ]);

    if (candidates.length === 0) {
      await this.retireStale(context.productId, []);
      return {
        productId: context.productId,
        items: [],
        capacity: this.capacity(context),
        deterministicCount: 0,
        generatedAt: context.now,
      };
    }

    const activeInstalls = context.wpInfo?.activeInstalls ?? null;

    const scored = candidates
      .map((candidate) => ({
        candidate,
        rice: computeRice({
          category: candidate.category,
          signals: candidate.signals,
          activeInstalls,
          issues: candidate.issues,
          fallbackReachCount: candidate.fallbackReachCount,
          fallbackReachLabel: candidate.fallbackReachLabel,
          fractionKey: candidate.fractionKey,
          effortWeeks: candidate.effortWeeks,
        }),
      }))
      .sort((a, b) => b.rice.score - a.rice.score);

    const capacity = this.capacity(context);
    const placed = this.assignHorizons(scored, capacity);

    // Polish is opt-in per call: a scheduled overnight run can afford it, an
    // interactive request that must answer in a second cannot.
    const shouldPolish = opts?.polish !== false && (await PromptRunner.probe()).available;

    const items: IRoadmapItem[] = [];
    let deterministicCount = 0;

    for (const entry of placed) {
      const saved = await this.persist(context, entry, shouldPolish);
      if (!saved) continue;
      items.push(saved.item);
      if (saved.deterministic) deterministicCount++;
    }

    await this.retireStale(
      context.productId,
      placed.map((p) => p.candidate.fingerprint),
    );

    return {
      productId: context.productId,
      items,
      capacity: {
        ...capacity,
        nowCommittedWeeks: round(sum(placed.filter((p) => p.horizon === 'now').map((p) => p.rice.effort))),
        nextCommittedWeeks: round(sum(placed.filter((p) => p.horizon === 'next').map((p) => p.rice.effort))),
      },
      deterministicCount,
      generatedAt: context.now,
    };
  }

  /**
   * Collapses candidates that would produce duplicate work.
   *
   * Several signals legitimately point at the same remediation — a low support
   * resolution rate and a growing support backlog are both fixed by working the
   * forum. When that happens the candidates are merged so the supporting evidence
   * accumulates onto one item instead of the board showing the same task twice.
   */
  private static dedupe(candidates: Candidate[]): Candidate[] {
    const byFingerprint = new Map<string, Candidate>();

    for (const candidate of candidates) {
      const existing = byFingerprint.get(candidate.fingerprint);
      if (!existing) {
        byFingerprint.set(candidate.fingerprint, candidate);
        continue;
      }
      existing.signals = dedupeById([...existing.signals, ...candidate.signals]);
      existing.issues = dedupeById([...existing.issues, ...candidate.issues]);
      existing.evidence = [...existing.evidence, ...candidate.evidence].slice(0, 12);
    }

    return [...byFingerprint.values()];
  }

  /**
   * Estimates delivery throughput from logged hours.
   *
   * Uses `actualHours` on activities and issues over the last 90 days, since that
   * is the only real evidence of capacity the platform holds. Falls back to a
   * single maintainer and says so, because inventing a team size would silently
   * change how much work the roadmap claims fits in the next six weeks.
   */
  private static capacity(ctx: SignalContext): RoadmapPlan['capacity'] {
    const since = ctx.now.getTime() - 90 * 86_400_000;

    const activityHours = ctx.activities
      .filter((a) => new Date(a.activityDate).getTime() >= since)
      .reduce((total, a) => total + (a.actualHours ?? 0), 0);
    const issueHours = ctx.issues
      .filter((i) => i.resolvedAt && new Date(i.resolvedAt).getTime() >= since)
      .reduce((total, i) => total + (i.actualHours ?? 0), 0);

    const loggedHours = activityHours + issueHours;

    if (loggedHours <= 0) {
      return {
        weeklyPersonWeeks: DEFAULT_WEEKLY_CAPACITY,
        basis:
          'No actual hours logged in the last 90 days, so capacity assumes one maintainer working one person-week ' +
          'per calendar week. Log actual hours on activities and issues to base this on your real throughput.',
        nowCapacityWeeks: NOW_WEEKS * DEFAULT_WEEKLY_CAPACITY,
        nextCapacityWeeks: NEXT_WEEKS * DEFAULT_WEEKLY_CAPACITY,
        nowCommittedWeeks: 0,
        nextCommittedWeeks: 0,
      };
    }

    // 90 days ≈ 12.86 weeks; 40 hours to a person-week.
    const weekly = round(loggedHours / 40 / (90 / 7));

    return {
      weeklyPersonWeeks: weekly,
      basis:
        `${Math.round(loggedHours)} actual hours logged across activities and issues over the last 90 days ` +
        `= ${weekly} person-week(s) of delivery per calendar week.`,
      nowCapacityWeeks: round(NOW_WEEKS * weekly),
      nextCapacityWeeks: round(NEXT_WEEKS * weekly),
      nowCommittedWeeks: 0,
      nextCommittedWeeks: 0,
    };
  }

  /**
   * Places scored candidates into horizons, filling capacity in RICE order.
   *
   * Security work jumps the queue unconditionally — an unpatched advisory is not a
   * prioritisation question, and letting RICE rank it against a screenshot task
   * would be a category error. Everything else fills Now until capacity runs out,
   * then Next, then Later. Items that only exist to unblock measurement (linking a
   * WP.org slug, logging activity) go to `watch`: real work, but not delivery work,
   * and mixing them into Now would crowd out shipping.
   */
  private static assignHorizons(
    scored: Array<{ candidate: Candidate; rice: ReturnType<typeof computeRice> }>,
    capacity: RoadmapPlan['capacity'],
  ): Array<{ candidate: Candidate; rice: ReturnType<typeof computeRice>; horizon: RoadmapHorizon; rank: number }> {
    const out: Array<{ candidate: Candidate; rice: ReturnType<typeof computeRice>; horizon: RoadmapHorizon; rank: number }> = [];

    let nowUsed = 0;
    let nextUsed = 0;
    const rankByHorizon: Record<RoadmapHorizon, number> = { now: 0, next: 0, later: 0, watch: 0 };

    for (const entry of scored) {
      let horizon: RoadmapHorizon;

      // Setup/measurement items are cheap and enabling, but they aren't the work
      // that ships — keep them visible without letting them consume Now capacity.
      const isEnabling =
        entry.candidate.fingerprint === 'signal:data.no_market_link' ||
        entry.candidate.fingerprint === 'signal:activity.no_recent';

      if (ALWAYS_NOW.has(entry.candidate.category)) {
        horizon = 'now';
        nowUsed += entry.rice.effort;
      } else if (isEnabling) {
        horizon = 'watch';
      } else if (nowUsed + entry.rice.effort <= capacity.nowCapacityWeeks) {
        horizon = 'now';
        nowUsed += entry.rice.effort;
      } else if (nextUsed + entry.rice.effort <= capacity.nextCapacityWeeks) {
        horizon = 'next';
        nextUsed += entry.rice.effort;
      } else {
        horizon = 'later';
      }

      out.push({ ...entry, horizon, rank: rankByHorizon[horizon]++ });
    }

    return out;
  }

  /** Upserts one roadmap item, optionally with model-polished prose. */
  private static async persist(
    ctx: SignalContext,
    entry: { candidate: Candidate; rice: ReturnType<typeof computeRice>; horizon: RoadmapHorizon; rank: number },
    shouldPolish: boolean,
  ): Promise<{ item: IRoadmapItem; deterministic: boolean } | null> {
    const { candidate, rice, horizon, rank } = entry;

    let title = candidate.title;
    let description = candidate.description;
    let deterministic = true;

    const codes = [...new Set(candidate.signals.map((s) => s.code))];

    if (shouldPolish && codes.length > 0) {
      const run = await PromptRunner.run({
        task: `roadmap.polish.${candidate.fingerprint}`,
        schema: PolishSchema,
        taskClass: 'analytical',
        system: POLISH_SYSTEM,
        user: this.buildPolishPrompt(ctx, candidate, rice),
        allowedCitations: codes,
        minCitations: 1,
        numPredict: 600,
      });

      if (run.data) {
        title = run.data.title;
        description = run.data.description;
        deterministic = false;
      }
    }

    const item = await RoadmapItem.findOneAndUpdate(
      { productId: new mongoose.Types.ObjectId(ctx.productId), fingerprint: candidate.fingerprint },
      {
        $set: {
          storeId: new mongoose.Types.ObjectId(ctx.storeId),
          title,
          description,
          rationale: candidate.rationale,
          horizon,
          category: candidate.category,
          rice,
          rank,
          actionItems: candidate.actionItems,
          acceptanceCriteria: candidate.acceptanceCriteria,
          expectedOutcome: candidate.expectedOutcome,
          sourceSignalCodes: codes,
          sourceSignalIds: candidate.signals.map((s) => s._id as mongoose.Types.ObjectId),
          sourceIssueIds: candidate.issues.map((i) => i._id as mongoose.Types.ObjectId),
          sourceCompetitorIds: candidate.competitorIds,
          evidence: candidate.evidence.slice(0, 12),
          deterministic,
          generatedAt: ctx.now,
        },
        // A user who accepted, dismissed or started an item keeps that state
        // across regeneration; only the analysis is refreshed.
        $setOnInsert: { status: 'proposed', statusHistory: [] },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return item ? { item, deterministic } : null;
  }

  /**
   * Renders the polish prompt with the full product dossier.
   *
   * The remediation table writes correct but necessarily generic copy — it has to work
   * for every product that triggers a given signal. Handing the model the dossier is
   * what lets it rewrite "Resolve the 3 open critical bugs" into something that names
   * the actual failure mode and the users it affects.
   *
   * Competitors are excluded here: a roadmap item is about our own work, and rival
   * data in scope only invites the model to smuggle a comparison into copy whose
   * priority was decided without one.
   */
  private static buildPolishPrompt(
    ctx: SignalContext,
    candidate: Candidate,
    rice: ReturnType<typeof computeRice>,
  ): string {
    const observations = candidate.signals
      .map((s) => `- CODE: ${s.code}\n  FINDING: ${s.detail}`)
      .join('\n');

    const evidence = candidate.evidence
      .slice(0, 8)
      .map((e) => `- ${e.label}: ${e.value} [${e.source}]`)
      .join('\n');

    return `${ProductDossier.build(ctx, { includeCompetitors: false })}

# THE ITEM TO REWRITE

## OBSERVATIONS BEHIND IT (the only codes you may cite)
${observations || '- (none)'}

## SUPPORTING EVIDENCE
${evidence || '- (none)'}

## DRAFT
Title: ${candidate.title}
Description: ${candidate.description}

## PRIORITISATION (already decided — do not comment on or contradict it)
RICE ${rice.score} — reach ${rice.reach}, impact ${rice.impact}, confidence ${rice.confidence}, effort ${rice.effort} person-weeks

# TASK
Rewrite the draft title and description so they read specifically for this product,
using what you now know about what it does, who uses it and what has been going wrong.
Keep the same scope and exactly the same strength of claim — do not soften or dramatise.
Every figure must appear verbatim above; never estimate.

Return only JSON: {"title": "...", "description": "...", "citations": ["..."]}`;
  }

  /**
   * Removes proposed items that no longer have supporting evidence.
   *
   * Only `proposed` items are deleted. Anything the user accepted, started,
   * deferred or shipped is theirs — a signal clearing is not permission to erase
   * work they committed to, and a shipped item is the record the outcome
   * measurement depends on.
   */
  private static async retireStale(productId: string, liveFingerprints: string[]): Promise<void> {
    await RoadmapItem.deleteMany({
      productId: new mongoose.Types.ObjectId(productId),
      status: 'proposed',
      fingerprint: { $nin: liveFingerprints },
    });
  }

  /** The current board, grouped by horizon. */
  static async getBoard(productId: string | mongoose.Types.ObjectId): Promise<Record<RoadmapHorizon, IRoadmapItem[]>> {
    const items = (await RoadmapItem.find({
      productId,
      status: { $nin: ['dismissed'] },
    })
      .sort({ rank: 1 })
      .lean()) as unknown as IRoadmapItem[];

    const board: Record<RoadmapHorizon, IRoadmapItem[]> = { now: [], next: [], later: [], watch: [] };
    for (const item of items) board[item.horizon]?.push(item);
    return board;
  }

  /**
   * Checks whether shipped items achieved their predicted outcome.
   *
   * This is what makes `ConfidenceScorer.historicalAccuracy` mean something: the
   * platform records a prediction, waits the stated interval, then compares it
   * against the live signal set. An item whose signal has resolved achieved its
   * outcome; one whose signal is still active did not.
   */
  static async measureOutcomes(productId: string | mongoose.Types.ObjectId): Promise<IRoadmapItem[]> {
    const now = new Date();

    const due = (await RoadmapItem.find({
      productId,
      status: 'shipped',
      shippedAt: { $ne: null },
      outcomeMeasuredAt: { $exists: false },
      expectedOutcome: { $ne: null },
    })) as IRoadmapItem[];

    if (due.length === 0) return [];

    const activeSignals = await SignalEngine.getActive(productId);
    // Widened to string: `sourceSignalCodes` is persisted as string[], so a
    // Set<SignalCode> would reject the lookup below.
    const activeCodes = new Set<string>(activeSignals.map((s) => String(s.code)));
    const measured: IRoadmapItem[] = [];

    for (const item of due) {
      const shippedAt = item.shippedAt ? new Date(item.shippedAt).getTime() : null;
      const waitDays = item.expectedOutcome?.measureAfterDays ?? 30;
      if (!shippedAt || now.getTime() - shippedAt < waitDays * 86_400_000) continue;

      // The item worked if none of the signals that generated it are still firing.
      const stillFiring = item.sourceSignalCodes.filter((code) => activeCodes.has(code));
      const achieved = stillFiring.length === 0;

      item.outcomeMeasuredAt = now;
      item.outcomeAchieved = achieved;
      item.outcomeNote = achieved
        ? `Measured ${waitDays} days after shipping: the signals behind this item (${item.sourceSignalCodes.join(', ')}) have all cleared.`
        : `Measured ${waitDays} days after shipping: ${stillFiring.join(', ')} ${stillFiring.length === 1 ? 'is' : 'are'} still detected.`;
      await item.save();
      measured.push(item);
    }

    return measured;
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round = (n: number) => Math.round(n * 100) / 100;

function dedupeById<T extends { _id?: unknown }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = String(item._id ?? '');
    if (!key || seen.has(key)) return !key;
    seen.add(key);
    return true;
  });
}
