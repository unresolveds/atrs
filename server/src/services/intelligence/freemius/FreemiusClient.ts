import crypto from 'crypto';

/**
 * Minimal signed client for the Freemius REST API.
 *
 * Ported from the SDK vendored in the WordPress plugins
 * (`vendor/freemius/includes/sdk/FreemiusWordPress.php`), with two corrections
 * established by probing the live API — both of which fail in ways that are easy
 * to misread, so they are encoded here rather than left to callers:
 *
 *  1. The signature covers the path *without* the query string. The PHP SDK's
 *     `CanonizePath()` appends the query before signing, and the server answers
 *     `401 Invalid Authorization header` when it does.
 *  2. PHP's `hash_hmac()` returns a hex string by default, and the SDK base64url-
 *     encodes *that*. Signing the raw digest bytes produces a valid-looking
 *     signature that is always rejected.
 */

export type FreemiusScope = 'plugin' | 'developer';

export interface FreemiusCredentials {
  /** Product id for 'plugin' scope, developer id for 'developer' scope. */
  entityId: string;
  publicKey: string;
  secretKey: string;
  scope?: FreemiusScope;
}

/** An uninstall feedback record. Absent when the user gave no reason. */
export interface FreemiusUninstall {
  id: number;
  install_id: number;
  plugin_id: number;
  site_id?: number;
  reason_id: number;
  /** Human label supplied by the API — authoritative, so we never map ids ourselves. */
  reason?: string;
  /** Free text, only populated when the user picked "Other". */
  reason_info?: string;
  created?: string;
  updated?: string;
}

export interface FreemiusInstall {
  id: number;
  is_uninstalled?: boolean;
  is_active?: boolean;
  version?: string;
  country_code?: string;
  sdk_version?: string;
  platform_version?: string;
  created?: string;
  updated?: string;
  last_seen_at?: string;
}

export interface FreemiusEvent {
  id: number;
  type: string;
  install_id?: number;
  user_id?: number;
  created?: string;
  data?: unknown;
}

export class FreemiusApiError extends Error {
  constructor(message: string, readonly status: number, readonly path: string) {
    super(message);
    this.name = 'FreemiusApiError';
  }

  /**
   * Freemius throttles bursts. It answers 429 in some cases and a 200-shaped
   * error body in others, so the message is checked too rather than trusting
   * the status alone.
   */
  get isRateLimited(): boolean {
    return this.status === 429 || /too many requests/i.test(this.message);
  }
}

const API_ROOT = 'https://api.freemius.com';
const API_VERSION = 1;
/** The API caps a page at 50 regardless of what you ask for. */
export const MAX_PAGE = 50;

export interface FreemiusClientOptions {
  /**
   * Minimum gap between requests. Freemius throttles bursts — pulling one
   * uninstall per install with no gap trips it within a few hundred calls — and
   * it exposes no rate-limit headers to pace against, so the client self-paces.
   */
  minIntervalMs?: number;
  /** Retries for a throttled request before giving up. */
  maxRetries?: number;
  /** Test seam; defaults to real sleeping. */
  sleep?: (ms: number) => Promise<void>;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FreemiusClient {
  private readonly scope: FreemiusScope;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Serializes pacing so concurrent callers share one budget. */
  private gate: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly creds: FreemiusCredentials, opts: FreemiusClientOptions = {}) {
    this.scope = creds.scope ?? 'plugin';
    this.minIntervalMs = opts.minIntervalMs ?? 250;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? sleepReal;
    if (!creds.entityId || !creds.publicKey || !creds.secretKey) {
      throw new Error('Freemius credentials are incomplete (need entityId, publicKey, secretKey).');
    }
  }

