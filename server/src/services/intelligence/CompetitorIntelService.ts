import mongoose from 'mongoose';
import { z } from 'zod';
import { Product } from '../../models/Product';
import { Competitor, type ICompetitor } from '../../models/Competitor';
import { WpOrgClient, type WpPluginInfo, type WpSearchHit } from './wporg/WpOrgClient';
import { computeCadence, extractFeatures, meanStars, negativeReviewShare, parseChangelog } from './wporg/readme';
import { compareFeatures, findCommonGaps, similarity, tokenize, type FeatureComparison } from './FeatureMatcher';
import { MarketDataService } from './MarketDataService';
import { PromptRunner } from './llm/PromptRunner';
import { fmtInt, fmtPct } from './signals/types';

/**
 * Competitor intelligence built from the WordPress.org directory.
 *
 * The previous implementation asked a language model to "identify 3 real-world
 * competitors" complete with URLs and feature lists. Models cannot know this, so
 * it invented plugins, invented their URLs, and invented what they could do —
 * every downstream comparison inherited that fiction.
 *
 * WordPress.org publishes a searchable directory with install counts, ratings,
 * support statistics and full readme text. Discovery is therefore a search
 * problem, comparison is arithmetic, and the language model's only job is
 * interpreting a table of facts it was handed.
 */

/** A discovery candidate with the real numbers behind its relevance score. */
export interface DiscoveredCompetitor {
  slug: string;
  name: string;
  url: string;
  shortDescription: string;
  author: string | null;
  activeInstalls: number | null;
  rating: number | null;
  numRatings: number;
  lastUpdated: Date | null;
  tags: string[];
  /** 0..100 — how likely this is a genuine competitor. */
  relevance: number;
  /** Why it scored that way, so the user can judge the suggestion. */
  relevanceBasis: string[];
  /** Search terms that surfaced it. */
  matchedVia: string[];
  /** True when this plugin is already tracked. */
  alreadyTracked: boolean;
  suggestedType: 'direct' | 'indirect' | 'alternative';
}

/** One row of the factual head-to-head comparison. */
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
  lastUpdated: Date | null;
  daysSinceRelease: number | null;
  medianDaysBetweenReleases: number | null;
  testedUpTo: string | null;
  requiresPhp: string | null;
  featureCount: number;
  screenshotCount: number | null;
  /** 30-day install change where snapshot history allows. */
  installTrend30d: number | null;

  /** Set when the competitor isn't on WP.org, so the UI can explain the blank row. */
  unmeasurableReason?: string;
}

/** Where we stand on each comparable metric. */
export interface MatrixVerdict {
  metric: string;
  label: string;
  /** Our value, formatted. */
  ours: string;
  /** Best competitor value, formatted. */
  bestCompetitor: string;
  bestCompetitorName: string | null;
  standing: 'ahead' | 'behind' | 'level' | 'unknown';
  /** Plain statement of the comparison. */
  note: string;
}

export interface CompetitiveMatrix {
  productId: string;
  rows: MatrixRow[];
  verdicts: MatrixVerdict[];
  /** Count of competitors we could actually measure. */
  measuredCount: number;
  /** Competitors we could not measure, with the reason. */
  unmeasured: Array<{ name: string; reason: string }>;
  generatedAt: Date;
}

/** The grounded replacement for the old free-text gap analysis. */
export interface GapAnalysis {
  productId: string;
  generatedAt: Date;
  /** Model-written when available, templated otherwise. */
  summary: string;
  marketPositioning: string;
  strategicRecommendations: string[];
  /** True when narrative text was templated rather than model-written. */
  deterministic: boolean;
  /** The factual matrix the narrative was derived from. */
  matrix: CompetitiveMatrix;
  competitors: Array<{
    competitorId: string;
    name: string;
    slug: string | null;
    /** Their capabilities we don't advertise. */
    missingFeatures: Array<{ feature: string; certainty: 'high' | 'medium' | 'low' }>;
    /** Ours they don't advertise. */
    differentiators: string[];
    /** Where they measurably beat us. */
    advantages: string[];
    /** Where we measurably beat them. */
    disadvantages: string[];
    /** Share of their advertised features we also cover. */
    featureCoverage: number;
    /** Whether features came from their live readme or from hand entry. */
    featureSource: 'readme' | 'manual' | 'none';
  }>;
  /** Capabilities two or more competitors share that we lack. */
  sharedGaps: Array<{ feature: string; competitors: string[]; certainty: 'high' | 'medium' | 'low' }>;
  /** Explains any reduced coverage instead of silently returning less. */
  caveats: string[];
}

