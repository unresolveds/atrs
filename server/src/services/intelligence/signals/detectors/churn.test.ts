import { describe, it, expect } from 'vitest';
import {
  detectReasonConcentrated, detectExpectationMismatch, detectBrokeOrFailed,
  detectLostToAlternative, detectOnboardingConfusion, detectFeedbackVolumeLow,
  churnDetectors,
} from './churn';
import type { SignalContext } from '../context';

const NOW = new Date('2026-09-28T00:00:00Z');

/** One uninstall report, `daysAgo` before NOW. */
function report(reasonId: number, reason: string, daysAgo = 1, reasonInfo = '') {
  return {
    reasonId, reason, reasonInfo,
    uninstalledAt: new Date(NOW.getTime() - daysAgo * 86_400_000),
    freemiusInstallId: Math.floor(Math.random() * 1e9),
  } as any;
}

/** `n` identical reports. */
const many = (n: number, id: number, label: string, daysAgo = 1) =>
  Array.from({ length: n }, () => report(id, label, daysAgo));

function ctx(uninstalls: any[], overrides: Partial<SignalContext> = {}): SignalContext {
  return {
    productId: 'p1',
    storeId: 'o1',
    product: { freemiusProductId: '6749' } as any,
    now: NOW,
    issues: [],
    versions: [],
    activities: [],
    wpInfo: null,
    productSeries: [],
    listingAudit: null,
    cadence: null,
    currentWp: null,
    ownFeatures: [],
    uninstalls,
    competitors: [],
    ...overrides,
  } as SignalContext;
}

describe('sample-size floor', () => {
  it('stays silent below the minimum, however lopsided the reports', () => {
    // 7 identical reports would be 100% of a 7-report window.
    const c = ctx(many(7, 4, 'Broke the website'));
    expect(detectReasonConcentrated(c)).toBeNull();
    expect(detectBrokeOrFailed(c)).toBeNull();
  });

  it('reports low volume as coverage instead of silence', () => {
    const s = detectFeedbackVolumeLow(ctx(many(3, 1, 'No longer needed')));
    expect(s).not.toBeNull();
    expect(s!.category).toBe('coverage');
    expect(s!.direction).toBe('neutral');
    expect(s!.metric?.value).toBe(3);
  });

  it('says nothing about coverage for a product with no Freemius link', () => {
    const c = ctx([], { product: { freemiusProductId: '' } as any });
    expect(detectFeedbackVolumeLow(c)).toBeNull();
  });

  it('stops reporting low volume once there is enough data', () => {
    expect(detectFeedbackVolumeLow(ctx(many(8, 1, 'No longer needed')))).toBeNull();
  });
});

describe('window', () => {
  it('ignores reports older than 90 days', () => {
    const c = ctx([...many(10, 4, 'Broke the website', 200), ...many(2, 1, 'No longer needed', 1)]);
    // Only 2 recent reports remain, below the floor.
    expect(detectBrokeOrFailed(c)).toBeNull();
    expect(detectFeedbackVolumeLow(c)!.metric?.value).toBe(2);
  });
});

