import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';

import { HealthScoreService } from '../services/intelligence/HealthScoreService';
import { InsightEngine } from '../services/intelligence/InsightEngine';
import { RecommendationService } from '../services/intelligence/RecommendationService';
import { RoadmapEngine } from '../services/intelligence/RoadmapEngine';
import { SignalEngine } from '../services/intelligence/SignalEngine';
import { StandoutScorecardService } from '../services/intelligence/StandoutScorecardService';
import { ReleaseReadinessService } from '../services/intelligence/ReleaseReadinessService';
import { CompetitorIntelService } from '../services/intelligence/CompetitorIntelService';
import { IntelligenceScheduler } from '../services/intelligence/IntelligenceScheduler';
import { MarketDataService } from '../services/intelligence/MarketDataService';
import { ReadmeAuditor } from '../services/intelligence/ReadmeAuditor';
import { WpOrgClient } from '../services/intelligence/wporg/WpOrgClient';
import { ChurnAnalytics } from '../services/intelligence/freemius/ChurnAnalytics';
import { FreemiusSyncService, resolveCredentials } from '../services/intelligence/freemius/FreemiusSyncService';
import { PromptRunner } from '../services/intelligence/llm/PromptRunner';

import { Insight } from '../models/Insight';
import { Recommendation } from '../models/Recommendation';
import { RoadmapItem } from '../models/RoadmapItem';
import { IntelligenceConfig } from '../models/IntelligenceConfig';
import { HealthScore } from '../models/HealthScore';
import { Product, type IProduct } from '../models/Product';

/**
 * Resolves the product for a request, enforcing ownership.
 *
 * Every handler routes through this so the admin-bypass rule lives in exactly one
 * place. It returns the product rather than a boolean because handlers need
 * `product.ownerId` — several previously passed `req.user.id` as the owner, which
 * stamped an admin's id onto another user's generated records.
 */
async function resolveProduct(req: Request, res: Response): Promise<IProduct | null> {
  const productId = req.params.productId as string;

  if (!mongoose.Types.ObjectId.isValid(productId)) {
    res.status(400).json({ message: 'Invalid product id' });
    return null;
  }

  const query: Record<string, unknown> = { _id: productId };
  if (req.user!.role !== 'admin') query.ownerId = req.user!.id;

  const product = await Product.findOne(query);
  if (!product) {
    res.status(404).json({ message: 'Product not found' });
    return null;
  }
  return product;
}

