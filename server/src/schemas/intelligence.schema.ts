import { z } from 'zod';
import { SIGNAL_CATEGORIES } from '../services/intelligence/signals/types';

/**
 * Request schemas for the intelligence API.
 *
 * Two conventions worth noting. Query fields arrive as strings, so anything numeric
 * is coerced here rather than parsed in each handler. And every params object is
 * declared with `.strict()`-equivalent explicit keys so a route typo surfaces as a
 * validation error instead of silently reaching Mongo as an unindexed field.
 */

/** Mongo ObjectId — rejected here so a malformed id never reaches a query. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

const productParams = z.object({ productId: objectId });

/** Bare `/:productId` routes with no query or body of their own. */
export const productParamsSchema = z.object({ params: productParams });

export const getHealthScoreSchema = z.object({
  params: productParams,
  query: z
    .object({
      period: z.enum(['daily', 'weekly', 'monthly']).optional().default('weekly'),
      /** Forces recomputation instead of serving the cached score. */
      refresh: z.enum(['true', 'false']).optional(),
    })
    .optional(),
});

export const getSignalsSchema = z.object({
  params: productParams,
  query: z
    .object({
      // Derived from the signal vocabulary rather than repeated, so a new
      // category cannot be valid in the engine but rejected by the API.
      category: z.enum(SIGNAL_CATEGORIES).optional(),
      minSeverity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
    })
    .optional(),
});

export const getInsightsSchema = z.object({
  params: productParams,
  query: z
    .object({
      status: z.enum(['new', 'viewed', 'acknowledged', 'dismissed', 'actioned']).optional(),
      type: z.string().optional(),
      severity: z.enum(['info', 'warning', 'critical', 'opportunity']).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      page: z.coerce.number().int().min(1).optional().default(1),
    })
    .optional(),
});

export const updateInsightSchema = z.object({
  params: z.object({ insightId: objectId }),
  body: z
    .object({
      status: z.enum(['new', 'viewed', 'acknowledged', 'dismissed', 'actioned']).optional(),
      userFeedback: z.enum(['helpful', 'not_helpful']).optional(),
      userNote: z.string().max(2000).optional(),
    })
    // At least one field must be present, so an empty PATCH is rejected at the edge
    // rather than becoming a no-op write.
    .refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' }),
});

export const getRecommendationsSchema = z.object({
  params: productParams,
  query: z
    .object({
      status: z
        .enum([
          'generated',
          'reviewed',
          'accepted',
          'dismissed',
          'deferred',
          'triaged',
          'in_progress',
          'implemented',
          'measured',
          'expired',
        ])
        .optional(),
      category: z.string().optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      page: z.coerce.number().int().min(1).optional().default(1),
    })
    .optional(),
});

export const updateRecommendationSchema = z.object({
  params: z.object({ recommendationId: objectId }),
  body: z
    .object({
      status: z
        .enum([
          'generated',
          'reviewed',
          'accepted',
          'dismissed',
          'deferred',
          'triaged',
          'in_progress',
          'implemented',
          'measured',
          'expired',
        ])
        .optional(),
      userFeedback: z.enum(['helpful', 'not_helpful']).optional(),
      userNote: z.string().max(2000).optional(),
      dismissReason: z.string().max(500).optional(),
    })
    .refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' }),
});

export const getRoadmapSchema = z.object({
  params: productParams,
  query: z
    .object({
      /** 'false' suppresses first-view generation, for polling callers. */
      generate: z.enum(['true', 'false']).optional(),
    })
    .optional(),
});

export const updateRoadmapItemSchema = z.object({
  params: z.object({ itemId: objectId }),
  body: z
    .object({
      status: z.enum(['proposed', 'accepted', 'in_progress', 'shipped', 'dismissed', 'deferred']).optional(),
      horizon: z.enum(['now', 'next', 'later', 'watch']).optional(),
      targetVersionLabel: z.string().max(50).optional(),
      shippedVersionLabel: z.string().max(50).optional(),
      userFeedback: z.enum(['helpful', 'not_helpful']).optional(),
      userNote: z.string().max(2000).optional(),
      note: z.string().max(500).optional(),
    })
    .refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' }),
});

export const getStandoutSchema = z.object({
  params: productParams,
  query: z
    .object({
      /** 'false' skips the competitive pillar, avoiding several WP.org round-trips. */
      includeMatrix: z.enum(['true', 'false']).optional(),
    })
    .optional(),
});

export const getReleaseReadinessSchema = z.object({
  params: productParams,
  query: z
    .object({
      version: z.string().max(50).optional(),
    })
    .optional(),
});

export const triggerAnalysisSchema = z.object({
  params: productParams,
  body: z
    .object({
      category: z
        .enum(['health', 'signals', 'insights', 'roadmap', 'recommendations', 'all'])
        .optional(),
      polish: z.boolean().optional(),
    })
    .optional(),
});

export const updateIntelligenceConfigSchema = z.object({
  body: z.object({
    autoAnalysis: z.boolean().optional(),
    analysisFrequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
    analysisHour: z.number().int().min(0).max(23).optional(),
    weights: z.record(z.string(), z.number().min(0).max(100)).optional(),
    enabledModules: z.array(z.string()).optional(),
    enabledMetricCategories: z.array(z.string()).optional(),
    notifications: z
      .object({
        anomalies: z.boolean().optional(),
        weeklyDigest: z.boolean().optional(),
        recommendations: z.boolean().optional(),
        competitorAlerts: z.boolean().optional(),
      })
      .optional(),
    maxInsightsPerRun: z.number().int().min(1).max(50).optional(),
    maxRecommendationsPerRun: z.number().int().min(1).max(20).optional(),
  }),
});

/** Retained for callers still importing the old name. */
export const getGapAnalysisSchema = productParamsSchema;