describe('detectReasonConcentrated', () => {
  it('fires when one reason dominates, and names the runner-up', () => {
    const s = detectReasonConcentrated(ctx([
      ...many(6, 15, 'Temporary deactivation'),
      ...many(3, 1, 'No longer needed'),
      ...many(1, 2, 'Found a better alternative'),
    ]))!;
    expect(s.code).toBe('churn.reason_concentrated');
    expect(s.metric!.value).toBe(60);
    expect(s.title).toContain('Temporary deactivation');
    expect(s.detail).toContain('No longer needed');
  });

  it('stays silent when reasons are evenly spread', () => {
    const c = ctx([
      ...many(3, 1, 'No longer needed'), ...many(3, 2, 'Found a better alternative'),
      ...many(3, 4, 'Broke the website'), ...many(3, 15, 'Temporary deactivation'),
    ]);
    expect(detectReasonConcentrated(c)).toBeNull(); // 25% each, below the 30% bar
  });

  it('escalates to high once one reason is at least half', () => {
    const s = detectReasonConcentrated(ctx([...many(10, 12, "Didn't work"), ...many(6, 1, 'No longer needed')]))!;
    expect(s.severity).toBe('high');
  });

  it('keys the fingerprint on the dominant reason, so a change is a new condition', () => {
    const a = detectReasonConcentrated(ctx([...many(10, 12, "Didn't work"), ...many(2, 1, 'x')]))!;
    const b = detectReasonConcentrated(ctx([...many(10, 4, 'Broke the website'), ...many(2, 1, 'x')]))!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('detectExpectationMismatch', () => {
  it('groups "expected something else" with "expected to work differently"', () => {
    const s = detectExpectationMismatch(ctx([
      ...many(3, 13, 'Expected something else'),
      ...many(2, 14, 'Expected to work differently'),
      ...many(5, 1, 'No longer needed'),
    ]))!;
    expect(s.code).toBe('churn.expectation_mismatch');
    expect(s.metric!.value).toBe(50);
    // Framed as a listing problem, which is the actionable part.
    expect(s.detail).toMatch(/positioning|listing/i);
  });

  it('stays silent when mismatch reports are a small minority', () => {
    expect(detectExpectationMismatch(ctx([
      ...many(1, 13, 'Expected something else'), ...many(19, 1, 'No longer needed'),
    ]))).toBeNull();
  });
});

describe('detectBrokeOrFailed', () => {
  it('counts every failure reason together and reaches critical', () => {
    const s = detectBrokeOrFailed(ctx([
      ...many(3, 4, 'Broke the website'),
      ...many(2, 5, 'Suddenly stopped working'),
      ...many(2, 8, "Didn't work after installation"),
      ...many(1, 12, "Didn't work"),
      ...many(4, 1, 'No longer needed'),
    ]))!;
    expect(s.metric!.value).toBe(67); // 8 of 12
    expect(s.severity).toBe('critical');
  });

  it('cites the issue tracker so the two sources can be compared', () => {
    const s = detectBrokeOrFailed(ctx(
      [...many(5, 4, 'Broke the website'), ...many(5, 1, 'No longer needed')],
      { issues: [{ status: 'open' }, { status: 'open' }, { status: 'closed' }] as any },
    ))!;
    const tracker = s.evidence.find((e) => e.source === 'atrs.issues')!;
    expect(tracker.value).toBe('2');
  });
});

describe('free text', () => {
  it('quotes users verbatim rather than summarising them', () => {
    const quote = 'doesnt work with youtube but makes you think it does';
    const s = detectReasonConcentrated(ctx([
      ...many(5, 7, 'Other'),
      report(7, 'Other', 1, quote),
      ...many(2, 1, 'No longer needed'),
    ]))!;
    const verbatim = s.evidence.find((e) => e.value.includes(quote));
    expect(verbatim).toBeDefined();
    expect(verbatim!.source).toBe('freemius.uninstall');
  });

  it('truncates long free text instead of dropping it', () => {
    const long = 'x'.repeat(500);
    const s = detectReasonConcentrated(ctx([...many(5, 7, 'Other'), report(7, 'Other', 1, long), ...many(2, 1, 'y')]))!;
    const quoted = s.evidence.find((e) => e.label.startsWith('In their words'))!;
    expect(quoted.value.length).toBeLessThan(200);
  });
});

describe('detectLostToAlternative / detectOnboardingConfusion', () => {
  it('flags users switching away', () => {
    const s = detectLostToAlternative(ctx([
      ...many(4, 2, 'Found a better alternative'), ...many(6, 1, 'No longer needed'),
    ]))!;
    expect(s.code).toBe('churn.lost_to_alternative');
    expect(s.evidence.some((e) => e.source === 'atrs.competitors')).toBe(true);
  });

  it('flags onboarding confusion as a docs problem', () => {
    const s = detectOnboardingConfusion(ctx([
      ...many(4, 10, "Didn't understand how it works"), ...many(6, 1, 'No longer needed'),
    ]))!;
    expect(s.detail).toMatch(/onboarding|docs/i);
  });
});

describe('contract', () => {
  it('every detector tolerates an empty context', () => {
    const empty = ctx([], { product: { freemiusProductId: '' } as any });
    for (const d of churnDetectors) expect(() => d(empty)).not.toThrow();
  });

  it('confidence reflects sample size, not severity', () => {
    const thin = detectBrokeOrFailed(ctx([...many(5, 4, 'Broke the website'), ...many(4, 1, 'x')]))!;
    const thick = detectBrokeOrFailed(ctx([...many(40, 4, 'Broke the website'), ...many(30, 1, 'x')]))!;
    expect(thick.dataQuality).toBeGreaterThan(thin.dataQuality);
  });

  it('carries a metric with its threshold, so the rule stays auditable', () => {
    const s = detectExpectationMismatch(ctx([...many(5, 13, 'Expected something else'), ...many(5, 1, 'x')]))!;
    expect(s.metric!.threshold).toBe(20);
    expect(s.metric!.window).toBe('90d');
  });
});
