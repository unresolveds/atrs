import { api } from './api';

/**
 * Client bindings for the intelligence API.
 *
 * The types here mirror the server's evidence-first design: anything the AI wrote
 * is accompanied by the deterministic facts behind it (`evidence`, `signalCodes`,
 * `confidenceBreakdown`, `rice`), and `deterministic` flags the cases where the
 * narrative was templated because no language model was reachable. The UI uses those
 * fields to show users *why* a claim is being made rather than asking for trust.
 */

/** A single verifiable fact supporting a claim. */
export interface Evidence {
  label: string;
  value: string;
  source: string;
  ref?: string;
}

export type SignalSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type SignalDirection = 'positive' | 'negative' | 'neutral';
export type SignalCategory =
  | 'stability'
  | 'velocity'
  | 'traction'
  | 'reputation'
  | 'support'
  | 'discoverability'
  | 'compliance'
  | 'competitive'
  | 'coverage';

export interface Signal {
  _id: string;
  code: string;
  category: SignalCategory;
  direction: SignalDirection;
  severity: SignalSeverity;
  title: string;
  detail: string;
  metric?: {
    name: string;
    value: number;
    unit?: string;
    delta?: number;
    window?: string;
    threshold?: number;
  };
  evidence: Evidence[];
  /** How much the observation itself can be trusted, based on data sufficiency. */
  dataQuality: number;
  active: boolean;
  firstDetectedAt: string;
  lastDetectedAt: string;
  resolvedAt?: string;
  observationCount: number;
  competitorId?: string;
}

export interface SignalsResponse {
  active: Signal[];
  recentlyResolved: Signal[];
  counts: {
    active: number;
    critical: number;
    high: number;
    positive: number;
    recentlyResolved: number;
  };
}

export interface HealthScore {
  _id: string;
  productId: string;
  overallScore: number;
  breakdown: Record<string, number>;
  metrics?: Record<string, unknown>;
  trend: 'improving' | 'stable' | 'declining';
  trendDelta: number;
  period: string;
  computedAt: string;
}

export interface Insight {
  _id: string;
  productId: string;
  type: string;
  severity: 'info' | 'warning' | 'critical' | 'opportunity';
  title: string;
  narrative: string;
  confidence: number;
  /** How the confidence figure was derived, so the user can challenge it. */
  confidenceBreakdown?: {
    dataDensity: number;
    historicalAccuracy: number;
    groundedness: number;
    explanation: string;
  };
  signalCodes?: string[];
  signalIds?: Array<string | Signal>;
  evidence?: Evidence[];
  /** True when the wording was templated rather than model-written. */
  deterministic?: boolean;
  status: string;
  userFeedback?: 'helpful' | 'not_helpful';
  userNote?: string;
  generatedAt: string;
}

export interface Recommendation {
  _id: string;
  productId: string;
  title: string;
  description: string;
  rationale: string;
  actionItems: string[];
  category: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  confidence: number;
  impactScore: number;
  estimatedEffort: string;
  estimatedROI: string;
  estimatedHealthDelta: number;
  status: string;
  generatedAt: string;
  sourceMetrics?: Record<string, unknown>;
}

export type RoadmapHorizon = 'now' | 'next' | 'later' | 'watch';
export type RoadmapStatus = 'proposed' | 'accepted' | 'in_progress' | 'shipped' | 'dismissed' | 'deferred';

/** RICE factors, each carrying the reasoning that produced it. */
export interface RiceScore {
  reach: number;
  impact: number;
  confidence: number;
  effort: number;
  score: number;
  reachBasis: string;
  impactBasis: string;
  confidenceBasis: string;
  effortBasis: string;
}

