import { describe, it, expect } from 'vitest';
import {
  detectAgingBacklog,
  detectBugSpike,
  detectCriticalOpen,
  detectInflowExceedsOutflow,
  stabilityDetectors,
} from '../../services/intelligence/signals/detectors/stability';
import {
  detectDormant,
  detectIncompleteChangelog,
  velocityDetectors,
} from '../../services/intelligence/signals/detectors/velocity';
import type { SignalContext } from '../../services/intelligence/signals/context';
import type { DetectedSignal } from '../../services/intelligence/signals/types';
import type { IIssue, IssueSeverity, IssueStatus } from '../../models/Issue';
import type { IVersion } from '../../models/Version';
import type { IActivity } from '../../models/Activity';

/**
 * Tests for the pure signal detectors.
 *
 * Detectors are the foundation of the whole intelligence layer: nothing
 * downstream may assert anything a detector did not observe. So the behaviours
 * pinned here are mostly *noise floors* — the conditions under which a detector
 * deliberately stays silent. A detector that fires on two data points produces a
 * confident-sounding trend from nothing, which is exactly the failure mode the
 * Signal contract exists to prevent.
 */

const NOW = new Date('2026-07-30T00:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

/** Only the fields the detectors read are populated. */
function ctx(overrides: Partial<SignalContext>): SignalContext {
  return {
    productId: 'product-1',
    storeId: 'owner-1',
    now: NOW,
    product: {},
    issues: [],
    versions: [],
    activities: [],
    competitors: [],
    wpInfo: null,
    productSeries: [],
    listingAudit: null,
    cadence: null,
    currentWp: null,
    ownFeatures: [],
    ...overrides,
  } as unknown as SignalContext;
}

interface IssueSeed {
  id?: string;
  title?: string;
  status?: IssueStatus;
  severity?: IssueSeverity;
  createdAt?: Date;
  resolvedAt?: Date;
}

function issue(seed: IssueSeed = {}): IIssue {
  return {
    _id: seed.id ?? 'issue-1',
    title: seed.title ?? 'Something is broken',
    status: seed.status ?? 'open',
    severity: seed.severity ?? 'medium',
    createdAt: seed.createdAt ?? NOW,
    resolvedAt: seed.resolvedAt,
  } as unknown as IIssue;
}

function version(seed: { id?: string; label?: string; status?: 'released' | 'unreleased'; releasedAt?: Date; notes?: string } = {}): IVersion {
  return {
    _id: seed.id ?? 'version-1',
    label: seed.label ?? '1.0.0',
    status: seed.status ?? 'released',
    releasedAt: seed.releasedAt ?? NOW,
    notes: seed.notes ?? '',
  } as unknown as IVersion;
}

function activity(versionId: string): IActivity {
  return {
    _id: `activity-${versionId}`,
    versionId,
    type: 'feature',
    title: 'Added a thing',
    activityDate: NOW,
  } as unknown as IActivity;
}

describe('detectCriticalOpen', () => {
  it('is silent when no critical issue is open', () => {
    expect(detectCriticalOpen(ctx({ issues: [] }))).toBeNull();
    expect(
      detectCriticalOpen(
        ctx({
          issues: [
            issue({ severity: 'high' }),
            issue({ severity: 'critical', status: 'resolved', resolvedAt: daysAgo(1) }),
            issue({ severity: 'critical', status: 'closed' }),
          ],
        }),
      ),
    ).toBeNull();
  });

  it('counts in-progress issues as open', () => {
    // Work having started does not make the bug any less shipped-and-broken.
    expect(detectCriticalOpen(ctx({ issues: [issue({ severity: 'critical', status: 'in-progress' })] }))).not.toBeNull();
  });

  it('is high severity for one or two open criticals', () => {
    expect(detectCriticalOpen(ctx({ issues: [issue({ severity: 'critical' })] }))?.severity).toBe('high');
    expect(
      detectCriticalOpen(ctx({ issues: [issue({ severity: 'critical', id: 'a' }), issue({ severity: 'critical', id: 'b' })] }))
        ?.severity,
    ).toBe('high');
  });

  it('escalates to critical severity at three or more', () => {
    const signal = detectCriticalOpen(
      ctx({
        issues: ['a', 'b', 'c'].map((id) => issue({ id, severity: 'critical' })),
      }),
    );
    // A single critical is already release-blocking; three means the product is
    // on fire and the escalation has to be visible in the severity, not the prose.
    expect(signal?.severity).toBe('critical');
  });

  it('puts the real count and the oldest issue in the evidence', () => {
    const signal = detectCriticalOpen(
      ctx({
        issues: [
          issue({ id: 'new', severity: 'critical', createdAt: daysAgo(2), title: 'Recent crash' }),
          issue({ id: 'old', severity: 'critical', createdAt: daysAgo(45), title: 'Fatal on save' }),
          issue({ id: 'high', severity: 'high' }),
        ],
      }),
    );
    expect(signal?.metric).toMatchObject({ name: 'openCriticalIssues', value: 2, threshold: 1 });
    // Evidence must carry the number that drove the conclusion so the user can
    // check it rather than take it on trust.
    expect(signal?.evidence[0]).toMatchObject({ label: 'Open critical issues', value: '2' });
    expect(signal?.evidence[1].value).toBe('Fatal on save (45d)');
    expect(signal?.evidence[1].ref).toBe('old');
    expect(signal?.evidence[2]).toMatchObject({ label: 'Open high-severity issues', value: '1' });
    expect(signal?.detail).toContain('45 days');
  });
});

describe('detectInflowExceedsOutflow', () => {
  it('is silent below the four-issue noise floor', () => {
    const issues = [1, 2, 3].map((d) => issue({ id: `i${d}`, createdAt: daysAgo(d) }));
    // 3 in / 0 out is not a trend, it is a quiet week. Reporting it would make the
    // signal list unreadable and teach the user to ignore it.
    expect(detectInflowExceedsOutflow(ctx({ issues }))).toBeNull();
  });

  it('is silent when resolution keeps pace with reports', () => {
    const issues = [
      ...[1, 2, 3, 4].map((d) => issue({ id: `new${d}`, createdAt: daysAgo(d) })),
      // Reported before the window but resolved inside it — the outflow half.
      ...[5, 6, 7, 8].map((d) => issue({ id: `old${d}`, createdAt: daysAgo(d + 40), status: 'resolved', resolvedAt: daysAgo(d) })),
    ];
    expect(detectInflowExceedsOutflow(ctx({ issues }))).toBeNull();
  });

  it('fires when more issues are created than resolved', () => {
    const issues = [
      ...[1, 2, 3, 4, 5].map((d) => issue({ id: `new${d}`, createdAt: daysAgo(d) })),
      issue({ id: 'r1', createdAt: daysAgo(6), status: 'resolved', resolvedAt: daysAgo(2) }),
      issue({ id: 'r2', createdAt: daysAgo(7), status: 'resolved', resolvedAt: daysAgo(3) }),
    ];
    const signal = detectInflowExceedsOutflow(ctx({ issues }));
    expect(signal?.code).toBe('bug.inflow_exceeds_outflow');
    // 7 created against 2 resolved is a 3.5× ratio, well past the 2× escalation.
    expect(signal?.severity).toBe('high');
    expect(signal?.metric).toMatchObject({ name: 'bugNetGrowth30d', value: 5, window: '30d' });
  });

  it('ignores activity outside the 30-day window', () => {
    const issues = [1, 2, 3, 4, 5].map((d) => issue({ id: `i${d}`, createdAt: daysAgo(40 + d) }));
    expect(detectInflowExceedsOutflow(ctx({ issues }))).toBeNull();
  });

  it('reports lower data quality on a thinner sample', () => {
    const few = [1, 2, 3, 4, 5].map((d) => issue({ id: `i${d}`, createdAt: daysAgo(d) }));
    const many = Array.from({ length: 12 }, (_, i) => issue({ id: `i${i}`, createdAt: daysAgo(i + 1) }));
    // dataQuality tracks data sufficiency, not how bad the news is.
    expect(detectInflowExceedsOutflow(ctx({ issues: few }))?.dataQuality).toBe(0.75);
    expect(detectInflowExceedsOutflow(ctx({ issues: many }))?.dataQuality).toBe(1);
  });
});

describe('detectAgingBacklog', () => {
  it('is silent when severe issues are all fresh', () => {
    expect(detectAgingBacklog(ctx({ issues: [issue({ severity: 'high', createdAt: daysAgo(10) })] }))).toBeNull();
  });

  it('ignores medium and low severity however old they are', () => {
    // Aging is a triage signal about work that should have been prioritised. A
    // year-old cosmetic bug is a backlog, not a failure of triage.
    expect(
      detectAgingBacklog(
        ctx({
          issues: [issue({ severity: 'medium', createdAt: daysAgo(300) }), issue({ severity: 'low', createdAt: daysAgo(400) })],
        }),
      ),
    ).toBeNull();
  });

  it('ignores resolved severe issues however old they are', () => {
    expect(
      detectAgingBacklog(
        ctx({ issues: [issue({ severity: 'critical', createdAt: daysAgo(300), status: 'resolved', resolvedAt: daysAgo(299) })] }),
      ),
    ).toBeNull();
  });

  it('fires only past the 30-day threshold', () => {
    expect(detectAgingBacklog(ctx({ issues: [issue({ severity: 'high', createdAt: daysAgo(29) })] }))).toBeNull();
    expect(detectAgingBacklog(ctx({ issues: [issue({ severity: 'high', createdAt: daysAgo(40) })] }))?.severity).toBe('medium');
  });

  it('escalates past 120 days', () => {
    expect(detectAgingBacklog(ctx({ issues: [issue({ severity: 'critical', createdAt: daysAgo(200) })] }))?.severity).toBe('high');
  });

  it('reports the median and oldest age', () => {
    const signal = detectAgingBacklog(
      ctx({
        issues: [
          issue({ id: 'a', severity: 'high', createdAt: daysAgo(40) }),
          issue({ id: 'b', severity: 'high', createdAt: daysAgo(60) }),
          issue({ id: 'c', severity: 'critical', createdAt: daysAgo(200), title: 'Data loss on import' }),
        ],
      }),
    );
    expect(signal?.metric).toMatchObject({ name: 'agingSevereIssues', value: 3, threshold: 30 });
    expect(signal?.evidence.find((e) => e.label === 'Median age')?.value).toBe('60 days');
    expect(signal?.evidence.find((e) => e.label === 'Oldest')?.value).toContain('Data loss on import');
  });
});

describe('detectBugSpike', () => {
  it('is silent when the baseline history is too thin to compare against', () => {
    // 3 issues this week against one issue of history is not a spike, it is a
    // product with no data. Firing here would invent a "3× the normal rate" claim
    // from a sample of one.
    const issues = [
      ...[1, 2, 3].map((d) => issue({ id: `r${d}`, createdAt: daysAgo(d) })),
      issue({ id: 'base', createdAt: daysAgo(40) }),
    ];
    expect(detectBugSpike(ctx({ issues }))).toBeNull();
  });

  it('is silent below the three-issue burst floor', () => {
    const issues = [
      ...[1, 2].map((d) => issue({ id: `r${d}`, createdAt: daysAgo(d) })),
      ...[20, 30, 40, 50, 60].map((d) => issue({ id: `b${d}`, createdAt: daysAgo(d) })),
    ];
    expect(detectBugSpike(ctx({ issues }))).toBeNull();
  });

  it('is silent when the week is busy but in line with the product\'s own baseline', () => {
    // A plugin that normally gets ~10 issues a week is not spiking at 11. The
    // comparison is self-relative by design.
    const issues = [
      ...Array.from({ length: 11 }, (_, i) => issue({ id: `r${i}`, createdAt: daysAgo(1) })),
      ...Array.from({ length: 130 }, (_, i) => issue({ id: `b${i}`, createdAt: daysAgo(10 + (i % 80)) })),
    ];
    expect(detectBugSpike(ctx({ issues }))).toBeNull();
  });

  it('fires when a real baseline exists and the week is at least double it', () => {
    const issues = [
      ...[1, 2, 3, 4, 5, 6].map((d) => issue({ id: `r${d}`, createdAt: daysAgo(d) })),
      ...[20, 30, 40, 50, 60, 70, 80].map((d) => issue({ id: `b${d}`, createdAt: daysAgo(d) })),
    ];
    const signal = detectBugSpike(ctx({ issues }));
    expect(signal?.code).toBe('bug.spike');
    expect(signal?.metric?.name).toBe('issuesLast7d');
    expect(signal?.metric?.value).toBe(6);
    // The threshold that fired is recorded so the rule stays auditable.
    expect(signal?.metric?.threshold).toBeCloseTo(1.1, 1);
  });

  it('names the most recent release, since a spike usually follows one', () => {
    const issues = [
      ...[1, 2, 3, 4, 5, 6].map((d) => issue({ id: `r${d}`, createdAt: daysAgo(d) })),
      ...[20, 30, 40, 50, 60, 70, 80].map((d) => issue({ id: `b${d}`, createdAt: daysAgo(d) })),
    ];
    const signal = detectBugSpike(ctx({ issues, versions: [version({ label: '2.1.0', releasedAt: daysAgo(8) })] }));
    expect(signal?.evidence.find((e) => e.label === 'Most recent release')?.value).toBe('2.1.0 (8d ago)');
  });

  it('says so rather than guessing when no release is on record', () => {
    const issues = [
      ...[1, 2, 3, 4, 5, 6].map((d) => issue({ id: `r${d}`, createdAt: daysAgo(d) })),
      ...[20, 30, 40, 50, 60, 70, 80].map((d) => issue({ id: `b${d}`, createdAt: daysAgo(d) })),
    ];
    const signal = detectBugSpike(ctx({ issues }));
    expect(signal?.evidence.find((e) => e.label === 'Most recent release')?.value).toBe('none recorded');
  });
});

describe('detectDormant', () => {
  it('is silent when there is no release date from any source', () => {
    // Never having shipped is a setup gap, not dormancy, and we have no date to
    // count days from.
    expect(detectDormant(ctx({}))).toBeNull();
  });

  it('is silent under 90 days', () => {
    expect(detectDormant(ctx({ versions: [version({ releasedAt: daysAgo(89) })] }))).toBeNull();
  });

  it('is medium between 90 and 180 days', () => {
    expect(detectDormant(ctx({ versions: [version({ releasedAt: daysAgo(120) })] }))?.severity).toBe('medium');
  });

  it('escalates to high at 180 days', () => {
    const signal = detectDormant(ctx({ versions: [version({ releasedAt: daysAgo(180) })] }));
    expect(signal?.severity).toBe('high');
    // The thresholds are chosen because WP.org itself acts on them, so the
    // consequence is stated rather than left as a vague warning.
    expect(signal?.detail).toContain('suppresses installs');
  });

  it('escalates to critical at 365 days', () => {
    const signal = detectDormant(ctx({ versions: [version({ releasedAt: daysAgo(365) })] }));
    expect(signal?.severity).toBe('critical');
    expect(signal?.detail).toContain('eligible for closure');
    expect(signal?.metric).toMatchObject({ name: 'daysSinceLastRelease', value: 365, threshold: 90 });
  });

  it('ignores unreleased versions when finding the last release', () => {
    const signal = detectDormant(
      ctx({
        versions: [
          version({ id: 'next', label: '2.0.0', status: 'unreleased', releasedAt: undefined }),
          version({ id: 'last', label: '1.9.0', releasedAt: daysAgo(200) }),
        ],
      }),
    );
    // A drafted-but-unshipped version earns nothing and must not reset the clock.
    expect(signal?.metric?.value).toBe(200);
    expect(signal?.evidence.find((e) => e.label === 'Last released version')?.value).toBe('1.9.0');
  });
});

describe('detectIncompleteChangelog', () => {
  const releases = (n: number) => Array.from({ length: n }, (_, i) => version({ id: `v${i + 1}`, label: `1.${i}.0` }));

  it('is silent with fewer than three releases to judge', () => {
    expect(detectIncompleteChangelog(ctx({ versions: releases(2), activities: [] }))).toBeNull();
  });

  it('is silent at 80% coverage or better', () => {
    // 80% is the documented bar, so exactly 4 of 5 must not fire.
    expect(
      detectIncompleteChangelog(
        ctx({ versions: releases(5), activities: ['v1', 'v2', 'v3', 'v4'].map(activity) }),
      ),
    ).toBeNull();
  });

  it('fires below 80% coverage', () => {
    const signal = detectIncompleteChangelog(ctx({ versions: releases(5), activities: ['v1', 'v2', 'v3'].map(activity) }));
    expect(signal?.code).toBe('changelog.incomplete');
    expect(signal?.metric).toMatchObject({ name: 'changelogCoverage', value: 60, threshold: 80 });
    expect(signal?.severity).toBe('low');
  });

  it('escalates below 50% coverage', () => {
    const signal = detectIncompleteChangelog(ctx({ versions: releases(3), activities: [activity('v1')] }));
    expect(signal?.severity).toBe('medium');
    expect(signal?.title).toBe('67% of releases undocumented');
  });

  it('accepts substantial release notes in place of changelog entries', () => {
    const versions = [
      version({ id: 'v1', notes: 'Rewrote the renderer and fixed the caption overflow bug.' }),
      version({ id: 'v2', notes: 'Added the masonry layout and three new block variations.' }),
      version({ id: 'v3', notes: 'Patched the escaping issue reported on the support forum.' }),
    ];
    // Documentation is documentation wherever the author put it.
    expect(detectIncompleteChangelog(ctx({ versions, activities: [] }))).toBeNull();
  });

  it('does not accept a token one-word note as documentation', () => {
    const versions = ['v1', 'v2', 'v3'].map((id) => version({ id, notes: 'fixes' }));
    expect(detectIncompleteChangelog(ctx({ versions, activities: [] }))).not.toBeNull();
  });

  it('lists the undocumented versions by name', () => {
    const signal = detectIncompleteChangelog(
      ctx({ versions: releases(4), activities: [activity('v1')] }),
    );
    expect(signal?.evidence.find((e) => e.label === 'Undocumented versions')?.value).toBe('1.1.0, 1.2.0, 1.3.0');
  });
});

describe('every detector', () => {
  /** A context rich enough to make most detectors fire at once. */
  const busy = ctx({
    issues: [
      ...['a', 'b', 'c'].map((id) => issue({ id, severity: 'critical', createdAt: daysAgo(200) })),
      ...[1, 2, 3, 4, 5, 6].map((d) => issue({ id: `r${d}`, createdAt: daysAgo(d) })),
      ...[20, 30, 40, 50, 60, 70, 80].map((d) => issue({ id: `b${d}`, createdAt: daysAgo(d) })),
    ],
    versions: [
      version({ id: 'v1', label: '1.0.0', releasedAt: daysAgo(400) }),
      version({ id: 'v2', label: '1.1.0', releasedAt: daysAgo(420) }),
      version({ id: 'v3', label: '1.2.0', releasedAt: daysAgo(440) }),
      version({ id: 'v4', label: '2.0.0', status: 'unreleased', releasedAt: undefined }),
    ],
    activities: [activity('v1')],
  });

  const fired: DetectedSignal[] = [...stabilityDetectors, ...velocityDetectors]
    .map((detect) => detect(busy))
    .filter((s): s is DetectedSignal => s !== null);

  it('produces signals from the shared context', () => {
    expect(fired.length).toBeGreaterThan(3);
  });

  it('returns a stable fingerprint scoped to the product and code', () => {
    for (const signal of fired) {
      // Identity deliberately excludes the measured value so a re-detection next
      // week updates the existing signal instead of stacking a near-duplicate.
      expect(signal.fingerprint).toBe(`product-1:${signal.code}`);
    }
    expect(new Set(fired.map((s) => s.fingerprint)).size).toBe(fired.length);
  });

  it('reports dataQuality within 0..1', () => {
    for (const signal of fired) {
      expect(signal.dataQuality).toBeGreaterThanOrEqual(0);
      expect(signal.dataQuality).toBeLessThanOrEqual(1);
    }
  });

  it('stamps every signal with the shared run timestamp', () => {
    // One instant per run, so two detectors can never disagree about "now".
    for (const signal of fired) expect(signal.detectedAt).toBe(NOW);
  });

  it('carries at least one piece of sourced evidence', () => {
    for (const signal of fired) {
      expect(signal.evidence.length).toBeGreaterThan(0);
      for (const e of signal.evidence) expect(e.source.length).toBeGreaterThan(0);
    }
  });

  it('is silent across the board on an empty context', () => {
    // A brand-new product with no data must produce no observations at all,
    // rather than a page of confident-looking nulls-as-zeroes.
    const empty = ctx({});
    for (const detect of [...stabilityDetectors, ...velocityDetectors]) {
      expect(detect(empty)).toBeNull();
    }
  });
});
