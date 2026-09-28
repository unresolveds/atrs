import { CompetitorIntelService, type DiscoveredCompetitor } from './CompetitorIntelService';

/**
 * Backwards-compatible entry point for competitor discovery.
 *
 * The original implementation prompted an LLM to "identify 3 real-world software
 * competitors" and return their names, URLs and feature lists. A language model
 * has no way to know which plugins currently compete with yours, so it produced
 * plausible-sounding plugins that frequently did not exist, at URLs that did not
 * resolve, with feature lists it invented — and those fabrications were written
 * straight into the database as tracked competitors.
 *
 * Discovery now searches the WordPress.org directory by the product's own tags
 * and description keywords. Every candidate is a real, currently-listed plugin
 * with live install, rating and update figures attached.
 */
export class CompetitorDiscoveryService {
  /**
   * Discovers and persists competitors.
   *
   * Unlike the previous version this returns *suggestions* alongside anything it
   * created, because writing unreviewed rows was half the problem: a hallucinated
   * competitor silently corrupted every later comparison. Candidates above the
   * high-relevance threshold are added automatically; the rest are returned for
   * the user to confirm.
   */
  static async autoDiscover(
    productId: string,
    storeId: string,
  ): Promise<{
    added: unknown[];
    suggestions: DiscoveredCompetitor[];
    searchTerms: string[];
    caveat?: string;
  }> {
    const { candidates, searchTerms, caveat } = await CompetitorIntelService.discover(productId, { limit: 12 });

    // Only add what the relevance scoring is genuinely confident about; a shared
    // tag alone is not enough to assert competition on the user's behalf.
    const confident = candidates.filter((c) => !c.alreadyTracked && c.relevance >= 55).slice(0, 5);

    const added = confident.length
      ? await CompetitorIntelService.addDiscovered(
          productId,
          storeId,
          confident.map((c) => c.slug),
        )
      : [];

    const addedSlugs = new Set(confident.map((c) => c.slug));

    return {
      added,
      suggestions: candidates.filter((c) => !addedSlugs.has(c.slug)),
      searchTerms,
      caveat,
    };
  }
}