  /** Waits out the inter-request gap, one caller at a time. */
  private async pace(): Promise<void> {
    const mine = this.gate.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
    });
    this.gate = mine.catch(() => undefined);
    return mine;
  }

  /** base64 with the URL-safe alphabet and no padding, matching `Base64UrlEncode`. */
  private static base64Url(input: string): string {
    return Buffer.from(input, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  /** `/v1/plugins/{id}/<path>.json` — mirrors the SDK's CanonizePath for our scopes. */
  private canonize(path: string): string {
    let rest = path.replace(/^\/+|\/+$/g, '');
    if (rest.toLowerCase().endsWith('.json')) rest = rest.slice(0, -'.json'.length);
    const base = this.scope === 'developer'
      ? `/developers/${this.creds.entityId}`
      : `/plugins/${this.creds.entityId}`;
    const suffix = rest.includes('.') ? '' : '.json';
    return `/v${API_VERSION}${base}${rest ? '/' + rest : ''}${suffix}`;
  }

  private authHeaders(signedPath: string, method: string): Record<string, string> {
    // PHP's date('r'): RFC 2822 with a numeric offset, not the "GMT" spelling.
    const date = new Date().toUTCString().replace('GMT', '+0000');
    const stringToSign = [method.toUpperCase(), '', '', date, signedPath].join('\n');
    const hex = crypto.createHmac('sha256', this.creds.secretKey)
      .update(stringToSign, 'utf8').digest('hex');
    // Identical keys mean the public-key hash variant; kept for parity with the SDK.
    const scheme = this.creds.secretKey !== this.creds.publicKey ? 'FS' : 'FSP';
    return {
      Date: date,
      Authorization: `${scheme} ${this.creds.entityId}:${this.creds.publicKey}:${FreemiusClient.base64Url(hex)}`,
      Accept: 'application/json',
    };
  }

  /**
   * GET a resource. `query` is appended to the URL but deliberately excluded
   * from the signed string — see the class comment.
   */
  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const signedPath = this.canonize(path);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    const url = `${API_ROOT}${signedPath}${qs ? `?${qs}` : ''}`;

    for (let attempt = 0; ; attempt++) {
      await this.pace();
      // The Date header is part of the signature, so both are regenerated per
      // attempt — replaying a stale date would fail authentication.
      const res = await fetch(url, { headers: this.authHeaders(signedPath, 'GET') });
      const text = await res.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* non-JSON error page */ }

      if (res.ok) return body as T;

      const message = body?.error?.message || body?.message || text.slice(0, 200) || res.statusText;
      const error = new FreemiusApiError(message, res.status, signedPath);
      if (!error.isRateLimited || attempt >= this.maxRetries) throw error;

      // No Retry-After is sent, so back off geometrically from a second.
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** attempt;
      await this.sleep(delay);
    }
  }

  /** The product record. `installs_count` / `active_installs_count` size a backfill without paging. */
  async getProduct(): Promise<Record<string, any>> {
    return this.get('');
  }

  /** One page of installs. */
  async listInstalls(offset: number, count = MAX_PAGE): Promise<FreemiusInstall[]> {
    const r = await this.get<{ installs?: FreemiusInstall[] }>('installs', {
      count: Math.min(count, MAX_PAGE),
      offset,
    });
    return r.installs ?? [];
  }

  /**
   * Events of one type.
   *
   * The API **silently ignores an unrecognised `type`** and returns the
   * unfiltered stream, so a typo yields plausible-looking but wrong rows. Every
   * row is therefore re-checked here, and a mismatch is treated as "no results
   * of this type" rather than passed on as data.
   */
  async listEventsOfType(type: string, offset = 0, count = MAX_PAGE): Promise<FreemiusEvent[]> {
    const r = await this.get<{ events?: FreemiusEvent[] }>('events', {
      count: Math.min(count, MAX_PAGE),
      offset,
      type,
    });
    const rows = r.events ?? [];
    const matching = rows.filter((e) => e.type === type);
    // A page of rows where none match means the filter was dropped, not that the
    // product has events of this type mixed in.
    return matching.length === 0 && rows.length > 0 ? [] : matching;
  }

  /**
   * The uninstall feedback for one install, or null when the user uninstalled
   * without answering — which is roughly half the time, so it is an expected
   * outcome rather than an error.
   */
  async getUninstall(installId: number): Promise<FreemiusUninstall | null> {
    try {
      return await this.get<FreemiusUninstall>(`installs/${installId}/uninstall`);
    } catch (err) {
      if (err instanceof FreemiusApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Cheap credential check used by the connect flow; returns the product title. */
  async verify(): Promise<{ id: number; title: string; slug: string }> {
    const p = await this.getProduct();
    return { id: Number(p.id), title: String(p.title ?? ''), slug: String(p.slug ?? '') };
  }
}