const NarrativeSchema = z.object({
  summary: z.string().min(100).max(1200),
  marketPositioning: z.string().min(60).max(700),
  strategicRecommendations: z.array(z.string().min(20).max(300)).min(2).max(5),
  citations: z.array(z.string()).min(1),
});

const NARRATIVE_SYSTEM = `You are a competitive analyst writing for the maintainer of a WordPress plugin.

You are given a table of verified WordPress.org metrics and a computed feature comparison.

Absolute rules:
- Use ONLY the figures and feature names in the DATA block. Never introduce a plugin, number, feature or claim not present there.
- Never guess at pricing, company size, funding, roadmap or anything not in the data.
- When the data says a value is unknown, treat it as unknown. Do not estimate it.
- Feature gaps were detected by comparing readme text. Where you mention one, note that it reflects what is advertised.
- Cite the metric keys you relied on.
- Plain, specific prose. No marketing language, no bullet lists inside string values, no emoji.
- Address the maintainer as "you".`;

export class CompetitorIntelService {
  // ---------------------------------------------------------------- discovery

  /**
   * Finds real WordPress.org plugins that compete with this product.
   *
   * Searches the directory by the product's own tags and by keywords extracted
   * from its name and short description, then scores each hit on tag overlap,
   * description similarity and install-magnitude proximity. Everything returned
   * exists and every number attached to it is live.
   */
  static async discover(
    productId: string | mongoose.Types.ObjectId,
    opts?: { limit?: number },
  ): Promise<{ candidates: DiscoveredCompetitor[]; searchTerms: string[]; caveat?: string }> {
    const product = await Product.findById(productId);
    if (!product) throw new Error('Product not found');

    if (!product.wpOrgSlug) {
      return {
        candidates: [],
        searchTerms: [],
        caveat:
          'Competitor discovery searches the WordPress.org directory using this product\'s own tags and ' +
          'description, so it needs the product\'s WordPress.org slug. Set the slug, or add competitors manually.',
      };
    }

    const own = await WpOrgClient.getPlugin(product.wpOrgSlug);
    if (!own) {
      return {
        candidates: [],
        searchTerms: [],
        caveat: `WordPress.org returned no plugin for slug "${product.wpOrgSlug}". Check the slug is correct.`,
      };
    }

    const searchTerms = this.buildSearchTerms(own);
    const tracked = await Competitor.find({ productId: product._id });
    const trackedSlugs = new Set(tracked.map((c) => (c.wpOrgSlug || '').toLowerCase()).filter(Boolean));
    const trackedNames = new Set(tracked.map((c) => c.name.toLowerCase()));

    // Aggregate hits across searches, remembering which term surfaced each.
    const hits = new Map<string, { hit: WpSearchHit; via: Set<string> }>();

    for (const term of searchTerms) {
      const results = term.startsWith('tag:')
        ? await WpOrgClient.searchByTag(term.slice(4), 16)
        : await WpOrgClient.search(term, 16);

      for (const hit of results) {
        if (hit.slug.toLowerCase() === own.slug.toLowerCase()) continue;
        const existing = hits.get(hit.slug);
        if (existing) existing.via.add(term);
        else hits.set(hit.slug, { hit, via: new Set([term]) });
      }
    }

    const ownTokens = tokenize(`${own.name} ${own.shortDescription}`);
    const ownTags = new Set(own.tags.map((t) => t.toLowerCase()));

    const candidates: DiscoveredCompetitor[] = [...hits.values()].map(({ hit, via }) => {
      const scored = this.scoreRelevance(hit, { ownTokens, ownTags, ownInstalls: own.activeInstalls, via });
      return {
        slug: hit.slug,
        name: hit.name,
        url: `https://wordpress.org/plugins/${hit.slug}/`,
        shortDescription: hit.shortDescription,
        author: hit.author,
        activeInstalls: hit.activeInstalls,
        rating: hit.rating,
        numRatings: hit.numRatings,
        lastUpdated: hit.lastUpdated,
        tags: hit.tags,
        relevance: scored.score,
        relevanceBasis: scored.basis,
        matchedVia: [...via],
        alreadyTracked: trackedSlugs.has(hit.slug.toLowerCase()) || trackedNames.has(hit.name.toLowerCase()),
        suggestedType: scored.score >= 55 ? 'direct' : scored.score >= 35 ? 'indirect' : 'alternative',
      };
    });

    return {
      candidates: candidates
        .filter((c) => c.relevance >= 20)
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, opts?.limit ?? 12),
      searchTerms,
    };
  }

  /**
   * Chooses the directory searches to run.
   *
   * The product's own tags are the highest-signal terms available — the author
   * already declared what category the plugin belongs to. Name and description
   * keywords fill in what the tags miss. Single-word generic terms are excluded
   * because searching "block" returns the whole directory.
   */
  private static buildSearchTerms(own: WpPluginInfo): string[] {
    const terms: string[] = [];

    for (const tag of own.tags.slice(0, 5)) terms.push(`tag:${tag}`);

    // Two-word phrases from the name, minus the author's brand words, describe
    // the function rather than the product.
    const nameTokens = own.name
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !['the', 'for', 'and', 'wp', 'wordpress', 'plugin'].includes(t));
    if (nameTokens.length >= 2) terms.push(nameTokens.slice(0, 3).join(' '));

    // The most distinctive bigram in the short description.
    const descTokens = [...tokenize(own.shortDescription)];
    if (descTokens.length >= 2) terms.push(descTokens.slice(0, 2).join(' '));

    return [...new Set(terms)].slice(0, 7);
  }

  /**
   * Scores how likely a search hit is a genuine competitor.
   *
   * Tag overlap is weighted highest because two plugins sharing three declared
   * tags are almost certainly in the same category. Install magnitude matters
   * because a 5-million-install giant and a 200-install plugin don't meaningfully
   * compete even when they do the same thing — but it is weighted lightly, since
   * a fast-growing small rival is exactly what a maintainer wants warned about.
   */
  private static scoreRelevance(
    hit: WpSearchHit,
    ctx: { ownTokens: Set<string>; ownTags: Set<string>; ownInstalls: number | null; via: Set<string> },
  ): { score: number; basis: string[] } {
    const basis: string[] = [];
    let score = 0;

    const sharedTags = hit.tags.filter((t) => ctx.ownTags.has(t.toLowerCase()));
    if (sharedTags.length > 0) {
      const tagPoints = Math.min(45, sharedTags.length * 15);
      score += tagPoints;
      basis.push(`Shares ${sharedTags.length} directory tag(s): ${sharedTags.join(', ')}`);
    }

    const descriptionMatch = similarity(hit.shortDescription, [...ctx.ownTokens].join(' '));
    if (descriptionMatch > 0) {
      const descPoints = Math.round(descriptionMatch * 30);
      score += descPoints;
      if (descPoints >= 5) basis.push(`Description overlaps yours (${Math.round(descriptionMatch * 100)}% term match)`);
    }

    // Surfacing under several of our searches is independent corroboration.
    if (ctx.via.size > 1) {
      score += Math.min(15, ctx.via.size * 5);
      basis.push(`Found via ${ctx.via.size} separate searches`);
    }

    if (ctx.ownInstalls && hit.activeInstalls) {
      // Same order of magnitude → comparable market position.
      const ratio = hit.activeInstalls / ctx.ownInstalls;
      if (ratio >= 0.1 && ratio <= 10) {
        score += 10;
        basis.push(`Comparable size (${fmtInt(hit.activeInstalls)} installs against your ${fmtInt(ctx.ownInstalls)})`);
      } else {
        basis.push(
          `Different scale (${fmtInt(hit.activeInstalls)} installs against your ${fmtInt(ctx.ownInstalls)}) — ` +
            `may not compete directly`,
        );
      }
    }

    // A plugin abandoned for two years isn't a live threat.
    if (hit.lastUpdated) {
      const days = (Date.now() - hit.lastUpdated.getTime()) / 86_400_000;
      if (days > 730) {
        score -= 15;
        basis.push(`Not updated in ${Math.round(days / 365)} years — likely abandoned`);
      }
    }

    return { score: Math.max(0, Math.min(100, Math.round(score))), basis };
  }

  /**
   * Adds discovered plugins as tracked competitors.
   *
   * Every field is populated from live WP.org data, including the real readme
   * feature list, so a newly added competitor participates in gap analysis
   * immediately rather than waiting for someone to hand-type `keyFeatures`.
   */
  static async addDiscovered(
    productId: string | mongoose.Types.ObjectId,
    storeId: string | mongoose.Types.ObjectId,
    slugs: string[],
  ): Promise<ICompetitor[]> {
    const product = await Product.findById(productId);
    if (!product) throw new Error('Product not found');

    const infos = await WpOrgClient.getPlugins(slugs);
    const created: ICompetitor[] = [];

    for (const info of infos) {
      const existing = await Competitor.findOne({ productId, wpOrgSlug: info.slug });
      if (existing) continue;

      const competitor = await Competitor.create({
        storeId: new mongoose.Types.ObjectId(String(storeId)),
        productId: new mongoose.Types.ObjectId(String(productId)),
        name: info.name,
        url: info.homepage || `https://wordpress.org/plugins/${info.slug}/`,
        type: 'direct',
        wpOrgSlug: info.slug,
        keyFeatures: extractFeatures(info, 20),
        status: 'active',
      });

      // Capture the first market snapshot immediately so trend comparison has a
      // baseline rather than waiting for the next scheduled run.
      await MarketDataService.captureCompetitor(competitor, { force: true }).catch(() => undefined);
      created.push(competitor);
    }

    return created;
  }

  // ------------------------------------------------------------------- matrix

  /**
   * Builds the factual head-to-head comparison.
   *
   * Contains no interpretation at all — every cell is a live WP.org number or an
   * explicit null. This is what the narrative layer is later allowed to talk
   * about, and what the UI renders when the model is unavailable.
   */
  static async buildMatrix(productId: string | mongoose.Types.ObjectId): Promise<CompetitiveMatrix> {
    const product = await Product.findById(productId);
    if (!product) throw new Error('Product not found');

    const now = new Date();
    const competitors = await Competitor.find({ productId: product._id, status: 'active' });

    const rows: MatrixRow[] = [];
    const unmeasured: CompetitiveMatrix['unmeasured'] = [];

    const ownInfo = product.wpOrgSlug ? await WpOrgClient.getPlugin(product.wpOrgSlug) : null;
    const ownSeries = await MarketDataService.getProductSeries(product._id as mongoose.Types.ObjectId);

    rows.push(
      ownInfo
        ? this.rowFromInfo('product', product.name, ownInfo, ownSeries, now)
        : {
            subject: 'product',
            name: product.name,
            slug: product.wpOrgSlug || null,
            url: null,
            activeInstalls: null,
            downloaded: null,
            meanStars: null,
            numRatings: 0,
            negativeReviewShare: null,
            supportResolutionRate: null,
            lastUpdated: null,
            daysSinceRelease: null,
            medianDaysBetweenReleases: null,
            testedUpTo: null,
            requiresPhp: null,
            featureCount: 0,
            screenshotCount: null,
            installTrend30d: null,
            unmeasurableReason: product.wpOrgSlug
              ? `WordPress.org returned no data for slug "${product.wpOrgSlug}".`
              : 'No WordPress.org slug is set for this product.',
          },
    );

    for (const competitor of competitors) {
      if (!competitor.wpOrgSlug) {
        unmeasured.push({
          name: competitor.name,
          reason: 'No WordPress.org slug set, so directory metrics cannot be read.',
        });
        continue;
      }
      const info = await WpOrgClient.getPlugin(competitor.wpOrgSlug);
      if (!info) {
        unmeasured.push({
          name: competitor.name,
          reason: `WordPress.org returned no plugin for slug "${competitor.wpOrgSlug}".`,
        });
        continue;
      }
      const series = await MarketDataService.getCompetitorSeries(competitor._id as mongoose.Types.ObjectId);
      rows.push({
        ...this.rowFromInfo('competitor', competitor.name, info, series, now),
        competitorId: String(competitor._id),
      });
    }

    return {
      productId: String(product._id),
      rows,
      verdicts: this.buildVerdicts(rows),
      measuredCount: rows.filter((r) => r.subject === 'competitor').length,
      unmeasured,
      generatedAt: now,
    };
  }

  private static rowFromInfo(
    subject: 'product' | 'competitor',
    name: string,
    info: WpPluginInfo,
    series: Awaited<ReturnType<typeof MarketDataService.getProductSeries>>,
    now: Date,
  ): MatrixRow {
    const cadence = computeCadence(parseChangelog(info.sections['changelog'] || ''), now);
    const trend = MarketDataService.computeTrend(series, 'activeInstalls', 30);

    return {
      subject,
      name,
      slug: info.slug,
      url: `https://wordpress.org/plugins/${info.slug}/`,
      activeInstalls: info.activeInstalls,
      downloaded: info.downloaded,
      meanStars: meanStars(info.ratings) ?? (info.rating !== null ? Math.round((info.rating / 20) * 100) / 100 : null),
      numRatings: info.numRatings,
      negativeReviewShare: negativeReviewShare(info.ratings),
      supportResolutionRate:
        info.supportThreads !== null && info.supportThreadsResolved !== null && info.supportThreads > 0
          ? Math.round((info.supportThreadsResolved / info.supportThreads) * 1000) / 10
          : null,
      lastUpdated: info.lastUpdated,
      daysSinceRelease: info.lastUpdated
        ? Math.floor((now.getTime() - info.lastUpdated.getTime()) / 86_400_000)
        : null,
      medianDaysBetweenReleases: cadence.medianDaysBetween,
      testedUpTo: info.testedUpTo,
      requiresPhp: info.requiresPhp,
      featureCount: extractFeatures(info).length,
      screenshotCount: info.screenshotCount,
      installTrend30d: trend.delta,
    };
  }

  /**
   * Reduces the matrix to a standing per metric.
   *
   * Direction matters and differs per metric — more installs is better, fewer days
   * since release is better — so each comparison declares its own polarity rather
   * than assuming higher wins.
   */
  private static buildVerdicts(rows: MatrixRow[]): MatrixVerdict[] {
    const ours = rows.find((r) => r.subject === 'product');
    const rivals = rows.filter((r) => r.subject === 'competitor');
    if (!ours || rivals.length === 0) return [];

    const comparisons: Array<{
      metric: keyof MatrixRow;
      label: string;
      higherIsBetter: boolean;
      format: (v: number | null) => string;
      /** Minimum difference before we call it anything but level. */
      tolerance: number;
    }> = [
      { metric: 'activeInstalls', label: 'Active installs', higherIsBetter: true, format: fmtInt, tolerance: 0 },
      { metric: 'meanStars', label: 'Rating', higherIsBetter: true, format: (v) => (v === null ? 'unknown' : `${v.toFixed(2)} stars`), tolerance: 0.2 },
      { metric: 'numRatings', label: 'Review count', higherIsBetter: true, format: fmtInt, tolerance: 0 },
      { metric: 'supportResolutionRate', label: 'Support resolution', higherIsBetter: true, format: (v) => (v === null ? 'unknown' : fmtPct(v)), tolerance: 5 },
      { metric: 'daysSinceRelease', label: 'Days since last release', higherIsBetter: false, format: (v) => (v === null ? 'unknown' : `${v} days`), tolerance: 7 },
      { metric: 'medianDaysBetweenReleases', label: 'Release cadence', higherIsBetter: false, format: (v) => (v === null ? 'unknown' : `${v} days between releases`), tolerance: 7 },
      { metric: 'featureCount', label: 'Advertised features', higherIsBetter: true, format: fmtInt, tolerance: 2 },
      { metric: 'screenshotCount', label: 'Screenshots', higherIsBetter: true, format: fmtInt, tolerance: 1 },
    ];

    const verdicts: MatrixVerdict[] = [];

    for (const c of comparisons) {
      const ourValue = ours[c.metric] as number | null;
      const rivalValues = rivals
        .map((r) => ({ name: r.name, value: r[c.metric] as number | null }))
        .filter((r): r is { name: string; value: number } => typeof r.value === 'number');

      if (ourValue === null || typeof ourValue !== 'number' || rivalValues.length === 0) {
        verdicts.push({
          metric: String(c.metric),
          label: c.label,
          ours: c.format(typeof ourValue === 'number' ? ourValue : null),
          bestCompetitor: 'unknown',
          bestCompetitorName: null,
          standing: 'unknown',
          note:
            ourValue === null
              ? `Not measurable for this product${ours.unmeasurableReason ? ` — ${ours.unmeasurableReason.toLowerCase()}` : ''}.`
              : 'No competitor has a comparable value on record.',
        });
        continue;
      }

      const best = rivalValues.reduce((a, b) => (c.higherIsBetter ? (b.value > a.value ? b : a) : b.value < a.value ? b : a));
      const diff = c.higherIsBetter ? ourValue - best.value : best.value - ourValue;

      const standing: MatrixVerdict['standing'] =
        Math.abs(diff) <= c.tolerance ? 'level' : diff > 0 ? 'ahead' : 'behind';

      verdicts.push({
        metric: String(c.metric),
        label: c.label,
        ours: c.format(ourValue),
        bestCompetitor: c.format(best.value),
        bestCompetitorName: best.name,
        standing,
        note:
          standing === 'level'
            ? `Level with ${best.name} (${c.format(ourValue)} against ${c.format(best.value)}).`
            : standing === 'ahead'
              ? `Ahead of the tracked set — best competitor is ${best.name} at ${c.format(best.value)}.`
              : `Behind ${best.name} (${c.format(best.value)} against your ${c.format(ourValue)}).`,
      });
    }

    return verdicts;
  }

  // ------------------------------------------------------------ gap analysis

  /**
   * The grounded feature-gap and positioning analysis.
   *
   * Structure comes from the matrix and the feature matcher; only `summary`,
   * `marketPositioning` and `strategicRecommendations` are model-written, and
   * those are validated against the metric keys actually present. When the model
   * is unavailable the templated equivalents ship, so this endpoint always
   * returns a usable analysis.
   */
  static async analyzeGaps(productId: string | mongoose.Types.ObjectId): Promise<GapAnalysis> {
    const product = await Product.findById(productId);
    if (!product) throw new Error('Product not found');

    const now = new Date();
    const matrix = await this.buildMatrix(productId);
    const caveats: string[] = [];

    if (!product.wpOrgSlug) {
      caveats.push(
        'This product has no WordPress.org slug, so its own features and metrics could not be read. ' +
          'Comparison is limited to what competitors publish.',
      );
    }
    for (const u of matrix.unmeasured) {
      caveats.push(`${u.name} could not be measured: ${u.reason}`);
    }

    const ownInfo = product.wpOrgSlug ? await WpOrgClient.getPlugin(product.wpOrgSlug) : null;
    const ownFeatures = ownInfo ? extractFeatures(ownInfo) : [];

    const competitorDocs = await Competitor.find({ productId: product._id, status: 'active' });

    const perCompetitor: Array<{ name: string; comparison: FeatureComparison }> = [];
    const competitors: GapAnalysis['competitors'] = [];

    for (const competitor of competitorDocs) {
      const info = competitor.wpOrgSlug ? await WpOrgClient.getPlugin(competitor.wpOrgSlug) : null;
      const readmeFeatures = info ? extractFeatures(info) : [];
      const features = readmeFeatures.length > 0 ? readmeFeatures : competitor.keyFeatures || [];
      const featureSource: 'readme' | 'manual' | 'none' =
        readmeFeatures.length > 0 ? 'readme' : features.length > 0 ? 'manual' : 'none';

      const row = matrix.rows.find((r) => r.competitorId === String(competitor._id));
      const ourRow = matrix.rows.find((r) => r.subject === 'product');

      const comparison =
        ownFeatures.length > 0 && features.length > 0
          ? compareFeatures(ownFeatures, features)
          : { shared: [], gaps: [], advantages: [], coverageOfCompetitor: 0 };

      if (features.length > 0) perCompetitor.push({ name: competitor.name, comparison });

      competitors.push({
        competitorId: String(competitor._id),
        name: competitor.name,
        slug: competitor.wpOrgSlug || null,
        // Only high and medium certainty gaps are shown; low-certainty ones are
        // usually the same capability worded differently and would mislead.
        missingFeatures: comparison.gaps
          .filter((g) => g.certainty !== 'low')
          .slice(0, 10)
          .map((g) => ({ feature: g.feature, certainty: g.certainty })),
        differentiators: comparison.advantages.slice(0, 10).map((a) => a.feature),
        advantages: row && ourRow ? this.metricAdvantages(ourRow, row, 'theirs') : [],
        disadvantages: row && ourRow ? this.metricAdvantages(ourRow, row, 'ours') : [],
        featureCoverage: comparison.coverageOfCompetitor,
        featureSource,
      });

      if (featureSource === 'manual') {
        caveats.push(
          `${competitor.name}'s features came from manually entered values rather than its live readme, ` +
            'so the comparison is only as current as that list.',
        );
      } else if (featureSource === 'none') {
        caveats.push(`No features could be read for ${competitor.name}, so it contributes no gap analysis.`);
      }
    }

    if (ownFeatures.length === 0 && competitorDocs.length > 0) {
      caveats.push(
        'No feature list could be read from this product\'s readme, so capability gaps could not be computed. ' +
          'A readme Description section with feature bullets enables this.',
      );
    }

    const sharedGaps = findCommonGaps(perCompetitor)
      .filter((g) => g.certainty === 'high' && (perCompetitor.length === 1 || g.competitors.length >= 2))
      .slice(0, 8)
      .map((g) => ({ feature: g.feature, competitors: g.competitors, certainty: g.certainty }));

    const narrative = await this.buildNarrative(product.name, matrix, competitors, sharedGaps, caveats);

    return {
      productId: String(product._id),
      generatedAt: now,
      summary: narrative.summary,
      marketPositioning: narrative.marketPositioning,
      strategicRecommendations: narrative.strategicRecommendations,
      deterministic: narrative.deterministic,
      matrix,
      competitors,
      sharedGaps,
      caveats: [...new Set(caveats)],
    };
  }

  /**
   * Metric-level advantages, in whichever direction is asked for.
   *
   * These are the "they do better / we do better" columns, and unlike the old
   * implementation they are arithmetic rather than opinion.
   */
  private static metricAdvantages(ours: MatrixRow, theirs: MatrixRow, favouring: 'ours' | 'theirs'): string[] {
    const out: string[] = [];
    const wins = favouring === 'theirs';

    const check = (
      label: string,
      ourValue: number | null,
      theirValue: number | null,
      higherIsBetter: boolean,
      format: (v: number) => string,
      tolerance = 0,
    ) => {
      if (ourValue === null || theirValue === null) return;
      const theirAdvantage = higherIsBetter ? theirValue - ourValue : ourValue - theirValue;
      if (Math.abs(theirAdvantage) <= tolerance) return;
      if (wins ? theirAdvantage > 0 : theirAdvantage < 0) {
        out.push(`${label}: ${format(theirValue)} against your ${format(ourValue)}`);
      }
    };

    check('Active installs', ours.activeInstalls, theirs.activeInstalls, true, fmtInt);
    check('Rating', ours.meanStars, theirs.meanStars, true, (v) => `${v.toFixed(2)} stars`, 0.2);
    check('Review count', ours.numRatings, theirs.numRatings, true, fmtInt);
    check('Support resolution', ours.supportResolutionRate, theirs.supportResolutionRate, true, (v) => fmtPct(v), 5);
    check('Days since last release', ours.daysSinceRelease, theirs.daysSinceRelease, false, (v) => `${v} days`, 7);
    check('Release cadence', ours.medianDaysBetweenReleases, theirs.medianDaysBetweenReleases, false, (v) => `every ${v} days`, 7);
    check('Screenshots', ours.screenshotCount, theirs.screenshotCount, true, fmtInt, 1);

    return out;
  }

  /** Writes the narrative, falling back to templates when the model can't be used. */
  private static async buildNarrative(
    productName: string,
    matrix: CompetitiveMatrix,
    competitors: GapAnalysis['competitors'],
    sharedGaps: GapAnalysis['sharedGaps'],
    caveats: string[],
  ): Promise<{ summary: string; marketPositioning: string; strategicRecommendations: string[]; deterministic: boolean }> {
    if (matrix.measuredCount === 0) {
      return {
        summary:
          matrix.unmeasured.length > 0
            ? `No tracked competitor could be measured. ${matrix.unmeasured.map((u) => `${u.name}: ${u.reason}`).join(' ')}`
            : 'No competitors are tracked for this product yet, so there is nothing to compare against. ' +
              'Auto-discovery can propose real WordPress.org plugins ranking for the same terms.',
        marketPositioning: 'Positioning cannot be assessed without at least one measurable competitor.',
        strategicRecommendations:
          matrix.unmeasured.length > 0
            ? ['Set WordPress.org slugs on the tracked competitors so their directory metrics can be read.']
            : ['Run competitor discovery to find real WordPress.org plugins competing for the same search terms.'],
        deterministic: true,
      };
    }

    const probe = await PromptRunner.probe();
    if (probe.available) {
      const metricKeys = matrix.verdicts.filter((v) => v.standing !== 'unknown').map((v) => v.metric);
      if (metricKeys.length > 0) {
        const run = await PromptRunner.run({
          task: 'competitive.narrative',
          schema: NarrativeSchema,
          taskClass: 'explanatory',
          system: NARRATIVE_SYSTEM,
          user: this.buildNarrativePrompt(productName, matrix, competitors, sharedGaps, caveats),
          allowedCitations: metricKeys,
          minCitations: 2,
          numPredict: 1100,
        });
        if (run.data) {
          return {
            summary: run.data.summary,
            marketPositioning: run.data.marketPositioning,
            strategicRecommendations: run.data.strategicRecommendations,
            deterministic: false,
          };
        }
      }
    }

    return { ...this.templateNarrative(matrix, competitors, sharedGaps), deterministic: true };
  }

  private static buildNarrativePrompt(
    productName: string,
    matrix: CompetitiveMatrix,
    competitors: GapAnalysis['competitors'],
    sharedGaps: GapAnalysis['sharedGaps'],
    caveats: string[],
  ): string {
    const verdicts = matrix.verdicts
      .filter((v) => v.standing !== 'unknown')
      .map((v) => `- KEY: ${v.metric}\n  METRIC: ${v.label}\n  YOURS: ${v.ours}\n  BEST COMPETITOR: ${v.bestCompetitor} (${v.bestCompetitorName})\n  STANDING: ${v.standing}`)
      .join('\n');

    const gapLines = sharedGaps.length
      ? sharedGaps.map((g) => `- "${g.feature}" — advertised by ${g.competitors.join(', ')}`).join('\n')
      : '- (none detected)';

    const perCompetitor = competitors
      .map(
        (c) =>
          `- ${c.name}: you cover ${c.featureCoverage}% of their advertised features; ` +
          `${c.missingFeatures.length} capabilities they advertise that you do not; ` +
          `${c.differentiators.length} you advertise that they do not` +
          (c.featureSource !== 'readme' ? ` (feature source: ${c.featureSource})` : ''),
      )
      .join('\n');

    return `PRODUCT: ${productName}

DATA — HEAD-TO-HEAD METRICS (verified WordPress.org figures):
${verdicts}

DATA — CAPABILITIES ADVERTISED BY MULTIPLE COMPETITORS BUT NOT BY YOU:
${gapLines}

DATA — PER-COMPETITOR FEATURE COMPARISON:
${perCompetitor}

${caveats.length ? `KNOWN LIMITATIONS OF THIS DATA:\n${caveats.map((c) => `- ${c}`).join('\n')}\n` : ''}
TASK:
- "summary": 3–5 sentences on where this product genuinely stands in its competitive set. Lead with the most consequential gap or lead, quoting the figures. Name the limitation if the data is thin.
- "marketPositioning": 2–3 sentences on how the product is positioned relative to the tracked set, based only on the metrics above.
- "strategicRecommendations": 2–5 specific actions, each tied to a figure above. No generic advice.
- "citations": the KEY values you used.

Return only JSON: {"summary": "...", "marketPositioning": "...", "strategicRecommendations": ["..."], "citations": ["..."]}`;
  }

  /**
   * Templated narrative from the verdicts.
   *
   * Reads more mechanically than model prose but states exactly the same facts,
   * so a user with no LLM configured still gets a correct, useful analysis.
   */
  private static templateNarrative(
    matrix: CompetitiveMatrix,
    competitors: GapAnalysis['competitors'],
    sharedGaps: GapAnalysis['sharedGaps'],
  ): { summary: string; marketPositioning: string; strategicRecommendations: string[] } {
    const behind = matrix.verdicts.filter((v) => v.standing === 'behind');
    const ahead = matrix.verdicts.filter((v) => v.standing === 'ahead');
    const level = matrix.verdicts.filter((v) => v.standing === 'level');

    const parts: string[] = [
      `Compared against ${matrix.measuredCount} measurable competitor${matrix.measuredCount === 1 ? '' : 's'}, ` +
        `this product leads on ${ahead.length} metric${ahead.length === 1 ? '' : 's'}, trails on ${behind.length}, ` +
        `and is level on ${level.length}.`,
    ];

    if (behind.length > 0) {
      parts.push(`Where it trails: ${behind.map((v) => v.note.replace(/\.$/, '')).join('; ')}.`);
    }
    if (ahead.length > 0) {
      parts.push(`Where it leads: ${ahead.map((v) => `${v.label.toLowerCase()} at ${v.ours}`).join('; ')}.`);
    }
    if (sharedGaps.length > 0) {
      parts.push(
        `${sharedGaps.length} capabilit${sharedGaps.length === 1 ? 'y is' : 'ies are'} advertised by multiple ` +
          `competitors and not by this product, most notably "${sharedGaps[0].feature}".`,
      );
    }

    const positioning =
      ahead.length > behind.length
        ? `This product is the stronger option on most measured dimensions within its tracked set, ` +
          `which makes the strategic question one of defending position rather than catching up.`
        : behind.length > ahead.length
          ? `This product trails its tracked set on most measured dimensions. The gaps are concentrated in ` +
            `${[...new Set(behind.map((v) => v.label.toLowerCase()))].slice(0, 3).join(', ')}.`
          : `This product is broadly level with its tracked set, leading on some dimensions and trailing on others.`;

    const recommendations: string[] = [];
    for (const v of behind.slice(0, 3)) {
      recommendations.push(`Close the ${v.label.toLowerCase()} gap: ${v.note}`);
    }
    if (sharedGaps.length > 0) {
      recommendations.push(
        `Decide explicitly on "${sharedGaps[0].feature}" — build it, document it if it already exists, or record why it is out of scope.`,
      );
    }
    for (const c of competitors) {
      if (c.differentiators.length >= 3) {
        recommendations.push(
          `Lead with what only you offer against ${c.name}: ${c.differentiators.slice(0, 2).join('; ')}.`,
        );
        break;
      }
    }
    if (recommendations.length === 0) {
      recommendations.push('Maintain the current position — no measurable competitive gap was detected.');
    }

    return { summary: parts.join(' '), marketPositioning: positioning, strategicRecommendations: recommendations.slice(0, 5) };
  }
}
