import mongoose from 'mongoose';
import { z } from 'zod';
import { Insight, type IInsight, type InsightSeverity, type InsightType } from '../../models/Insight';
import type { ISignal } from '../../models/Signal';
import { SignalEngine } from './SignalEngine';
import { ConfidenceScorer } from './ConfidenceScorer';
import { PromptRunner } from './llm/PromptRunner';
import { ProductDossier } from './ProductDossier';
import { SEVERITY_RANK, type Evidence, type SignalCategory } from './signals/types';
import type { SignalContext } from './signals/context';

/**
 * Turns signals into readable insights.
 *
 * Two decisions define this service:
 *
 *  1. **Signals are clustered by concern, not emitted one-to-one.** Thirty signals
 *     would produce thirty cards nobody reads. Grouping by category means the user
 *     gets "here is the stability picture" with the numbers behind it, which is the
 *     unit of information they can actually act on.
 *
 *  2. **The narrative is the only thing the LLM contributes.** Severity, which
 *     signals matter, confidence, and every number come from the deterministic
 *     layer. If the model is unavailable or produces ungrounded output, we template
 *     the narrative instead and mark the insight `deterministic` — the insight is
 *     always correct, and only its prose quality degrades.
 */

/** Categories that earn their own insight card, in feed order. */
export const CATEGORY_ORDER: SignalCategory[] = [
  'compliance',
  'stability',
  // Sits with stability: the failure-churn signal is users reporting the same
  // breakage by leaving instead of filing an issue, so the two read together.
  'churn',
  'reputation',
  'support',
  'traction',
  'competitive',
  'discoverability',
  'velocity',
  'coverage',
];

/** Human framing for each category, used in prompts and fallbacks. */
export const CATEGORY_LABEL: Record<SignalCategory, { title: string; lens: string }> = {
  stability: { title: 'Stability', lens: 'defect load and how it affects users' },
  velocity: { title: 'Release discipline', lens: 'shipping cadence and delivery process' },
  traction: { title: 'Market traction', lens: 'install growth and retention' },
  churn: { title: 'Why users leave', lens: 'the reasons users gave when they uninstalled' },
  reputation: { title: 'Reputation', lens: 'ratings, reviews and public perception' },
  support: { title: 'Support load', lens: 'support responsiveness and its downstream effect on reviews' },
  discoverability: { title: 'Discoverability', lens: 'directory listing quality and install conversion' },
  compliance: { title: 'Platform compliance', lens: 'security, compatibility and performance obligations' },
  competitive: { title: 'Competitive position', lens: 'standing against tracked competitors' },
  coverage: { title: 'Data coverage', lens: 'what the analysis currently cannot see' },
};

/** Maps a signal category onto the insight type stored on the document. */
export const CATEGORY_TO_TYPE: Record<SignalCategory, InsightType> = {
  stability: 'stability',
  velocity: 'velocity',
  traction: 'traction',
  // Deliberately reuses the persisted 'traction' type rather than adding a new
  // enum value: churn reasons are retention evidence, and the Insight type enum
  // is stored, so extending it would be a migration for no analytical gain.
  churn: 'traction',
  reputation: 'reputation',
  support: 'support',
  discoverability: 'discoverability',
  compliance: 'compliance',
  competitive: 'competitive',
  coverage: 'coverage',
};

/** The shape the model must return. Anything else is rejected and retried. */
const NarrativeSchema = z.object({
  title: z.string().min(8).max(90),
  narrative: z.string().min(80).max(1200),
  /** Signal codes the narrative drew on; validated against the allow-list. */
  citations: z.array(z.string()).min(1),
});

const SYSTEM_PROMPT = `You are a product analyst writing for the maintainer of a WordPress plugin.

Absolute rules:
- Use ONLY the facts in the OBSERVATIONS block. Never introduce a number, date, competitor, feature or trend that does not appear there.
- Never estimate, extrapolate or round differently from the given figures.
- If the observations are thin, say so plainly rather than filling the gap.
- Cite the observation codes you used in the "citations" array. Cite every code you relied on and no others.
- Write in plain, specific prose. No marketing language, no bullet lists, no headings, no emoji.
- Explain what the numbers mean for the product and what follows from them. Do not merely restate them.
- Address the maintainer as "you".`;

