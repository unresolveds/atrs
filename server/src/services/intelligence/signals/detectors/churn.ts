import type { SignalContext } from '../context';
import { type DetectedSignal, fmtInt, fmtPct, signalFingerprint } from '../types';
import type { IUninstallFeedback } from '../../../../models/UninstallFeedback';

/**
 * Churn-reason detectors — read the uninstall feedback users actually wrote.
 *
 * Everything here is a count over `ctx.uninstalls`. No reason is inferred and no
 * number is estimated: if the window holds too few reports to say anything, the
 * detector returns null rather than a weak claim. The free-text a user left is
 * quoted verbatim as evidence, never summarised — summarising it is the LLM's
 * job downstream, and only over counts computed here.
 *
 * These complement `traction.churn_gap`, which infers that people are leaving
 * from download/install deltas. These say *why*, from their own words.
 */

/** Below this, one person's opinion would masquerade as a trend. */
const MIN_REPORTS = 8;
/** A single reason holding this much of the window is a concentration worth acting on. */
const CONCENTRATION = 0.3;

/** Reason ids grouped by what the team would actually do about them. */
const GROUPS = {
  /** The product did something other than what the listing implied. */
  expectation: [13, 14],
  /** It broke, or never worked. */
  broken: [4, 5, 8, 12],
  /** A competitor won. */
  alternative: [2],
  /** They couldn't figure it out. */
  confusion: [10],
} as const;

interface Tally {
  total: number;
  byReason: Map<number, { label: string; n: number; texts: string[] }>;
  windowDays: number;
  withText: number;
}

/** Counts reports in the window. Pure, so the numbers are reproducible. */
function tally(ctx: SignalContext, windowDays = 90): Tally {
  const cutoff = ctx.now.getTime() - windowDays * 86_400_000;
  const rows = (ctx.uninstalls ?? []).filter(
    (u: IUninstallFeedback) => new Date(u.uninstalledAt).getTime() >= cutoff,
  );
  const byReason = new Map<number, { label: string; n: number; texts: string[] }>();
  let withText = 0;
  for (const r of rows) {
    const cur = byReason.get(r.reasonId) ?? { label: r.reason, n: 0, texts: [] };
    cur.n++;
    const text = (r.reasonInfo || '').trim();
    if (text) {
      withText++;
      if (cur.texts.length < 3) cur.texts.push(text.replace(/\s+/g, ' ').slice(0, 140));
    }
    byReason.set(r.reasonId, cur);
  }
  return { total: rows.length, byReason, windowDays, withText };
}

/** Sums a reason group and collects its verbatim quotes. */
function group(t: Tally, ids: readonly number[]): { n: number; labels: string[]; texts: string[] } {
  let n = 0;
  const labels: string[] = [];
  const texts: string[] = [];
  for (const id of ids) {
    const hit = t.byReason.get(id);
    if (!hit) continue;
    n += hit.n;
    labels.push(`${hit.label} (${hit.n})`);
    texts.push(...hit.texts);
  }
  return { n, labels, texts };
}

/**
 * Confidence from sample size alone — not from how bad the news is. 8 reports is
 * thin, 60+ is solid; in between it scales linearly.
 */
function quality(total: number): number {
  if (total >= 60) return 0.95;
  if (total <= MIN_REPORTS) return 0.5;
  return 0.5 + (0.45 * (total - MIN_REPORTS)) / (60 - MIN_REPORTS);
}

const quote = (texts: string[]) =>
  texts.slice(0, 2).map((t, i) => ({
    label: `In their words ${i + 1}`,
    value: `"${t}"`,
    source: 'freemius.uninstall',
  }));