export interface RoadmapItem {
  _id: string;
  productId: string;
  title: string;
  description: string;
  rationale: string;
  horizon: RoadmapHorizon;
  category: string;
  rice: RiceScore;
  rank: number;
  actionItems: string[];
  acceptanceCriteria: string[];
  /** A checkable prediction, measured automatically after shipping. */
  expectedOutcome?: {
    metric: string;
    direction: 'increase' | 'decrease' | 'resolve';
    targetValue?: number;
    unit?: string;
    statement: string;
    measureAfterDays: number;
  };
  sourceSignalCodes: string[];
  sourceIssueIds: string[];
  evidence: Evidence[];
  deterministic: boolean;
  status: RoadmapStatus;
  targetVersionLabel?: string;
  shippedVersionLabel?: string;
  shippedAt?: string;
  outcomeMeasuredAt?: string;
  outcomeAchieved?: boolean;
  outcomeNote?: string;
  userFeedback?: 'helpful' | 'not_helpful';
  userNote?: string;
  generatedAt: string;
}

export interface RoadmapCapacity {
  weeklyPersonWeeks: number;
  basis: string;
  nowCapacityWeeks: number;
  nextCapacityWeeks: number;
  nowCommittedWeeks: number;
  nextCommittedWeeks: number;
}

export interface RoadmapResponse {
  board: Record<RoadmapHorizon, RoadmapItem[]>;
  capacity: RoadmapCapacity | null;
  generated?: boolean;
  itemCount?: number;
  deterministicCount?: number;
}

export type PillarKey =
  | 'productHealth'
  | 'discoverability'
  | 'reputation'
  | 'marketTraction'
  | 'releaseDiscipline'
  | 'competitivePosition';

export interface SubMetric {
  key: string;
  label: string;
  value: string;
  /** Null when this input could not be measured — never shown as zero. */
  score: number | null;
  weight: number;
  basis: string;
}

export interface Pillar {
  key: PillarKey;
  label: string;
  premise: string;
  score: number | null;
  weight: number;
  subMetrics: SubMetric[];
  signalCodes: string[];
  unmeasuredCount: number;
}

export interface Lever {
  rank: number;
  title: string;
  pillar: PillarKey;
  potentialGain: number;
  riceScore: number | null;
  roadmapItemId: string | null;
  reasoning: string;
  effortWeeks: number | null;
}

export interface StandoutScorecard {
  productId: string;
  productName: string;
  overallScore: number;
  /** Share of scorecard inputs that could actually be measured. */
  dataCoverage: number;
  coverageCaveat?: string;
  pillars: Pillar[];
  levers: Lever[];
  strengths: string[];
  generatedAt: string;
}

export type CheckGrade = 'blocker' | 'warning' | 'info' | 'pass';

export interface ReadinessCheck {
  id: string;
  label: string;
  grade: CheckGrade;
  finding: string;
  rule: string;
  action?: string;
  refs?: string[];
}

export interface ReleaseReadiness {
  productId: string;
  versionLabel: string | null;
  verdict: 'ready' | 'ready_with_warnings' | 'blocked';
  score: number;
  blockers: ReadinessCheck[];
  warnings: ReadinessCheck[];
  passed: ReadinessCheck[];
  info: ReadinessCheck[];
  generatedAt: string;
}

export type AuditStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface AuditCheck {
  id: string;
  label: string;
  status: AuditStatus;
  finding: string;
  rule: string;
  points: number;
  weight: number;
  fix?: string;
}

export interface ListingAuditResponse {
  audit: {
    slug: string;
    score: number;
    checks: AuditCheck[];
    topOpportunities: AuditCheck[];
    auditedAt: string;
  } | null;
  currentWpVersion?: string | null;
  message?: string;
}

export interface MatrixRow {
  subject: 'product' | 'competitor';
  competitorId?: string;
  name: string;
  slug: string | null;
  url: string | null;
  activeInstalls: number | null;
  downloaded: number | null;
  meanStars: number | null;
  numRatings: number;
  negativeReviewShare: number | null;
  supportResolutionRate: number | null;
  lastUpdated: string | null;
  daysSinceRelease: number | null;
  medianDaysBetweenReleases: number | null;
  testedUpTo: string | null;
  requiresPhp: string | null;
  featureCount: number;
  screenshotCount: number | null;
  installTrend30d: number | null;
  /** Explains a blank row rather than leaving it mysteriously empty. */
  unmeasurableReason?: string;
}

