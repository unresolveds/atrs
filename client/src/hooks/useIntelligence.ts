import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getHealthScore,
  getScorecard,
  getStandoutScorecard,
  getPortfolioHealth,
  getSignals,
  getMarketData,
  getListingAudit,
  getInsights,
  updateInsight,
  deleteInsight,
  deleteRoadmapItem,
  getRecommendations,
  updateRecommendation,
  deleteRecommendation,
  getRoadmap,
  regenerateRoadmap,
  updateRoadmapItem,
  getGapAnalysis,
  getCompetitiveMatrix,
  getReleaseReadiness,
  getAiStatus,
  triggerAnalysis,
  getConfig,
  updateConfig,
  type HealthScore,
  type Insight,
  type Recommendation,
  type RoadmapItem,
  type RoadmapResponse,
  type IntelligenceConfig,
  type FeatureGapAnalysis,
  type SignalsResponse,
  type StandoutScorecard,
  type ReleaseReadiness,
  type ListingAuditResponse,
  type MarketDataResponse,
  type CompetitiveMatrix,
  type AiStatus,
  getChurn,
  syncChurn,
  type ChurnSummary,
} from '../services/intelligence';

/**
 * React Query bindings for the intelligence API.
 *
 * Cache times are deliberately varied by how expensive and how volatile each
 * resource is. Anything that reaches WordPress.org (the standout scorecard, the
 * competitive matrix, gap analysis) is kept fresh for minutes rather than seconds,
 * because re-fetching on every tab switch would hammer a free public API for data
 * that changes daily at most.
 */

/** Cache windows, named so the intent is visible at each call site. */
const FRESH = 30_000; // local data, cheap to recompute
const MARKET_FRESH = 5 * 60_000; // involves WordPress.org round-trips
const HEAVY_FRESH = 10 * 60_000; // several WordPress.org round-trips

export function useHealthScore(productId: string | undefined | null, period: string = 'weekly') {
  return useQuery<HealthScore>({
    queryKey: ['intelligence', 'healthScore', productId, period],
    queryFn: () => getHealthScore(productId as string, period),
    enabled: !!productId,
    staleTime: FRESH,
  });
}

export function useScorecard(productId: string | undefined | null) {
  return useQuery({
    queryKey: ['intelligence', 'scorecard', productId],
    queryFn: () => getScorecard(productId as string),
    enabled: !!productId,
    staleTime: FRESH,
  });
}

export function useStandoutScorecard(productId: string | undefined | null, includeMatrix = true) {
  return useQuery<StandoutScorecard>({
    queryKey: ['intelligence', 'standout', productId, includeMatrix],
    queryFn: () => getStandoutScorecard(productId as string, includeMatrix),
    enabled: !!productId,
    staleTime: HEAVY_FRESH,
  });
}

export function usePortfolioHealth() {
  return useQuery({
    queryKey: ['intelligence', 'portfolio'],
    queryFn: () => getPortfolioHealth(),
    staleTime: FRESH,
  });
}

export function useSignals(
  productId: string | undefined | null,
  params?: { category?: string; minSeverity?: string },
) {
  return useQuery<SignalsResponse>({
    queryKey: ['intelligence', 'signals', productId, params],
    queryFn: () => getSignals(productId as string, params),
    enabled: !!productId,
    staleTime: FRESH,
  });
}

export function useMarketData(productId: string | undefined | null) {
  return useQuery<MarketDataResponse>({
    queryKey: ['intelligence', 'market', productId],
    queryFn: () => getMarketData(productId as string),
    enabled: !!productId,
    staleTime: MARKET_FRESH,
  });
}

export function useListingAudit(productId: string | undefined | null) {
  return useQuery<ListingAuditResponse>({
    queryKey: ['intelligence', 'listingAudit', productId],
    queryFn: () => getListingAudit(productId as string),
    enabled: !!productId,
    staleTime: MARKET_FRESH,
  });
}

export function useInsights(productId: string | undefined | null, params?: Record<string, unknown>) {
  return useQuery<{ data: Insight[]; pagination: unknown }>({
    queryKey: ['intelligence', 'insights', productId, params],
    queryFn: () => getInsights(productId as string, params),
    enabled: !!productId,
    staleTime: FRESH,
  });
}

export function useUpdateInsight() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ insightId, payload }: { insightId: string; payload: Partial<Insight> }) =>
      updateInsight(insightId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'insights'] });
      // Feedback feeds the confidence model's historical-accuracy term, so scores
      // shown elsewhere are now stale.
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'scorecard'] });
    },
  });
}

export function useDeleteInsight() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (insightId: string) => deleteInsight(insightId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'insights'] });
    },
  });
}

