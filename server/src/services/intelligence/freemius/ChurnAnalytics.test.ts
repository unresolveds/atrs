import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mongoose is mocked the way the repository tests do it, so these assertions
 * cover the derived arithmetic and the query shape without needing a database.
 */
let groupedRows: any[] = [];
let versionRows: any[] = [];
let trendRows: any[] = [];
let quoteRows: any[] = [];
let allTime = 0;
let latest: any = null;
/** The sort handed to the quote query — paging correctness depends on it. */
const quoteSort = vi.fn();

/**
 * Three aggregations run per call (reasons, versions, months). They are told
 * apart by their `$group._id`, so the mock cannot silently feed reason rows to
 * the trend and appear to pass.
 */
function aggregateFor(pipeline: any[]): any[] {
  const id = pipeline.find((s) => s.$group)?.$group?._id;
  if (id === '$version') return versionRows;
  if (id && typeof id === 'object' && id.$dateToString) return trendRows;
  return groupedRows;
}

vi.mock('../../../models/UninstallFeedback', () => {
  const findChain: any = {
    sort: (s: any) => { quoteSort(s); return findChain; },
    limit: () => findChain,
    select: () => findChain,
    lean: async () => quoteRows,
  };
  const findOneChain: any = {
    sort: () => findOneChain,
    select: () => findOneChain,
    lean: async () => latest,
  };
  return {
    UninstallFeedback: {
      aggregate: async (pipeline: any[]) => aggregateFor(pipeline),
      find: () => findChain,
      findOne: () => findOneChain,
      countDocuments: async () => allTime,
    },
  };
});

const { ChurnAnalytics } = await import('./ChurnAnalytics');
const PID = '507f1f77bcf86cd799439011';

beforeEach(() => {
  groupedRows = [];
  versionRows = [];
  trendRows = [];
  quoteRows = [];
  allTime = 0;
  latest = null;
  quoteSort.mockClear();
});

describe('breakdown arithmetic', () => {
  it('computes each share against the window total', async () => {
    groupedRows = [
      { _id: 15, reason: 'Temporary deactivation', count: 5, withText: 0 },
      { _id: 4, reason: 'Broke the website', count: 3, withText: 1 },
      { _id: 1, reason: 'No longer needed', count: 2, withText: 0 },
    ];
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.total).toBe(10);
    expect(s.breakdown.map((b) => b.share)).toEqual([50, 30, 20]);
  });

  it('keeps counts consistent with the total it reports', async () => {
    groupedRows = [
      { _id: 7, reason: 'Other', count: 4, withText: 4 },
      { _id: 2, reason: 'Found a better alternative', count: 1, withText: 0 },
    ];
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.breakdown.reduce((a, b) => a + b.count, 0)).toBe(s.total);
  });

  it('sums withText across reasons', async () => {
    groupedRows = [
      { _id: 7, reason: 'Other', count: 4, withText: 4 },
      { _id: 13, reason: 'Expected something else', count: 3, withText: 1 },
    ];
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.withText).toBe(5);
  });

  it('returns zeroes rather than NaN for an empty window', async () => {
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.total).toBe(0);
    expect(s.breakdown).toEqual([]);
    expect(s.withText).toBe(0);
    // A share of NaN would render as "NaN%" in the panel.
    expect(s.breakdown.every((b) => Number.isFinite(b.share))).toBe(true);
  });

  it('falls back to a readable label when the API returned none', async () => {
    groupedRows = [{ _id: 99, reason: '', count: 2, withText: 0 }];
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.breakdown[0].reason).toBe('Reason 99');
  });
});

describe('quotes', () => {
  it('maps stored rows onto the panel shape', async () => {
    quoteRows = [{
      reasonId: 7, reason: 'Other', reasonInfo: 'Cannot work in m3u8',
      uninstalledAt: new Date('2026-09-20'), version: '1.2.3',
    }];
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.quotes[0]).toMatchObject({ reason: 'Other', text: 'Cannot work in m3u8', version: '1.2.3' });
  });

  it('omits an empty version rather than showing "v"', async () => {
    quoteRows = [{ reasonId: 7, reason: 'Other', reasonInfo: 'x', uninstalledAt: new Date(), version: '' }];
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.quotes[0].version).toBeUndefined();
  });

  it('sorts with an _id tiebreaker so paging cannot repeat or skip rows', async () => {
    await ChurnAnalytics.summarize(PID);
    expect(quoteSort).toHaveBeenCalled();
    const sort = quoteSort.mock.calls[0][0];
    expect(Object.keys(sort)).toContain('_id');
  });
});