/** The single most-cited reason, when it dominates the window. */
export function detectReasonConcentrated(ctx: SignalContext): DetectedSignal | null {
  const t = tally(ctx);
  if (t.total < MIN_REPORTS) return null;

  const ranked = [...t.byReason.entries()].sort((a, b) => b[1].n - a[1].n);
  const [topId, top] = ranked[0];
  const share = top.n / t.total;
  if (share < CONCENTRATION) return null;

  return {
    code: 'churn.reason_concentrated',
    category: 'churn',
    direction: 'negative',
    severity: share >= 0.5 ? 'high' : 'medium',
    title: `"${top.label}" is ${fmtPct(share * 100)} of stated uninstall reasons`,
    detail:
      `Of ${fmtInt(t.total)} people who gave a reason for uninstalling in the last ${t.windowDays} days, ` +
      `${fmtInt(top.n)} chose "${top.label}". That is the largest single reason, ahead of ` +
      `${ranked[1] ? `"${ranked[1][1].label}" (${fmtInt(ranked[1][1].n)})` : 'every other reason'}.`,
    metric: {
      name: 'topUninstallReasonShare',
      value: Math.round(share * 100),
      unit: '%',
      window: `${t.windowDays}d`,
      threshold: Math.round(CONCENTRATION * 100),
    },
    evidence: [
      { label: 'Top reason', value: `${top.label} — ${fmtInt(top.n)} of ${fmtInt(t.total)}`, source: 'freemius.uninstall' },
      ...ranked.slice(1, 4).map(([, r]) => ({
        label: 'Next reason', value: `${r.label} — ${fmtInt(r.n)}`, source: 'freemius.uninstall',
      })),
      ...quote(top.texts),
    ],
    dataQuality: quality(t.total),
    // Discriminated by reason id: if the dominant reason changes, that is a new
    // condition rather than an update to the old one.
    fingerprint: signalFingerprint(ctx.productId, 'churn.reason_concentrated', String(topId)),
    detectedAt: ctx.now,
  };
}

/** People expected something else — a listing/positioning problem, not a bug. */
export function detectExpectationMismatch(ctx: SignalContext): DetectedSignal | null {
  const t = tally(ctx);
  if (t.total < MIN_REPORTS) return null;
  const g = group(t, GROUPS.expectation);
  const share = g.n / t.total;
  if (g.n < 3 || share < 0.2) return null;

  return {
    code: 'churn.expectation_mismatch',
    category: 'churn',
    direction: 'negative',
    severity: share >= 0.35 ? 'high' : 'medium',
    title: `${fmtPct(share * 100)} left because the plugin wasn't what they expected`,
    detail:
      `${fmtInt(g.n)} of ${fmtInt(t.total)} stated reasons in the last ${t.windowDays} days were ` +
      `${g.labels.join(' and ')}. These users installed deliberately and then found a gap between the ` +
      `listing and the product — which is a positioning fix on the store page, not a code fix.`,
    metric: {
      name: 'expectationMismatchShare',
      value: Math.round(share * 100),
      unit: '%',
      window: `${t.windowDays}d`,
      threshold: 20,
    },
    evidence: [
      { label: 'Mismatch reports', value: `${fmtInt(g.n)} of ${fmtInt(t.total)}`, source: 'freemius.uninstall' },
      ...g.labels.map((l) => ({ label: 'Reason', value: l, source: 'freemius.uninstall' })),
      ...quote(g.texts),
    ],
    dataQuality: quality(t.total),
    fingerprint: signalFingerprint(ctx.productId, 'churn.expectation_mismatch'),
    detectedAt: ctx.now,
  };
}

/** It broke or never worked — corroborates the stability detectors with user reports. */
export function detectBrokeOrFailed(ctx: SignalContext): DetectedSignal | null {
  const t = tally(ctx);
  if (t.total < MIN_REPORTS) return null;
  const g = group(t, GROUPS.broken);
  const share = g.n / t.total;
  if (g.n < 3 || share < 0.15) return null;

  return {
    code: 'churn.broke_or_failed',
    category: 'churn',
    direction: 'negative',
    // Users reporting a broken site is the strongest churn signal there is.
    severity: share >= 0.3 ? 'critical' : 'high',
    title: `${fmtInt(g.n)} users uninstalled because it didn't work`,
    detail:
      `${fmtInt(g.n)} of ${fmtInt(t.total)} stated reasons in the last ${t.windowDays} days were ` +
      `${g.labels.join(', ')}. Unlike an issue report, these people left rather than asking for help, ` +
      `so this count is separate from the issue tracker and will not appear there.`,
    metric: {
      name: 'failureChurnShare',
      value: Math.round(share * 100),
      unit: '%',
      window: `${t.windowDays}d`,
      threshold: 15,
    },
    evidence: [
      { label: 'Failure-related reports', value: `${fmtInt(g.n)} of ${fmtInt(t.total)}`, source: 'freemius.uninstall' },
      ...g.labels.map((l) => ({ label: 'Reason', value: l, source: 'freemius.uninstall' })),
      { label: 'Open issues in tracker', value: fmtInt(ctx.issues.filter((i) => i.status === 'open').length), source: 'atrs.issues' },
      ...quote(g.texts),
    ],
    dataQuality: quality(t.total),
    fingerprint: signalFingerprint(ctx.productId, 'churn.broke_or_failed'),
    detectedAt: ctx.now,
  };
}

