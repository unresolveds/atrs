import { CompetitorIntelService, type GapAnalysis } from './CompetitorIntelService';

/**
 * Backwards-compatible entry point for gap analysis.
 *
 * The original implementation built its answer by handing an LLM a list of
 * hand-typed `keyFeatures` strings and accepting whatever comparison came back —
 * so features the product genuinely had were reported as missing, and competitor
 * "advantages" were invented wholesale.
 *
 * The work now lives in `CompetitorIntelService`, which computes the comparison
 * from live WordPress.org readme text and directory metrics. This file remains so
 * existing callers and the `/gap-analysis` route keep working.
 */
export type FeatureGapAnalysis = GapAnalysis;

export class FeatureGapAnalyzer {
  /**
   * `storeId` is accepted but unused: ownership is already enforced by the
   * controller before this is reached, and the analysis is derived from public
   * directory data rather than from anything owner-scoped.
   */
  static async analyzeGaps(productId: string, _storeId?: string): Promise<GapAnalysis> {
    return CompetitorIntelService.analyzeGaps(productId);
  }
}