export interface MatrixVerdict {
  metric: string;
  label: string;
  ours: string;
  bestCompetitor: string;
  bestCompetitorName: string | null;
  standing: 'ahead' | 'behind' | 'level' | 'unknown';
  note: string;
}

export interface CompetitiveMatrix {
  productId: string;
  rows: MatrixRow[];
  verdicts: MatrixVerdict[];
  measuredCount: number;
  unmeasured: Array<{ name: string; reason: string }>;
  generatedAt: string;
}

export interface FeatureGapAnalysis {
  productId: string;
  generatedAt: string;
  summary: string;
  marketPositioning: string;
  strategicRecommendations: string[];
  deterministic: boolean;
  matrix: CompetitiveMatrix;
  competitors: Array<{
    competitorId: string;
    name: string;
    slug: string | null;
    /** Certainty is carried because lexical matching cannot be sure. */
    missingFeatures: Array<{ feature: string; certainty: 'high' | 'medium' | 'low' }>;
    differentiators: string[];
    advantages: string[];
    disadvantages: string[];
    featureCoverage: number;
    featureSource: 'readme' | 'manual' | 'none';
  }>;
  sharedGaps: Array<{ feature: string; competitors: string[]; certainty: 'high' | 'medium' | 'low' }>;
  /** Stated limitations, so thin analysis is never mistaken for a clean bill. */
  caveats: string[];
}

export interface MarketTrend {
  metric: string;
  current: number | null;
  previous: number | null;
  delta: number | null;
  pctChange: number | null;
  dataPoints: number;
  spanDays: number;
  window: string;
}

export interface MarketSnapshot {
  _id: string;
  wpOrgSlug: string;
  activeInstalls: number | null;
  downloaded: number | null;
  rating: number | null;
  numRatings: number;
  meanStars: number | null;
  supportThreads: number | null;
  supportThreadsResolved: number | null;
  version: string | null;
  lastUpdated: string | null;
  testedUpTo: string | null;
  wpVersionLag: number | null;
  ranking: number | null;
  memoryUsage: string | null;
  speedSeconds: number | null;
  vulnerabilitiesPresent: number | null;
  capturedAt: string;
}

export interface MarketDataResponse {
  series: MarketSnapshot[];
  trends: Record<string, { d30: MarketTrend; d90: MarketTrend }>;
  latest?: MarketSnapshot;
  message?: string;
}

export interface DiscoveredCompetitor {
  slug: string;
  name: string;
  url: string;
  shortDescription: string;
  author: string | null;
  activeInstalls: number | null;
  rating: number | null;
  numRatings: number;
  lastUpdated: string | null;
  tags: string[];
  /** 0–100 likelihood this is a genuine competitor. */
  relevance: number;
  /** Why it scored that way, so the suggestion is judgeable. */
  relevanceBasis: string[];
  matchedVia: string[];
  alreadyTracked: boolean;
  suggestedType: 'direct' | 'indirect' | 'alternative';
}

export interface DiscoverResponse {
  candidates: DiscoveredCompetitor[];
  searchTerms: string[];
  caveat?: string;
}

export interface PortfolioHealth {
  averageScore: number;
  trend: string;
  trendDelta?: number;
  healthyProducts: number;
  atRiskProducts: number;
  criticalProducts: number;
  totalProducts: number;
  /** Products counted in the total but with no score yet. */
  unanalyzedProducts?: number;
  products?: Array<{
    productId: string;
    name: string;
    overallScore: number;
    trend: string;
    trendDelta: number;
    computedAt: string;
  }>;
}

export interface AiStatus {
  available: boolean;
  error?: string;
  note: string;
}

