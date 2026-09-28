import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mongoose is mocked the way the repository tests do it, so these assertions
 * cover the derived arithmetic and the query shape without needing a database.
 */
let groupedRows: any[] = [];
let quoteRows: any[] = [];
let allTime = 0;
let latest: any = null;
/** The sort handed to the quote query — paging correctness depends on it. */
const quoteSort = vi.fn();

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
      aggregate: async () => groupedRows,
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