export interface GeneratedInsight {
  insight: IInsight;
  /** True when the narrative was templated because the LLM path failed. */
  deterministic: boolean;
}

export interface InsightRunResult {
  insights: IInsight[];
  /** Insights whose narrative fell back to a template. */
  deterministicCount: number;
  /** Set when the language model could not be reached at all. */
  llmUnavailableReason?: string;
}

export class InsightEngine {
  /**
   * Generates the insight feed for a product.
   *
   * Runs the signal engine first unless a caller passes a context it already
   * built, because a full analysis (`triggerAnalysis`) computes signals once and
   * then wants insights, roadmap and scorecard from the same facts.
   */
  static async generate(
    productId: string | mongoose.Types.ObjectId,
    opts?: { signals?: ISignal[]; context?: SignalContext; maxInsights?: number },
  ): Promise<InsightRunResult> {
    let signals = opts?.signals;
    let context = opts?.context;

    if (!signals || !context) {
      const run = await SignalEngine.run(productId);
      if (!run) return { insights: [], deterministicCount: 0 };
      signals = run.signals;
      context = run.context;
    }

    const maxInsights = opts?.maxInsights ?? 10;

    // Probe once per run rather than per insight: a down provider should cost one
    // failed request, not one per category.
    const probe = await PromptRunner.probe();

    const clusters = this.cluster(signals);
    const results: IInsight[] = [];
    let deterministicCount = 0;

    for (const cluster of clusters.slice(0, maxInsights)) {
      const generated = await this.buildInsight(context, cluster, probe.available);
      if (!generated) continue;
      results.push(generated.insight);
      if (generated.deterministic) deterministicCount++;
    }

    // Retire insights whose underlying signals have all cleared, so the feed
    // reflects the present rather than accumulating history.
    await this.retireStale(context.productId, clusters.map((c) => c.fingerprint));

    return {
      insights: results,
      deterministicCount,
      llmUnavailableReason: probe.available ? undefined : probe.error || 'AI provider unreachable',
    };
  }

