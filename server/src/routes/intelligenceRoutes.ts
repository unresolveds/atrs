import { Router } from 'express';
import * as IntelligenceController from '../controllers/IntelligenceController';
import { validate } from '../middlewares/validate';
import {
  getHealthScoreSchema,
  getInsightsSchema,
  getRecommendationsSchema,
  updateIntelligenceConfigSchema,
  productParamsSchema,
  getSignalsSchema,
  getRoadmapSchema,
  updateRoadmapItemSchema,
  updateInsightSchema,
  updateRecommendationSchema,
  getReleaseReadinessSchema,
  triggerAnalysisSchema,
  getStandoutSchema,
} from '../schemas/intelligence.schema';

const router = Router();

// Owner-level configuration and status.
router.get('/config', IntelligenceController.getConfig);
router.patch('/config', validate(updateIntelligenceConfigSchema), IntelligenceController.updateConfig);
router.get('/ai-status', IntelligenceController.getAiStatus);
router.get('/portfolio', IntelligenceController.getPortfolioHealth);

/**
 * Entity-scoped mutations are declared before the `/:productId/...` block.
 *
 * Express matches in declaration order, so `/insights/:insightId` must precede any
 * `/:productId/*` pattern that could also match it — otherwise "insights" would be
 * captured as a product id and every one of these would 400 on id validation.
 */
router.patch('/insights/:insightId', validate(updateInsightSchema), IntelligenceController.updateInsight);
router.delete('/insights/:insightId', IntelligenceController.deleteInsight);
router.patch(
  '/recommendations/:recommendationId',
  validate(updateRecommendationSchema),
  IntelligenceController.updateRecommendation,
);
router.patch('/roadmap/:itemId', validate(updateRoadmapItemSchema), IntelligenceController.updateRoadmapItem);
router.delete('/roadmap/:itemId', IntelligenceController.deleteRoadmapItem);

// Evidence layer — the deterministic facts every narrative is built from.
router.get('/:productId/signals', validate(getSignalsSchema), IntelligenceController.getSignals);

// Uninstall feedback. The GET is a read over stored rows; the POST pulls new
// ones from Freemius on demand for the product being viewed.
router.get('/:productId/churn', validate(productParamsSchema), IntelligenceController.getChurn);
router.post('/:productId/churn/sync', validate(productParamsSchema), IntelligenceController.syncChurn);
router.get('/:productId/market', validate(productParamsSchema), IntelligenceController.getMarketData);
router.get('/:productId/listing-audit', validate(productParamsSchema), IntelligenceController.getListingAudit);

// Health and scorecards.
router.get('/:productId/health', validate(getHealthScoreSchema), IntelligenceController.getHealthScore);
router.get('/:productId/scorecard', validate(productParamsSchema), IntelligenceController.getScorecard);
router.get('/:productId/standout', validate(getStandoutSchema), IntelligenceController.getStandoutScorecard);

// Insights.
router.get('/:productId/insights', validate(getInsightsSchema), IntelligenceController.getInsights);

// Recommendations. The DELETE is declared before the roadmap block only for
// readability; its path is unambiguous.
router.get(
  '/:productId/recommendations',
  validate(getRecommendationsSchema),
  IntelligenceController.getRecommendations,
);
router.delete('/:productId/recommendations/:recommendationId', IntelligenceController.deleteRecommendation);

// Roadmap.
router.get('/:productId/roadmap', validate(getRoadmapSchema), IntelligenceController.getRoadmap);
router.post(
  '/:productId/roadmap/regenerate',
  validate(productParamsSchema),
  IntelligenceController.regenerateRoadmap,
);

// Competitive intelligence.
router.get('/:productId/gap-analysis', validate(productParamsSchema), IntelligenceController.getGapAnalysis);
router.get('/:productId/matrix', validate(productParamsSchema), IntelligenceController.getCompetitiveMatrix);

// Release gate.
router.get(
  '/:productId/release-readiness',
  validate(getReleaseReadinessSchema),
  IntelligenceController.getReleaseReadiness,
);

// Analysis trigger.
router.post('/:productId/analyze', validate(triggerAnalysisSchema), IntelligenceController.triggerAnalysis);

export default router;
