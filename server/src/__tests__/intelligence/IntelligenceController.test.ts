import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getHealthScore } from '../../controllers/IntelligenceController';
import { HealthScoreService } from '../../services/intelligence/HealthScoreService';
import { Product } from '../../models/Product';
import { Request, Response } from 'express';

/**
 * `getHealthScore` now resolves and authorises the product before doing anything,
 * and reads the *cached* score rather than computing a new one.
 *
 * That second change is the important one: the handler used to call
 * `generateScore()` directly, so every page load inserted a HealthScore document.
 * Beyond the write amplification, it broke the trend calculation — which looks for a
 * prior score from before the current period — because rows arriving seconds apart
 * meant the comparison always found a near-identical score and reported "stable"
 * forever.
 */
vi.mock('../../services/intelligence/HealthScoreService', () => ({
  HealthScoreService: {
    getScore: vi.fn(),
    generateScore: vi.fn(),
  },
}));

vi.mock('../../models/Product', () => ({
  Product: {
    findOne: vi.fn(),
  },
}));

/** A real 24-hex id, since the handler validates the id before querying. */
const PRODUCT_ID = '507f1f77bcf86cd799439011';
const OWNER_ID = '507f1f77bcf86cd799439022';

function buildReq(overrides: Partial<Request> = {}): Request {
  return {
    params: { productId: PRODUCT_ID },
    query: { period: 'weekly' },
    user: { id: OWNER_ID, role: 'user' },
    ...overrides,
  } as unknown as Request;
}

function buildRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
}

describe('IntelligenceController.getHealthScore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Product.findOne).mockResolvedValue({ _id: PRODUCT_ID, storeId: OWNER_ID } as never);
  });

  it('returns the cached score for an authorised product', async () => {
    const mockScore = { overallScore: 85, trend: 'improving' };
    vi.mocked(HealthScoreService.getScore).mockResolvedValue(mockScore as never);

    const res = buildRes();
    const next = vi.fn();
    await getHealthScore(buildReq(), res, next);

    expect(HealthScoreService.getScore).toHaveBeenCalledWith(PRODUCT_ID, OWNER_ID, 'weekly', { force: false });
    // A read endpoint must not write; the old handler did.
    expect(HealthScoreService.generateScore).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(mockScore);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes the product owner id, not the requesting admin id', async () => {
    // An admin inspecting someone else's product must not have their own id stamped
    // onto the generated records.
    vi.mocked(Product.findOne).mockResolvedValue({ _id: PRODUCT_ID, storeId: OWNER_ID } as never);
    vi.mocked(HealthScoreService.getScore).mockResolvedValue({ overallScore: 70 } as never);

    const req = buildReq({ user: { id: 'adminUserId', role: 'admin' } as never });
    await getHealthScore(req, buildRes(), vi.fn());

    expect(HealthScoreService.getScore).toHaveBeenCalledWith(PRODUCT_ID, OWNER_ID, 'weekly', { force: false });
  });

  it('recomputes when refresh=true is requested', async () => {
    vi.mocked(HealthScoreService.getScore).mockResolvedValue({ overallScore: 70 } as never);

    const req = buildReq({ query: { period: 'monthly', refresh: 'true' } as never });
    await getHealthScore(req, buildRes(), vi.fn());

    expect(HealthScoreService.getScore).toHaveBeenCalledWith(PRODUCT_ID, OWNER_ID, 'monthly', { force: true });
  });

  it('rejects a malformed product id before querying', async () => {
    const res = buildRes();
    await getHealthScore(buildReq({ params: { productId: 'not-an-id' } as never }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(Product.findOne).not.toHaveBeenCalled();
    expect(HealthScoreService.getScore).not.toHaveBeenCalled();
  });

  it('404s when the product is not visible to the caller', async () => {
    vi.mocked(Product.findOne).mockResolvedValue(null as never);

    const res = buildRes();
    await getHealthScore(buildReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(HealthScoreService.getScore).not.toHaveBeenCalled();
  });

  it('forwards service errors to the error handler', async () => {
    const error = new Error('Service failed');
    vi.mocked(HealthScoreService.getScore).mockRejectedValue(error);

    const next = vi.fn();
    await getHealthScore(buildReq(), buildRes(), next);

    expect(next).toHaveBeenCalledWith(error);
  });
});