describe('coverage reporting', () => {
  it('reports connection state independently of whether rows exist', async () => {
    const off = await ChurnAnalytics.summarize(PID, { connected: false });
    expect(off.connected).toBe(false);
    expect(off.total).toBe(0);
    // "Not connected" and "connected but quiet" must stay distinguishable.
    const on = await ChurnAnalytics.summarize(PID, { connected: true });
    expect(on.connected).toBe(true);
  });

  it('reports the all-time count so an empty window is explainable', async () => {
    allTime = 42;
    const s = await ChurnAnalytics.summarize(PID, { windowDays: 30 });
    expect(s.total).toBe(0);
    expect(s.totalAllTime).toBe(42);
    expect(s.windowDays).toBe(30);
  });

  it('passes the most recent report date through', async () => {
    latest = { uninstalledAt: new Date('2026-09-26T21:40:43Z') };
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.lastReportAt).toEqual(new Date('2026-09-26T21:40:43Z'));
  });

  it('defaults to a 90-day window', async () => {
    expect((await ChurnAnalytics.summarize(PID)).windowDays).toBe(90);
  });
});

describe('actionable buckets', () => {
  it('splits reasons by what can be done about them', async () => {
    groupedRows = [
      { _id: 4, reason: 'Broke the website', count: 3, withText: 0 },   // product
      { _id: 12, reason: "Didn't work", count: 2, withText: 0 },        // product
      { _id: 13, reason: 'Expected something else', count: 2, withText: 0 }, // positioning
      { _id: 2, reason: 'Found a better alternative', count: 1, withText: 0 }, // competitive
      { _id: 15, reason: 'Temporary deactivation', count: 2, withText: 0 },   // unactionable
    ];
    const s = await ChurnAnalytics.summarize(PID);
    const by = (b: string) => s.buckets.find((x) => x.bucket === b);
    expect(by('product')!.count).toBe(5);
    expect(by('positioning')!.count).toBe(2);
    expect(by('competitive')!.count).toBe(1);
    expect(by('unactionable')!.count).toBe(2);
    // Buckets partition the window; nothing is counted twice or lost.
    expect(s.buckets.reduce((a, b) => a + b.count, 0)).toBe(s.total);
  });

  it('does not count a temporary deactivation as a product failure', async () => {
    groupedRows = [{ _id: 15, reason: 'Temporary deactivation', count: 9, withText: 0 }];
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.buckets.find((b) => b.bucket === 'product')).toBeUndefined();
    expect(s.buckets[0].bucket).toBe('unactionable');
  });

  it('treats an unrecognised reason id as unactionable rather than blaming the product', async () => {
    // Freemius adds reasons over time; a new id must not inflate the failure count.
    groupedRows = [{ _id: 999, reason: 'Some new reason', count: 4, withText: 0 }];
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.buckets[0].bucket).toBe('unactionable');
  });

  it('ranks buckets by size and lists the reasons behind each', async () => {
    groupedRows = [
      { _id: 1, reason: 'No longer needed', count: 1, withText: 0 },
      { _id: 4, reason: 'Broke the website', count: 5, withText: 0 },
    ];
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.buckets[0].bucket).toBe('product');
    expect(s.buckets[0].reasons[0]).toEqual({ reason: 'Broke the website', count: 5 });
  });
});

describe('by version', () => {
  it('reports totals and how many blamed the product', async () => {
    groupedRows = [{ _id: 4, reason: 'Broke the website', count: 10, withText: 0 }];
    versionRows = [
      { _id: '1.2.3', count: 7, productFailures: 6 },
      { _id: '1.2.2', count: 3, productFailures: 1 },
    ];
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.byVersion[0]).toEqual({ version: '1.2.3', count: 7, productFailures: 6, share: 70 });
    expect(s.byVersion[1].share).toBe(30);
  });

  it('is empty when no report carried a version', async () => {
    expect((await ChurnAnalytics.summarize(PID)).byVersion).toEqual([]);
  });
});

describe('trend', () => {
  it('passes monthly buckets through oldest first', async () => {
    trendRows = [
      { _id: '2026-07', total: 4, productFailures: 1 },
      { _id: '2026-08', total: 9, productFailures: 5 },
    ];
    const s = await ChurnAnalytics.summarize(PID);
    expect(s.trend.map((t) => t.month)).toEqual(['2026-07', '2026-08']);
    expect(s.trend[1].productFailures).toBe(5);
  });
});
