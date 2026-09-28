import { Request, Response, NextFunction } from 'express';
import { Competitor } from '../models/Competitor';
import { CompetitorSnapshot } from '../models/CompetitorSnapshot';
import { CompetitorDiscoveryService } from '../services/intelligence/CompetitorDiscoveryService';
import { CompetitorIntelService } from '../services/intelligence/CompetitorIntelService';
import { MarketDataService } from '../services/intelligence/MarketDataService';
import { Product } from '../models/Product';
import mongoose from 'mongoose';

/**
 * Resolves the product owner for a request.
 *
 * Discovery and tracking write `storeId` onto new competitor rows, and an admin
 * acting on someone else's product must stamp the *owner's* id, not their own —
 * otherwise the created competitors become invisible to the person who owns the
 * product.
 */
async function resolveOwnerId(req: Request, res: Response): Promise<string | null> {
  const productId = req.params.productId as string;
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    res.status(400).json({ message: 'Invalid product id' });
    return null;
  }

  const query: Record<string, unknown> = { _id: productId };
  if (req.user!.role !== 'admin') query.storeId = req.user!.id;

  const product = await Product.findOne(query).select('storeId').lean();
  if (!product) {
    res.status(404).json({ message: 'Product not found' });
    return null;
  }
  return String(product.storeId);
}

// GET /api/competitors/:productId/discover
export const discoverCompetitors = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const storeId = await resolveOwnerId(req, res);
    if (!storeId) return;

    // Read-only: returns real WordPress.org plugins with live metrics and a
    // relevance score, for the user to confirm. Nothing is written.
    const result = await CompetitorIntelService.discover(req.params.productId as string, {
      limit: Math.min(parseInt(String(req.query.limit ?? '12'), 10) || 12, 30),
    });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

// POST /api/competitors/:productId/track
export const trackCompetitors = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const storeId = await resolveOwnerId(req, res);
    if (!storeId) return;

    const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs.map(String).filter(Boolean) : [];
    if (slugs.length === 0) {
      res.status(400).json({ message: 'Provide a non-empty "slugs" array of WordPress.org plugin slugs.' });
      return;
    }

    const added = await CompetitorIntelService.addDiscovered(
      req.params.productId as string,
      storeId,
      slugs.slice(0, 10),
    );

    res.status(201).json({
      added,
      // Slugs that produced nothing were either already tracked or not resolvable on
      // WordPress.org; reporting that beats silently returning a short list.
      skipped: slugs.filter((slug: string) => !added.some((c) => c.wpOrgSlug === slug.toLowerCase())),
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/competitors/:productId/sync
export const syncCompetitors = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const storeId = await resolveOwnerId(req, res);
    if (!storeId) return;

    const result = await MarketDataService.captureAllForProduct(req.params.productId as string, { force: true });
    res.status(200).json({
      productSnapshot: result.product,
      competitorSnapshots: result.competitors.length,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/competitors/:productId
export const getCompetitors = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { productId } = req.params;
    const query: any = { productId };
    if (req.user!.role !== 'admin') {
      query.storeId = req.user!.id;
    }

    const competitors = await Competitor.find(query).sort({ createdAt: -1 });
    res.status(200).json(competitors);
  } catch (error) {
    next(error);
  }
};

// GET /api/competitors/:productId/:competitorId
export const getCompetitorDetails = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { productId, competitorId } = req.params;
    const query: any = { _id: competitorId, productId };
    if (req.user!.role !== 'admin') {
      query.storeId = req.user!.id;
    }

    const competitor = await Competitor.findOne(query);
    
    if (!competitor) {
      res.status(404).json({ message: 'Competitor not found' });
      return;
    }

    // Get the latest 10 snapshots
    const snapshots = await CompetitorSnapshot.find({ competitorId })
      .sort({ capturedAt: -1 })
      .limit(10);

    res.status(200).json({ competitor, snapshots });
  } catch (error) {
    next(error);
  }
};

// POST /api/competitors/:productId
export const createCompetitor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { productId } = req.params;
    const storeId = req.user!.id;

    const competitor = new Competitor({
      ...req.body,
      productId,
      storeId,
    });

    await competitor.save();

    res.status(201).json(competitor);
  } catch (error) {
    next(error);
  }
};

// PATCH /api/competitors/:productId/:competitorId
export const updateCompetitor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { productId, competitorId } = req.params;
    const storeId = req.user!.id;

    const competitor = await Competitor.findOneAndUpdate(
      { _id: competitorId, productId, storeId },
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!competitor) {
      res.status(404).json({ message: 'Competitor not found' });
      return;
    }

    res.status(200).json(competitor);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/competitors/:productId/:competitorId
export const deleteCompetitor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { productId, competitorId } = req.params;
    const storeId = req.user!.id;

    const competitor = await Competitor.findOneAndDelete({ _id: competitorId, productId, storeId });

    if (!competitor) {
      res.status(404).json({ message: 'Competitor not found' });
      return;
    }

    // Also delete all snapshots
    await CompetitorSnapshot.deleteMany({ competitorId });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// POST /api/competitors/:productId/auto-discover
export const autoDiscoverCompetitors = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const productId = req.params.productId as string;
    let storeId = req.user!.id;

    // Admins need to discover for the actual product owner
    if (req.user!.role === 'admin') {
      const product = await mongoose.model('Product').findById(productId);
      if (!product) {
        res.status(404).json({ message: 'Product not found' });
        return;
      }
      storeId = product.storeId.toString();
    }

    const result = await CompetitorDiscoveryService.autoDiscover(productId, storeId);
    res.status(200).json({
      message: result.caveat ?? 'Auto-discovery complete',
      discoveredCount: result.added.length,
      competitors: result.added,
      // Lower-confidence matches are returned for the user to confirm rather than
      // written silently — an incorrectly tracked competitor skews every later
      // comparison, and the user is the one who knows their market.
      suggestions: result.suggestions,
      searchTerms: result.searchTerms,
    });
  } catch (error) {
    next(error);
  }
};
