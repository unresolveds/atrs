/**
 * The Signal vocabulary.
 *
 * A Signal is a discrete, deterministic observation about a product, computed
 * with no LLM involvement and carrying the exact numbers that justify it. This
 * is the contract that makes the rest of the intelligence layer trustworthy:
 * insights, roadmap items and competitive claims may only be built from Signals,
 * and every narrative must cite the Signal codes it drew on. If a claim can't be
 * traced to a Signal, it is a hallucination and gets rejected.
 */

/** Stable machine codes. Persisted, so renaming one is a migration. */
export const SIGNAL_CODES = [
  // Stability
  'bug.critical_open',
  'bug.inflow_exceeds_outflow',
  'bug.aging_backlog',
  'bug.spike',
  'bug.backlog_clearing',
  // Release process
  'release.dormant',
  'release.cadence_slowing',
  'release.cadence_healthy',
  'release.unreleased_backlog',
  'changelog.incomplete',
  'activity.no_recent',
  // Market traction
  'traction.installs_declining',
  'traction.installs_growing',
  'traction.installs_stalled',
  'traction.churn_gap',
  // Stated churn reasons (Freemius uninstall feedback)
  'churn.reason_concentrated',
  'churn.expectation_mismatch',
  'churn.broke_or_failed',
  'churn.lost_to_alternative',
  'churn.onboarding_confusion',
  'churn.feedback_volume_low',
  // Reputation
  'reputation.rating_low',
  'reputation.rating_declining',
  'reputation.negative_share_high',
  'reputation.thin_social_proof',
  'reputation.rating_strong',
  // Support
  'support.resolution_low',
  'support.backlog_growing',
  // Discoverability / listing quality
  'aso.listing_incomplete',
  'aso.tags_underused',
  'aso.short_description_weak',
  'aso.no_faq',
  'aso.no_screenshots',
  // Compliance & platform hygiene
  'compat.wp_tested_stale',
  'compat.php_requirement_dated',
  'security.vulnerability_present',
  'perf.heavy_memory',
  // Competitive
  'competitive.install_gap_widening',
  'competitive.outshipped',
  'competitive.rating_deficit',
  'competitive.feature_gap',
  'competitive.competitor_released',
  'competitive.category_leader',
  'competitive.no_competitors_tracked',
  // Data coverage — surfaced so users know *why* analysis is thin
  'data.no_market_link',
  'data.insufficient_history',
] as const;

export type SignalCode = (typeof SIGNAL_CODES)[number];

export type SignalCategory =
  | 'stability'
  | 'velocity'
  | 'traction'
  | 'churn'
  | 'reputation'
  | 'support'
  | 'discoverability'
  | 'compliance'
  | 'competitive'
  | 'coverage';

/** Whether the observation is good news, bad news, or context. */
export type SignalDirection = 'positive' | 'negative' | 'neutral';

export type SignalSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/**
 * One verifiable fact backing a Signal. `value` is pre-formatted for display
 * because the user needs to see the number that drove the conclusion, and
 * `source`/`ref` let them click through and check it themselves.
 */
export interface Evidence {
  label: string;
  value: string;
  /** Where the number came from, e.g. 'wp.org', 'atrs.issues', 'wphive.com'. */
  source: string;
  /** URL or entity id the user can follow to verify. */
  ref?: string;
}

/** The quantified core of a Signal, when one exists. */
export interface SignalMetric {
  name: string;
  value: number;
  unit?: string;
  /** Change versus the comparison window, when history allows. */
  delta?: number;
  /** Human label for the comparison window, e.g. '30d'. */
  window?: string;
  /** Threshold the value was tested against, so the rule stays auditable. */
  threshold?: number;
}

export interface DetectedSignal {
  code: SignalCode;
  category: SignalCategory;
  direction: SignalDirection;
  severity: SignalSeverity;
  /** Short deterministic headline — never LLM-written. */
  title: string;
  /** Deterministic explanation containing the real numbers. */
  detail: string;
  metric?: SignalMetric;
  evidence: Evidence[];
  /**
   * How much we trust the observation itself, based on data sufficiency (not on
   * how bad the news is). A trend from 2 snapshots scores lower than one from 12.
   */
  dataQuality: number;
  /** Stable identity for dedup and supersede across runs. */
  fingerprint: string;
  /** Set for competitive signals so the UI can link the rival. */
  competitorId?: string;
  detectedAt: Date;
}

/** Severity ordering for sorting and threshold comparisons. */
export const SEVERITY_RANK: Record<SignalSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Which pillar of the standout scorecard each category rolls up into. Keeping
 * this mapping beside the vocabulary means a new detector automatically lands in
 * the right pillar instead of being silently ignored.
 */
export const CATEGORY_TO_PILLAR: Record<SignalCategory, string> = {
  stability: 'productHealth',
  velocity: 'releaseDiscipline',
  traction: 'marketTraction',
  // Stated churn reasons are retention evidence, so they roll up with traction.
  churn: 'marketTraction',
  reputation: 'reputation',
  support: 'reputation',
  discoverability: 'discoverability',
  compliance: 'productHealth',
  competitive: 'competitivePosition',
  coverage: 'coverage',
};

/**
 * Builds a Signal's fingerprint.
 *
 * Identity is (product, code, discriminator) — deliberately *not* including the
 * measured value, so that "installs declining" re-detected next week updates the
 * existing signal instead of stacking a near-duplicate. Competitive signals add
 * the rival id as the discriminator so one per competitor can coexist.
 */
export function signalFingerprint(productId: string, code: SignalCode, discriminator = ''): string {
  return [productId, code, discriminator].filter(Boolean).join(':');
}

/** Formats an integer with thousands separators for evidence display. */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unknown';
  return Math.round(n).toLocaleString('en-US');
}

/** Formats a signed delta, e.g. "+320" / "-1,200". */
export function fmtDelta(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unknown';
  const r = Math.round(n);
  return `${r >= 0 ? '+' : ''}${r.toLocaleString('en-US')}`;
}

/** Formats a percentage to one decimal place. */
export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unknown';
  return `${Math.round(n * 10) / 10}%`;
}