/** Users naming a competitor as the reason they left. */
export function detectLostToAlternative(ctx: SignalContext): DetectedSignal | null {
  const t = tally(ctx);
  if (t.total < MIN_REPORTS) return null;
  const g = group(t, GROUPS.alternative);
  if (g.n < 3) return null;
  const share = g.n / t.total;

  return {
    code: 'churn.lost_to_alternative',
    category: 'churn',
    direction: 'negative',
    severity: share >= 0.2 ? 'high' : 'medium',
    title: `${fmtInt(g.n)} users switched to an alternative`,
    detail:
      `${fmtInt(g.n)} of ${fmtInt(t.total)} stated reasons in the last ${t.windowDays} days were ` +
      `"Found a better alternative". Where they named the alternative, it is quoted below — those names ` +
      `are competitor candidates worth tracking.`,
    metric: {
      name: 'lostToAlternativeShare',
      value: Math.round(share * 100),
      unit: '%',
      window: `${t.windowDays}d`,
    },
    evidence: [
      { label: 'Switched away', value: `${fmtInt(g.n)} of ${fmtInt(t.total)}`, source: 'freemius.uninstall' },
      { label: 'Competitors tracked in ATRS', value: fmtInt(ctx.competitors.length), source: 'atrs.competitors' },
      ...quote(g.texts),
    ],
    dataQuality: quality(t.total),
    fingerprint: signalFingerprint(ctx.productId, 'churn.lost_to_alternative'),
    detectedAt: ctx.now,
  };
}

/** They couldn't work out how to use it — a docs and first-run problem. */
export function detectOnboardingConfusion(ctx: SignalContext): DetectedSignal | null {
  const t = tally(ctx);
  if (t.total < MIN_REPORTS) return null;
  const g = group(t, GROUPS.confusion);
  if (g.n < 3) return null;
  const share = g.n / t.total;

  return {
    code: 'churn.onboarding_confusion',
    category: 'churn',
    direction: 'negative',
    severity: share >= 0.2 ? 'high' : 'medium',
    title: `${fmtInt(g.n)} users left without understanding how it works`,
    detail:
      `${fmtInt(g.n)} of ${fmtInt(t.total)} stated reasons in the last ${t.windowDays} days were ` +
      `"Didn't understand how it works". These users wanted the product enough to install it, so the ` +
      `loss is in onboarding — first-run guidance, docs, or an example — rather than in the feature set.`,
    metric: {
      name: 'onboardingConfusionShare',
      value: Math.round(share * 100),
      unit: '%',
      window: `${t.windowDays}d`,
    },
    evidence: [
      { label: 'Confusion reports', value: `${fmtInt(g.n)} of ${fmtInt(t.total)}`, source: 'freemius.uninstall' },
      ...quote(g.texts),
    ],
    dataQuality: quality(t.total),
    fingerprint: signalFingerprint(ctx.productId, 'churn.onboarding_confusion'),
    detectedAt: ctx.now,
  };
}

/**
 * Coverage signal: connected, but too few reports to analyse. Stated rather than
 * silent, so a thin churn section reads as "not enough data yet" instead of
 * "nothing wrong".
 */
export function detectFeedbackVolumeLow(ctx: SignalContext): DetectedSignal | null {
  if (!ctx.product.freemiusProductId) return null;
  const t = tally(ctx);
  if (t.total >= MIN_REPORTS) return null;

  return {
    code: 'churn.feedback_volume_low',
    category: 'coverage',
    direction: 'neutral',
    severity: 'info',
    title: 'Not enough uninstall feedback to analyse yet',
    detail:
      `${fmtInt(t.total)} uninstall reason${t.total === 1 ? '' : 's'} recorded in the last ${t.windowDays} days, ` +
      `below the ${MIN_REPORTS} needed before a share is meaningful. Roughly half of uninstalls carry no ` +
      `reason at all, and only new uninstalls are collected — run a backfill to include history.`,
    metric: { name: 'uninstallReports', value: t.total, unit: 'reports', window: `${t.windowDays}d`, threshold: MIN_REPORTS },
    evidence: [
      { label: 'Reports in window', value: fmtInt(t.total), source: 'freemius.uninstall' },
      { label: 'Minimum for analysis', value: fmtInt(MIN_REPORTS), source: 'atrs.threshold' },
    ],
    dataQuality: 1, // Counting our own rows is certain, however few there are.
    fingerprint: signalFingerprint(ctx.productId, 'churn.feedback_volume_low'),
    detectedAt: ctx.now,
  };
}

export const churnDetectors = [
  detectReasonConcentrated,
  detectExpectationMismatch,
  detectBrokeOrFailed,
  detectLostToAlternative,
  detectOnboardingConfusion,
  detectFeedbackVolumeLow,
];
