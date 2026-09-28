import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Backfill paging. The property that matters is that no install is skipped when
 * the request budget runs out part-way through a page — a skipped install is
 * feedback lost for good, and it fails silently.
 */
let installPages: any[][] = [];
let uninstalls: Record<number, any> = {};
const known = new Set<number>();
const stored: number[] = [];

vi.mock('./FreemiusClient', async () => {
  const actual = await vi.importActual<any>('./FreemiusClient');
  return {
    ...actual,
    FreemiusClient: class {
      async listInstalls(offset: number) { return installPages[offset / 50] ?? []; }
      async getUninstall(id: number) { return uninstalls[id] ?? null; }
    },
  };
});

vi.mock('../../../models/UninstallFeedback', () => ({
  UninstallFeedback: {
    exists: async ({ freemiusInstallId }: any) => known.has(freemiusInstallId),
    updateOne: async (filter: any) => { stored.push(filter.freemiusInstallId); known.add(filter.freemiusInstallId); },
  },
}));

vi.mock('../../../utils/crypto', () => ({ unsealSecret: (v: string) => v }));

const { FreemiusSyncService } = await import('./FreemiusSyncService');

const product: any = {
  _id: 'p1', ownerId: 'o1', name: 'Test',
  freemiusProductId: '1', freemiusPublicKey: 'pk', freemiusSecretKey: 'sk',
};

/** A page of `n` uninstalled installs, each with feedback. */
function page(startId: number, n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: startId + i, is_uninstalled: true }));
  for (const r of rows) uninstalls[r.id] = { id: r.id, install_id: r.id, reason_id: 4, reason: 'Broke the website' };
  return rows;
}

beforeEach(() => {
  installPages = []; uninstalls = {}; known.clear(); stored.length = 0;
});

describe('backfill paging', () => {
  it('re-scans the page it ran out on instead of stepping past it', async () => {
    installPages = [page(1000, 50), page(2000, 50)];
    // 1 list call + 4 detail calls, so it stops inside the first page.
    const r = await FreemiusSyncService.backfillProduct(product, { maxRequests: 5 });
    expect(r.stored).toBe(4);
    // Must resume at the same page, not at 50.
    expect(r.nextOffset).toBe(0);
  });

  it('loses nothing across a resumed run', async () => {
    installPages = [page(1000, 50), page(2000, 50)];
    let offset = 0;
    for (let i = 0; i < 40 && offset !== undefined; i++) {
      const r: any = await FreemiusSyncService.backfillProduct(product, { startOffset: offset, maxRequests: 6 });
      offset = r.nextOffset;
      if (offset === undefined) break;
    }
    // Every install across both pages is accounted for exactly once.
    expect(new Set(stored).size).toBe(100);
    expect(stored.length).toBe(100);
  });

  it('reports completion when the collection is exhausted', async () => {
    installPages = [page(1000, 10)];
    const r = await FreemiusSyncService.backfillProduct(product, { maxRequests: 500 });
    expect(r.nextOffset).toBeUndefined();
    expect(r.stored).toBe(10);
  });

  it('counts an uninstall with no feedback without storing it', async () => {
    installPages = [[{ id: 5, is_uninstalled: true }]];
    const r = await FreemiusSyncService.backfillProduct(product, { maxRequests: 50 });
    expect(r.withoutFeedback).toBe(1);
    expect(r.stored).toBe(0);
  });

  it('skips installs that are still active without spending a request', async () => {
    installPages = [[{ id: 5, is_uninstalled: false }, { id: 6, is_uninstalled: false }]];
    const r = await FreemiusSyncService.backfillProduct(product, { maxRequests: 50 });
    expect(r.examined).toBe(0);
    expect(r.requests).toBe(1); // the list call only
  });

  it('refuses a product with no credentials', async () => {
    const r = await FreemiusSyncService.backfillProduct({ ...product, freemiusProductId: '' } as any);
    expect(r.errors[0]).toMatch(/not connected/i);
  });
});