export interface Scorecard {
  productId: string;
  generatedAt: string;
  healthScore: HealthScore;
  insights: Insight[];
  recommendations: Recommendation[];
  signalSummary?: {
    total: number;
    critical: number;
    high: number;
    positive: number;
  };
}

export interface IntelligenceConfig {
  autoAnalysis: boolean;
  analysisFrequency: 'daily' | 'weekly' | 'monthly';
  analysisHour: number;
  weights: {
    bugHealth: number;
    releaseHealth: number;
    featureVelocity: number;
    issueResolution: number;
    productActivity: number;
    changelogQuality: number;
  };
  enabledModules: Array<'health' | 'insights' | 'recommendations' | 'competitors' | 'portfolio'>;
  enabledMetricCategories: Array<'product_health' | 'engineering' | 'ai_eval'>;
  notifications: {
    anomalies: boolean;
    weeklyDigest: boolean;
    recommendations: boolean;
    competitorAlerts: boolean;
  };
}

// --- Evidence layer ---------------------------------------------------------

export const getSignals = async (
  productId: string,
  params?: { category?: string; minSeverity?: string },
): Promise<SignalsResponse> => {
  const { data } = await api.get(`/intelligence/${productId}/signals`, { params });
  return data;
};

export const getMarketData = async (productId: string): Promise<MarketDataResponse> => {
  const { data } = await api.get(`/intelligence/${productId}/market`);
  return data;
};

export const getListingAudit = async (productId: string): Promise<ListingAuditResponse> => {
  const { data } = await api.get(`/intelligence/${productId}/listing-audit`);
  return data;
};

// --- Health and scorecards --------------------------------------------------

export const getHealthScore = async (productId: string, period = 'weekly'): Promise<HealthScore> => {
  const { data } = await api.get(`/intelligence/${productId}/health`, { params: { period } });
  return data;
};

export const getScorecard = async (productId: string): Promise<Scorecard> => {
  const { data } = await api.get(`/intelligence/${productId}/scorecard`);
  return data;
};

export const getStandoutScorecard = async (
  productId: string,
  includeMatrix = true,
): Promise<StandoutScorecard> => {
  const { data } = await api.get(`/intelligence/${productId}/standout`, {
    params: { includeMatrix: includeMatrix ? 'true' : 'false' },
  });
  return data;
};

export const getPortfolioHealth = async (): Promise<PortfolioHealth> => {
  const { data } = await api.get(`/intelligence/portfolio`);
  return data;
};

// --- Insights ---------------------------------------------------------------

export const getInsights = async (
  productId: string,
  params?: Record<string, unknown>,
): Promise<{ data: Insight[]; pagination: unknown }> => {
  const { data } = await api.get(`/intelligence/${productId}/insights`, { params });
  return data;
};

export const updateInsight = async (insightId: string, payload: Partial<Insight>): Promise<Insight> => {
  const { data } = await api.patch(`/intelligence/insights/${insightId}`, payload);
  return data;
};

/**
 * Removes an insight outright.
 *
 * A later analysis run can surface the same finding again if the underlying condition
 * still holds — deleting clears the card, it does not suppress the detector.
 */
export const deleteInsight = async (insightId: string): Promise<void> => {
  await api.delete(`/intelligence/insights/${insightId}`);
};

// --- Roadmap ----------------------------------------------------------------

export const getRoadmap = async (productId: string): Promise<RoadmapResponse> => {
  const { data } = await api.get(`/intelligence/${productId}/roadmap`);
  return data;
};

export const regenerateRoadmap = async (productId: string, polish = true): Promise<RoadmapResponse> => {
  const { data } = await api.post(`/intelligence/${productId}/roadmap/regenerate`, { polish });
  return data;
};