export function useDeleteRoadmapItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => deleteRoadmapItem(itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'roadmap'] });
      // The server also drops the mirrored recommendation, so that list is now stale.
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'recommendations'] });
    },
  });
}

export function useRecommendations(productId: string | undefined | null, params?: Record<string, unknown>) {
  return useQuery<{ data: Recommendation[]; pagination: unknown }>({
    queryKey: ['intelligence', 'recommendations', productId, params],
    queryFn: () => getRecommendations(productId as string, params),
    enabled: !!productId,
    staleTime: FRESH,
  });
}

export function useUpdateRecommendation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      recommendationId,
      payload,
    }: {
      recommendationId: string;
      payload: Partial<Recommendation>;
    }) => updateRecommendation(recommendationId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'recommendations'] });
    },
  });
}

export function useDeleteRecommendation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, recommendationId }: { productId: string; recommendationId: string }) =>
      deleteRecommendation(productId, recommendationId),
    onSuccess: (_, { productId }) => {
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'recommendations', productId] });
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'scorecard', productId] });
    },
  });
}

export function useRoadmap(productId: string | undefined | null) {
  return useQuery<RoadmapResponse>({
    queryKey: ['intelligence', 'roadmap', productId],
    queryFn: () => getRoadmap(productId as string),
    enabled: !!productId,
    staleTime: MARKET_FRESH,
  });
}

export function useRegenerateRoadmap() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, polish }: { productId: string; polish?: boolean }) =>
      regenerateRoadmap(productId, polish),
    onSuccess: (_, { productId }) => {
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'roadmap', productId] });
      // The scorecard's "biggest levers" are drawn from roadmap items.
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'standout', productId] });
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'recommendations', productId] });
    },
  });
}

export function useUpdateRoadmapItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      itemId,
      payload,
    }: {
      itemId: string;
      payload: Partial<
        Pick<
          RoadmapItem,
          'status' | 'horizon' | 'targetVersionLabel' | 'shippedVersionLabel' | 'userFeedback' | 'userNote'
        >
      > & { note?: string };
    }) => updateRoadmapItem(itemId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'roadmap'] });
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'standout'] });
    },
  });
}

export function useGapAnalysis(productId: string | undefined | null) {
  return useQuery<FeatureGapAnalysis>({
    queryKey: ['intelligence', 'gapAnalysis', productId],
    queryFn: () => getGapAnalysis(productId as string),
    enabled: !!productId,
    staleTime: HEAVY_FRESH,
  });
}

export function useCompetitiveMatrix(productId: string | undefined | null) {
  return useQuery<CompetitiveMatrix>({
    queryKey: ['intelligence', 'matrix', productId],
    queryFn: () => getCompetitiveMatrix(productId as string),
    enabled: !!productId,
    staleTime: HEAVY_FRESH,
  });
}

export function useReleaseReadiness(productId: string | undefined | null, version?: string) {
  return useQuery<ReleaseReadiness>({
    queryKey: ['intelligence', 'releaseReadiness', productId, version],
    queryFn: () => getReleaseReadiness(productId as string, version),
    enabled: !!productId,
    staleTime: MARKET_FRESH,
  });
}

export function useAiStatus() {
  return useQuery<AiStatus>({
    queryKey: ['intelligence', 'aiStatus'],
    queryFn: () => getAiStatus(),
    // A local Ollama daemon starts and stops often; keep this reasonably fresh so
    // the UI's explanation of templated wording stays accurate.
    staleTime: 60_000,
    retry: false,
  });
}

export function useTriggerAnalysis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, category }: { productId: string; category?: string }) =>
      triggerAnalysis(productId, category),
    onSuccess: (_, { productId }) => {
      // A full analysis touches every derived resource, so invalidate the whole
      // product subtree rather than listing keys that will drift out of date.
      queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === 'intelligence' && query.queryKey.includes(productId),
      });
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'portfolio'] });
    },
  });
}

export function useIntelligenceConfig() {
  return useQuery<IntelligenceConfig>({
    queryKey: ['intelligence', 'config'],
    queryFn: () => getConfig(),
  });
}

export function useUpdateIntelligenceConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (configData: Partial<IntelligenceConfig>) => updateConfig(configData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'config'] });
    },
  });
}

export function useChurn(productId: string | undefined | null, windowDays = 90) {
  return useQuery<ChurnSummary>({
    queryKey: ['intelligence', 'churn', productId, windowDays],
    queryFn: () => getChurn(productId as string, { windowDays }),
    enabled: !!productId,
    staleTime: FRESH,
  });
}

/** On-demand pull, so the panel can be filled without waiting for the scheduler. */
export function useSyncChurn(productId: string | undefined | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncChurn(productId as string),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['intelligence', 'churn', productId] });
    },
  });
}