  /**
   * Groups signals into one cluster per category.
   *
   * Clusters are ordered by their most severe member so a critical vulnerability
   * outranks a discoverability nit regardless of category order, and purely
   * positive clusters sink to the bottom — good news is worth stating but should
   * never head the feed above an active problem.
   */
  private static cluster(signals: ISignal[]): SignalCluster[] {
    const byCategory = new Map<SignalCategory, ISignal[]>();
    for (const signal of signals) {
      const category = signal.category as SignalCategory;
      const list = byCategory.get(category) ?? [];
      list.push(signal);
      byCategory.set(category, list);
    }

    const clusters: SignalCluster[] = [];
    for (const category of CATEGORY_ORDER) {
      const members = byCategory.get(category);
      if (!members || members.length === 0) continue;

      const sorted = [...members].sort(
        (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.dataQuality - a.dataQuality,
      );
      const peak = sorted[0];
      const hasNegative = sorted.some((s) => s.direction === 'negative');

      clusters.push({
        category,
        signals: sorted,
        peakSeverity: SEVERITY_RANK[peak.severity],
        allPositive: !hasNegative,
        // Identity is the category plus its contributing codes: if the mix of
        // problems changes, it is genuinely a different insight and should replace
        // the old one rather than silently updating its text.
        fingerprint: `${category}:${sorted.map((s) => s.code).sort().join(',')}`,
      });
    }

    return clusters.sort(
      (a, b) =>
        Number(a.allPositive) - Number(b.allPositive) ||
        b.peakSeverity - a.peakSeverity ||
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
    );
  }

  /** Builds and upserts one insight from one cluster. */
  private static async buildInsight(
    ctx: SignalContext,
    cluster: SignalCluster,
    llmAvailable: boolean,
  ): Promise<GeneratedInsight | null> {
    const { category, signals } = cluster;

    // Cap the evidence carried onto the insight; the full set stays on the signals.
    const evidence: Evidence[] = signals.flatMap((s) => s.evidence).slice(0, 12);
    const codes = [...new Set(signals.map((s) => s.code))];

    let title: string;
    let narrative: string;
    let deterministic = true;
    let attempts = 1;
    let citationCount = codes.length;

    if (llmAvailable) {
      const run = await PromptRunner.run({
        task: `insight.${category}`,
        schema: NarrativeSchema,
        taskClass: 'explanatory',
        system: SYSTEM_PROMPT,
        user: this.buildUserPrompt(ctx, cluster),
        allowedCitations: codes,
        minCitations: 1,
        numPredict: 700,
      });

      if (run.data) {
        title = run.data.title;
        narrative = run.data.narrative;
        deterministic = false;
        attempts = run.attempts;
        citationCount = run.data.citations.length;
      } else {
        ({ title, narrative } = this.templateNarrative(cluster));
      }
    } else {
      ({ title, narrative } = this.templateNarrative(cluster));
    }

    const breakdown = await ConfidenceScorer.score(ctx.productId, ctx.ownerId, {
      signals,
      llmAttempts: attempts,
      citationCount,
      deterministic,
    });

    const insight = await Insight.findOneAndUpdate(
      { productId: new mongoose.Types.ObjectId(ctx.productId), fingerprint: cluster.fingerprint },
      {
        $set: {
          ownerId: new mongoose.Types.ObjectId(ctx.ownerId),
          type: CATEGORY_TO_TYPE[category] ?? 'general',
          severity: this.toInsightSeverity(cluster),
          title,
          narrative,
          confidence: breakdown.confidence,
          confidenceBreakdown: {
            dataDensity: breakdown.dataDensity,
            historicalAccuracy: breakdown.historicalAccuracy,
            groundedness: breakdown.groundedness,
            explanation: breakdown.explanation,
          },
          signalCodes: codes,
          signalIds: signals.map((s) => s._id as mongoose.Types.ObjectId),
          evidence,
          deterministic,
          generatedAt: ctx.now,
          // Insights are a view of current state; 30 days without regeneration
          // means the analysis stopped running and the card is no longer trustworthy.
          expiresAt: new Date(ctx.now.getTime() + 30 * 86_400_000),
        },
        // Regenerating must not silently un-dismiss something the user rejected,
        // so status is only seeded on first creation.
        $setOnInsert: { status: 'new' },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return insight ? { insight, deterministic } : null;
  }

  /**
   * Renders the prompt: the full product dossier, then the observations for this topic.
   *
   * The dossier is what makes the output specific to *this* product. Given only the
   * clustered signals, the model wrote prose that would read identically for a gallery
   * block and a payment gateway, because nothing in its context distinguished them. It
   * now sees the product's identity, published features, release record, real issue
   * titles and competitor set — and can therefore say what a defect means *here*.
   *
   * Grounding is unchanged. The citation allow-list still contains only this cluster's
   * signal codes, so the extra context informs the reasoning without widening what the
   * model is permitted to assert.
   */
  private static buildUserPrompt(ctx: SignalContext, cluster: SignalCluster): string {
    const label = CATEGORY_LABEL[cluster.category];

    const observations = cluster.signals
      .map((s) => {
        const lines = [
          `- CODE: ${s.code}`,
          `  DIRECTION: ${s.direction}`,
          `  SEVERITY: ${s.severity}`,
          `  FINDING: ${s.detail}`,
        ];
        if (s.metric) {
          lines.push(
            `  METRIC: ${s.metric.name} = ${s.metric.value}${s.metric.unit ? ` ${s.metric.unit}` : ''}` +
              (s.metric.delta !== undefined ? ` (change ${s.metric.delta})` : '') +
              (s.metric.window ? ` over ${s.metric.window}` : ''),
          );
        }
        for (const e of s.evidence.slice(0, 5)) {
          lines.push(`  EVIDENCE: ${e.label} = ${e.value} [${e.source}]`);
        }
        // Age is context the model can't derive from the numbers alone.
        const ageDays = Math.floor(
          (ctx.now.getTime() - new Date(s.firstDetectedAt).getTime()) / 86_400_000,
        );
        if (ageDays > 0) lines.push(`  FIRST DETECTED: ${ageDays} day(s) ago`);
        return lines.join('\n');
      })
      .join('\n');

    return `${ProductDossier.build(ctx)}

# TOPIC: ${label.title} — ${label.lens}

## OBSERVATIONS FOR THIS TOPIC (the only findings you may cite)
${observations}

# TASK
Write one insight about ${label.title.toLowerCase()} for this specific product.
- "title": a specific headline of 4–12 words. State the finding, not the topic.
- "narrative": 2–4 sentences. Lead with what is happening and the figure that shows it, then what it means for THIS product given what it does and who uses it, then what follows for what to do next. Use the product's own vocabulary where it fits. Reference the actual numbers.
- "citations": the CODE values from the OBSERVATIONS block that you relied on.

The product context above is for understanding only — you may reason from it, but every
figure you state must come from the OBSERVATIONS block or the product context verbatim.
Never estimate or extrapolate.

Return only JSON: {"title": "...", "narrative": "...", "citations": ["..."]}`;
  }

  /**
   * Builds the narrative from signal text when the LLM path is unusable.
   *
   * This is not a placeholder — the signals already contain complete, grounded
   * sentences, so a templated insight is fully accurate and merely reads more
   * mechanically. That trade is far better than the alternative of showing nothing
   * (which made the old feature look broken whenever Ollama wasn't running).
   */
  private static templateNarrative(cluster: SignalCluster): { title: string; narrative: string } {
    const label = CATEGORY_LABEL[cluster.category];
    const negatives = cluster.signals.filter((s) => s.direction === 'negative');
    const positives = cluster.signals.filter((s) => s.direction === 'positive');
    const lead = negatives[0] ?? cluster.signals[0];

    const title = lead.title;

    const parts: string[] = [lead.detail];

    const others = negatives.filter((s) => s !== lead).slice(0, 3);
    if (others.length === 1) {
      parts.push(`Alongside this: ${lowerFirst(others[0].detail)}`);
    } else if (others.length > 1) {
      parts.push(
        `${others.length} related findings compound it: ` +
          others.map((s) => lowerFirst(stripTrailingPeriod(s.detail))).join('; ') +
          '.',
      );
    }

    if (positives.length > 0 && negatives.length > 0) {
      parts.push(`On the positive side: ${lowerFirst(positives[0].detail)}`);
    }

    if (cluster.allPositive) {
      parts.push(`No ${label.title.toLowerCase()} problems were detected in this run.`);
    }

    return { title, narrative: parts.join(' ') };
  }

  /**
   * Maps signal severity onto the four-value insight severity the UI renders.
   *
   * An all-positive cluster becomes `opportunity` rather than `info` so the feed's
   * green treatment is used for genuinely good news.
   */
  private static toInsightSeverity(cluster: SignalCluster): InsightSeverity {
    if (cluster.allPositive) return 'opportunity';
    if (cluster.peakSeverity >= SEVERITY_RANK.critical) return 'critical';
    if (cluster.peakSeverity >= SEVERITY_RANK.medium) return 'warning';
    return 'info';
  }

  /**
   * Removes insights for concerns that no longer exist.
   *
   * Dismissed and acknowledged insights are left alone: the user's decision about
   * them is data, and deleting it would let the same card reappear as "new" the
   * moment the signal mix shifted.
   */
  private static async retireStale(productId: string, liveFingerprints: string[]): Promise<void> {
    await Insight.deleteMany({
      productId: new mongoose.Types.ObjectId(productId),
      fingerprint: { $nin: liveFingerprints, $exists: true, $ne: null },
      status: { $in: ['new', 'viewed'] },
    });
  }
}

interface SignalCluster {
  category: SignalCategory;
  signals: ISignal[];
  peakSeverity: number;
  allPositive: boolean;
  fingerprint: string;
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const stripTrailingPeriod = (s: string) => s.replace(/\.$/, '');