export const updateRoadmapItem = async (
  itemId: string,
  payload: Partial<Pick<RoadmapItem, 'status' | 'horizon' | 'targetVersionLabel' | 'shippedVersionLabel' | 'userFeedback' | 'userNote'>> & {
    note?: string;
  },
): Promise<RoadmapItem> => {
  const { data } = await api.patch(`/intelligence/roadmap/${itemId}`, payload);
  return data;
};

/** Removes a roadmap item and the recommendation mirroring it. */
export const deleteRoadmapItem = async (itemId: string): Promise<void> => {
  await api.delete(`/intelligence/roadmap/${itemId}`);
};

// --- Recommendations --------------------------------------------------------

export const getRecommendations = async (
  productId: string,
  params?: Record<string, unknown>,
): Promise<{ data: Recommendation[]; pagination: unknown }> => {
  const { data } = await api.get(`/intelligence/${productId}/recommendations`, { params });
  return data;
};

export const updateRecommendation = async (
  recommendationId: string,
  payload: Partial<Recommendation>,
): Promise<Recommendation> => {
  const { data } = await api.patch(`/intelligence/recommendations/${recommendationId}`, payload);
  return data;
};

export const deleteRecommendation = async (productId: string, recommendationId: string): Promise<void> => {
  await api.delete(`/intelligence/${productId}/recommendations/${recommendationId}`);
};

// --- Competitive ------------------------------------------------------------

export const getGapAnalysis = async (productId: string): Promise<FeatureGapAnalysis> => {
  const { data } = await api.get(`/intelligence/${productId}/gap-analysis`);
  return data;
};

export const getCompetitiveMatrix = async (productId: string): Promise<CompetitiveMatrix> => {
  const { data } = await api.get(`/intelligence/${productId}/matrix`);
  return data;
};

// --- Release gate -----------------------------------------------------------

export const getReleaseReadiness = async (productId: string, version?: string): Promise<ReleaseReadiness> => {
  const { data } = await api.get(`/intelligence/${productId}/release-readiness`, { params: { version } });
  return data;
};

// --- Config and control -----------------------------------------------------

export const getConfig = async (): Promise<IntelligenceConfig> => {
  const { data } = await api.get('/intelligence/config');
  return data;
};

export const updateConfig = async (configData: Partial<IntelligenceConfig>): Promise<IntelligenceConfig> => {
  const { data } = await api.patch('/intelligence/config', configData);
  return data;
};

export const getAiStatus = async (): Promise<AiStatus> => {
  const { data } = await api.get('/intelligence/ai-status');
  return data;
};

export const triggerAnalysis = async (
  productId: string,
  category?: string,
): Promise<{ message: string; result?: unknown; llmUnavailableReason?: string }> => {
  const { data } = await api.post(`/intelligence/${productId}/analyze`, { category });
  return data;
};

// --- Churn (Freemius uninstall feedback) ------------------------------------

export interface ReasonBreakdown {
  reasonId: number;
  reason: string;
  count: number;
  /** Share of reports in the window, 0–100. */
  share: number;
  withText: number;
}

export interface ChurnQuote {
  reasonId: number;
  reason: string;
  text: string;
  uninstalledAt: string;
  version?: string;
}

export interface ChurnSummary {
  /** False when the product has no Freemius credentials resolved. */
  connected: boolean;
  windowDays: number;
  total: number;
  withText: number;
  breakdown: ReasonBreakdown[];
  quotes: ChurnQuote[];
  lastReportAt: string | null;
  totalAllTime: number;
}

export interface ChurnSyncResult {
  examined: number;
  stored: number;
  withoutFeedback: number;
  requests: number;
  errors: string[];
}

export const getChurn = async (
  productId: string,
  params?: { windowDays?: number },
): Promise<ChurnSummary> => {
  const { data } = await api.get(`/intelligence/${productId}/churn`, { params });
  return data;
};

export const syncChurn = async (productId: string): Promise<ChurnSyncResult> => {
  const { data } = await api.post(`/intelligence/${productId}/churn/sync`);
  return data;
};