// GET /api/intelligence/:productId/health
export const getHealthScore = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const period = (req.query.period as 'daily' | 'weekly' | 'monthly') || 'weekly';

    // Reads the cached score and only recomputes when stale. The original called
    // `generateScore()` here, so every page load inserted a new document and the
    // trend comparison could never find a genuinely older score to compare against.
    const score = await HealthScoreService.getScore(
      String(product._id),
      product.ownerId.toString(),
      period,
      { force: req.query.refresh === 'true' },
    );

    res.status(200).json(score);
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/:productId/signals
export const getSignals = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const [active, resolved] = await Promise.all([
      SignalEngine.getActive(String(product._id), {
        category: req.query.category as never,
        minSeverity: req.query.minSeverity as never,
      }),
      SignalEngine.getRecentlyResolved(String(product._id), 30),
    ]);

    res.status(200).json({
      active,
      recentlyResolved: resolved,
      counts: {
        active: active.length,
        critical: active.filter((s) => s.severity === 'critical').length,
        high: active.filter((s) => s.severity === 'high').length,
        positive: active.filter((s) => s.direction === 'positive').length,
        recentlyResolved: resolved.length,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/:productId/insights
export const getInsights = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const { status, type } = req.query;
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
    const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);

    const query: Record<string, unknown> = { productId: product._id };
    if (status) query.status = status;
    if (type) query.type = type;

    const [insights, total] = await Promise.all([
      Insight.find(query)
        // _id breaks ties — one generation run stamps every insight with the
        // same generatedAt, which would page inconsistently without it.
        .sort({ generatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('signalIds', 'code severity title detail evidence firstDetectedAt'),
      Insight.countDocuments(query),
    ]);

    res.status(200).json({
      data: insights,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/intelligence/insights/:insightId
export const updateInsight = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { insightId } = req.params;
    const { status, userFeedback, userNote } = req.body ?? {};

    const query: Record<string, unknown> = { _id: insightId };
    if (req.user!.role !== 'admin') query.ownerId = req.user!.id;

    // Only set what was sent. The original spread all three unconditionally, so a
    // request updating just `status` also wrote `userFeedback: undefined`, wiping
    // feedback the user had already given.
    const update: Record<string, unknown> = {};
    if (status !== undefined) update.status = status;
    if (userFeedback !== undefined) update.userFeedback = userFeedback;
    if (userNote !== undefined) update.userNote = userNote;

    if (Object.keys(update).length === 0) {
      res.status(400).json({ message: 'No updatable fields provided' });
      return;
    }

    const insight = await Insight.findOneAndUpdate(query, { $set: update }, { new: true });
    if (!insight) {
      res.status(404).json({ message: 'Insight not found' });
      return;
    }
    res.status(200).json(insight);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/intelligence/insights/:insightId
export const deleteInsight = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const query: Record<string, unknown> = { _id: req.params.insightId };
    if (req.user!.role !== 'admin') query.ownerId = req.user!.id;

    const result = await Insight.deleteOne(query);
    if (result.deletedCount === 0) {
      res.status(404).json({ message: 'Insight not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// DELETE /api/intelligence/roadmap/:itemId
export const deleteRoadmapItem = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const query: Record<string, unknown> = { _id: req.params.itemId };
    if (req.user!.role !== 'admin') query.ownerId = req.user!.id;

    const item = await RoadmapItem.findOne(query);
    if (!item) {
      res.status(404).json({ message: 'Roadmap item not found' });
      return;
    }

    // Remove the mirrored recommendation too. Leaving it behind would resurrect the
    // same item in the recommendations list, which reads as the delete having failed.
    await Promise.all([
      RoadmapItem.deleteOne({ _id: item._id }),
      Recommendation.deleteMany({ sourceRoadmapItemId: item._id }),
    ]);

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/:productId/roadmap
export const getRoadmap = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const board = await RoadmapEngine.getBoard(String(product._id));
    const total = board.now.length + board.next.length + board.later.length + board.watch.length;

    // Generate on first view so the board is never mysteriously empty, but never
    // regenerate implicitly afterwards — that would silently discard the user's
    // horizon and status decisions on every page load.
    if (total === 0 && req.query.generate !== 'false') {
      const plan = await RoadmapEngine.generate(String(product._id), { polish: false });
      res.status(200).json({
        board: await RoadmapEngine.getBoard(String(product._id)),
        capacity: plan?.capacity ?? null,
        generated: true,
        deterministicCount: plan?.deterministicCount ?? 0,
      });
      return;
    }

    res.status(200).json({ board, capacity: null, generated: false });
  } catch (error) {
    next(error);
  }
};

// POST /api/intelligence/:productId/roadmap/regenerate
export const regenerateRoadmap = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const plan = await RoadmapEngine.generate(String(product._id), { polish: req.body?.polish !== false });
    if (!plan) {
      res.status(500).json({ message: 'Roadmap generation failed' });
      return;
    }

    res.status(200).json({
      board: await RoadmapEngine.getBoard(String(product._id)),
      capacity: plan.capacity,
      itemCount: plan.items.length,
      deterministicCount: plan.deterministicCount,
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/intelligence/roadmap/:itemId
export const updateRoadmapItem = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { itemId } = req.params;
    const { status, horizon, targetVersionLabel, shippedVersionLabel, userFeedback, userNote, note } =
      req.body ?? {};

    const query: Record<string, unknown> = { _id: itemId };
    if (req.user!.role !== 'admin') query.ownerId = req.user!.id;

    const item = await RoadmapItem.findOne(query);
    if (!item) {
      res.status(404).json({ message: 'Roadmap item not found' });
      return;
    }

    if (status !== undefined && status !== item.status) {
      item.status = status;
      item.statusHistory.push({
        status,
        changedAt: new Date(),
        changedBy: new mongoose.Types.ObjectId(req.user!.id),
        note,
      });
      // Stamp the ship date here so outcome measurement has a clock to wait on;
      // without it `measureOutcomes` would never find anything due.
      if (status === 'shipped' && !item.shippedAt) item.shippedAt = new Date();
    }

    if (horizon !== undefined) item.horizon = horizon;
    if (targetVersionLabel !== undefined) item.targetVersionLabel = targetVersionLabel;
    if (shippedVersionLabel !== undefined) item.shippedVersionLabel = shippedVersionLabel;
    if (userFeedback !== undefined) item.userFeedback = userFeedback;
    if (userNote !== undefined) item.userNote = userNote;

    await item.save();
    res.status(200).json(item);
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/:productId/recommendations
export const getRecommendations = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const { status, category, priority } = req.query;
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
    const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);

    const query: Record<string, unknown> = { productId: product._id };
    if (status) query.status = status;
    if (category) query.category = category;
    if (priority) query.priority = priority;

    const [recommendations, total] = await Promise.all([
      // Impact order, not generation order: the user wants the most valuable
      // recommendation first, which is what the scoring exists for.
      Recommendation.find(query)
        // _id breaks ties — one run shares a generatedAt and scores collide, so
        // without it a recommendation can repeat across pages.
        .sort({ impactScore: -1, generatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Recommendation.countDocuments(query),
    ]);

    res.status(200).json({
      data: recommendations,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/intelligence/recommendations/:recommendationId
export const updateRecommendation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { recommendationId } = req.params;
    const { status, userFeedback, userNote, dismissReason } = req.body ?? {};

    const query: Record<string, unknown> = { _id: recommendationId };
    if (req.user!.role !== 'admin') query.ownerId = req.user!.id;

    const recommendation = await Recommendation.findOne(query);
    if (!recommendation) {
      res.status(404).json({ message: 'Recommendation not found' });
      return;
    }

    if (status !== undefined && status !== recommendation.status) {
      recommendation.status = status;
      recommendation.statusHistory.push({
        status,
        changedAt: new Date(),
        changedBy: new mongoose.Types.ObjectId(req.user!.id),
      });
      if (status === 'accepted') {
        recommendation.acceptedAt = new Date();
        recommendation.acceptedBy = new mongoose.Types.ObjectId(req.user!.id);
      }
    }
    if (userFeedback !== undefined) recommendation.userFeedback = userFeedback;
    if (userNote !== undefined) recommendation.userNote = userNote;
    if (dismissReason !== undefined) recommendation.dismissReason = dismissReason;

    await recommendation.save();
    res.status(200).json(recommendation);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/intelligence/:productId/recommendations/:recommendationId
export const deleteRecommendation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const result = await Recommendation.deleteOne({
      _id: req.params.recommendationId,
      productId: product._id,
    });

    if (result.deletedCount === 0) {
      res.status(404).json({ message: 'Recommendation not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// POST /api/intelligence/:productId/analyze
export const triggerAnalysis = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const productId = String(product._id);
    const ownerId = product.ownerId.toString();
    const category = req.body?.category as string | undefined;

    // Category-scoped runs back the interactive buttons; omitting the category runs
    // the same full pipeline the scheduler uses, so the two paths cannot drift.
    switch (category) {
      case 'health':
        res.status(200).json({
          message: 'Health score recomputed',
          result: await HealthScoreService.generateScore(productId, ownerId, 'weekly'),
        });
        return;

      case 'signals': {
        const run = await SignalEngine.run(productId);
        res.status(200).json({
          message: run ? `${run.signals.length} signal(s) detected` : 'Signal detection failed',
          result: run ? { signals: run.signals, resolvedCount: run.resolvedCount, errors: run.errors } : null,
        });
        return;
      }

      case 'insights': {
        const result = await InsightEngine.generate(productId);
        res.status(200).json({
          message: result.llmUnavailableReason
            ? `${result.insights.length} insight(s) generated without AI narration (${result.llmUnavailableReason})`
            : `${result.insights.length} insight(s) generated`,
          result: result.insights,
          deterministicCount: result.deterministicCount,
          llmUnavailableReason: result.llmUnavailableReason,
        });
        return;
      }

      case 'roadmap': {
        const plan = await RoadmapEngine.generate(productId);
        res.status(200).json({
          message: `${plan?.items.length ?? 0} roadmap item(s) generated`,
          result: plan,
        });
        return;
      }

      case 'recommendations':
        res.status(200).json({
          message: 'Recommendations regenerated',
          result: await RecommendationService.generateRecommendations(productId, ownerId),
        });
        return;

      case undefined:
      case 'all': {
        const summary = await IntelligenceScheduler.analyzeProduct(productId);
        res.status(200).json({ message: 'Full analysis complete', result: summary });
        return;
      }

      default:
        res.status(400).json({
          message: `Unknown analysis category "${category}". Valid values: health, signals, insights, roadmap, recommendations, all.`,
        });
    }
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/:productId/scorecard
export const getScorecard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const productId = String(product._id);

    const [healthScore, insights, recommendations, signals] = await Promise.all([
      HealthScoreService.getScore(productId, product.ownerId.toString(), 'weekly'),
      Insight.find({ productId, status: { $in: ['new', 'viewed'] } }).sort({ generatedAt: -1 }).limit(5),
      Recommendation.find({ productId, status: { $in: ['generated', 'reviewed', 'accepted'] } })
        .sort({ impactScore: -1 })
        .limit(5),
      SignalEngine.getActive(productId),
    ]);

    res.status(200).json({
      productId,
      generatedAt: new Date().toISOString(),
      healthScore,
      insights,
      recommendations,
      signalSummary: {
        total: signals.length,
        critical: signals.filter((s) => s.severity === 'critical').length,
        high: signals.filter((s) => s.severity === 'high').length,
        positive: signals.filter((s) => s.direction === 'positive').length,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/:productId/standout
export const getStandoutScorecard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const scorecard = await StandoutScorecardService.generate(String(product._id), {
      // The competitive pillar needs several WordPress.org round-trips; let the
      // caller opt out when it wants a fast response.
      includeMatrix: req.query.includeMatrix !== 'false',
    });

    if (!scorecard) {
      res.status(500).json({ message: 'Scorecard generation failed' });
      return;
    }
    res.status(200).json(scorecard);
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/:productId/release-readiness
export const getReleaseReadiness = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const readiness = await ReleaseReadinessService.assess(
      String(product._id),
      req.query.version as string | undefined,
    );
    if (!readiness) {
      res.status(500).json({ message: 'Readiness assessment failed' });
      return;
    }
    res.status(200).json(readiness);
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/:productId/listing-audit
export const getListingAudit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    if (!product.wpOrgSlug) {
      res.status(200).json({
        audit: null,
        message:
          'This product has no WordPress.org slug, so its directory listing cannot be audited. ' +
          'Set the slug in the product settings to enable listing and discoverability analysis.',
      });
      return;
    }

    const [info, currentWp] = await Promise.all([
      WpOrgClient.getPlugin(product.wpOrgSlug),
      WpOrgClient.getCurrentWpVersion(),
    ]);

    if (!info) {
      res.status(200).json({
        audit: null,
        message: `WordPress.org returned no plugin for slug "${product.wpOrgSlug}". Check the slug is correct.`,
      });
      return;
    }

    res.status(200).json({ audit: ReadmeAuditor.audit(info, currentWp), currentWpVersion: currentWp });
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/:productId/market
export const getMarketData = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const series = await MarketDataService.getProductSeries(String(product._id), 90);

    if (series.length === 0) {
      res.status(200).json({
        series: [],
        trends: {},
        message: product.wpOrgSlug
          ? 'No market snapshots captured yet. Run an analysis to capture the first one.'
          : 'This product has no WordPress.org slug, so market data cannot be captured.',
      });
      return;
    }

    // Two windows so the UI can show short and medium-term movement without
    // recomputing client-side.
    const trendFor = (field: Parameters<typeof MarketDataService.computeTrend>[1]) => ({
      d30: MarketDataService.computeTrend(series, field, 30),
      d90: MarketDataService.computeTrend(series, field, 90),
    });

    res.status(200).json({
      series,
      trends: {
        activeInstalls: trendFor('activeInstalls'),
        downloaded: trendFor('downloaded'),
        meanStars: trendFor('meanStars'),
        numRatings: trendFor('numRatings'),
        supportThreads: trendFor('supportThreads'),
        ranking: trendFor('ranking'),
      },
      latest: series[0],
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/:productId/gap-analysis
export const getGapAnalysis = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;
    res.status(200).json(await CompetitorIntelService.analyzeGaps(String(product._id)));
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/:productId/matrix
export const getCompetitiveMatrix = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;
    res.status(200).json(await CompetitorIntelService.buildMatrix(String(product._id)));
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/config
export const getConfig = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ownerId = req.user!.id as string;
    let config = await IntelligenceConfig.findOne({ ownerId });
    if (!config) {
      config = await IntelligenceConfig.create({ ownerId });
    }
    res.status(200).json(config);
  } catch (error) {
    next(error);
  }
};

// PATCH /api/intelligence/config
export const updateConfig = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ownerId = req.user!.id as string;
    const updates = req.body ?? {};

    const config = await IntelligenceConfig.findOneAndUpdate(
      { ownerId },
      { $set: updates },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    res.status(200).json(config);
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/ai-status
export const getAiStatus = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Surfaced so the UI can explain why narratives read mechanically, rather than
    // leaving the user to guess whether the AI is broken.
    const probe = await PromptRunner.probe();
    res.status(200).json({
      available: probe.available,
      error: probe.error,
      note: probe.available
        ? 'AI narration is active. All figures remain computed deterministically; the model only writes the prose.'
        : 'AI narration is unavailable, so insights and roadmap items use templated wording. ' +
          'Every finding, score and priority is still computed and accurate.',
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/intelligence/portfolio
export const getPortfolioHealth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ownerId = req.user!.id as string;

    // Scope by the caller's products rather than by a field on HealthScore. The
    // original matched `HealthScore.ownerId`, which the schema did not define, so the
    // aggregation matched nothing and this endpoint returned all-zeros for every
    // user. `ownerId` now exists on the model, but deriving the product set here also
    // covers scores written before that field was added.
    const products = await Product.find({ ownerId }).select('_id name').lean();

    if (products.length === 0) {
      res.status(200).json({
        averageScore: 0,
        trend: 'stable',
        healthyProducts: 0,
        atRiskProducts: 0,
        criticalProducts: 0,
        totalProducts: 0,
        unanalyzedProducts: 0,
        products: [],
      });
      return;
    }

    const productIds = products.map((p) => p._id);

    const latestScores = await HealthScore.aggregate([
      { $match: { productId: { $in: productIds } } },
      // `computedAt`, not `generatedAt` — HealthScore has no `generatedAt` field, so
      // the original sort was a no-op and "latest" was whatever Mongo returned first.
      { $sort: { computedAt: -1 } },
      { $group: { _id: '$productId', latest: { $first: '$$ROOT' } } },
    ]);

    const nameById = new Map(products.map((p) => [String(p._id), p.name]));

    let totalScore = 0;
    let healthy = 0;
    let atRisk = 0;
    let critical = 0;
    let deltaSum = 0;
    let deltaCount = 0;

    const perProduct = latestScores.map((row: { _id: mongoose.Types.ObjectId; latest: Record<string, unknown> }) => {
      const score = Number(row.latest.overallScore) || 0;
      const delta = Number(row.latest.trendDelta) || 0;

      totalScore += score;
      if (score >= 80) healthy++;
      else if (score >= 60) atRisk++;
      else critical++;

      if (row.latest.trendDelta !== undefined) {
        deltaSum += delta;
        deltaCount++;
      }

      return {
        productId: String(row._id),
        name: nameById.get(String(row._id)) ?? 'Unknown product',
        overallScore: score,
        trend: row.latest.trend,
        trendDelta: delta,
        computedAt: row.latest.computedAt,
      };
    });

    // Portfolio trend from the mean of per-product deltas, rather than the constant
    // 'stable' the original always returned regardless of the data.
    const meanDelta = deltaCount > 0 ? deltaSum / deltaCount : 0;

    res.status(200).json({
      averageScore: perProduct.length > 0 ? Math.round(totalScore / perProduct.length) : 0,
      trend: meanDelta >= 3 ? 'improving' : meanDelta <= -3 ? 'declining' : 'stable',
      trendDelta: Math.round(meanDelta * 10) / 10,
      healthyProducts: healthy,
      atRiskProducts: atRisk,
      criticalProducts: critical,
      totalProducts: products.length,
      // Products with no score yet are counted in the total but reported separately,
      // so the average is never silently computed over a partial set and presented
      // as covering the whole portfolio.
      unanalyzedProducts: products.length - perProduct.length,
      products: perProduct.sort((a, b) => a.overallScore - b.overallScore),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/intelligence/:productId/churn
 *
 * Stated uninstall reasons for a product: counts, and the users' own words. It
 * never interprets them. `connected` is reported separately from an empty
 * result so the UI can tell "not set up" from "nobody left".
 */
export const getChurn = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    // Credentials sit on select:false fields, so re-read with them included.
    const withKeys = await Product.findById(product._id)
      .select('+freemiusPublicKey +freemiusSecretKey freemiusProductId');
    const connected = !!(withKeys && resolveCredentials(withKeys));

    // Clamped so a hand-edited query can't ask for an unbounded scan.
    const windowDays = Math.min(Math.max(Number(req.query.windowDays) || 90, 7), 365);
    const summary = await ChurnAnalytics.summarize(product._id as never, { windowDays, connected });
    res.status(200).json(summary);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/intelligence/:productId/churn/sync
 *
 * Pulls new uninstall feedback on demand, so the panel can be populated without
 * waiting for the six-hourly tick.
 */
export const syncChurn = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const product = await resolveProduct(req, res);
    if (!product) return;

    const withKeys = await Product.findById(product._id)
      .select('+freemiusPublicKey +freemiusSecretKey freemiusProductId name ownerId');
    if (!withKeys || !resolveCredentials(withKeys)) {
      res.status(400).json({ message: 'This product is not connected to Freemius.' });
      return;
    }

    const result = await FreemiusSyncService.syncProduct(withKeys);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};
