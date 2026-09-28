import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { FreemiusClient, FreemiusApiError } from './FreemiusClient';

const CREDS = { entityId: '6749', publicKey: 'pk_test', secretKey: 'sk_test' };

/** Captured requests, so assertions can inspect exactly what was signed and sent. */
let calls: Array<{ url: string; headers: Record<string, string> }> = [];
/** Optional `responseHeaders` lets a case exercise Retry-After handling. */
let respond: (url: string) => { status: number; body: any; responseHeaders?: Record<string, string> };

const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  respond = () => ({ status: 200, body: {} });
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: { ...(init?.headers || {}) } });
    const { status, body, responseHeaders } = respond(String(url));
    const hdrs = new Headers(responseHeaders || {});
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: hdrs,
      text: async () => JSON.stringify(body),
    } as any;
  }) as any;
});

afterEach(() => { globalThis.fetch = realFetch; });

/** Recomputes the expected signature independently of the implementation. */
function expectedSig(signedPath: string, date: string) {
  const stringToSign = ['GET', '', '', date, signedPath].join('\n');
  const hex = crypto.createHmac('sha256', CREDS.secretKey).update(stringToSign, 'utf8').digest('hex');
  return Buffer.from(hex, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

describe('request signing', () => {
  it('signs the path WITHOUT the query string', async () => {
    // The live API answers 401 when the query is included — the PHP SDK's
    // CanonizePath() appends it, which is the trap this encodes.
    respond = () => ({ status: 200, body: { installs: [] } });
    const c = new FreemiusClient(CREDS);
    await c.listInstalls(100, 50);

    const { url, headers } = calls[0];
    expect(url).toBe('https://api.freemius.com/v1/plugins/6749/installs.json?count=50&offset=100');

    const sig = headers.Authorization.split(':').pop()!;
    expect(sig).toBe(expectedSig('/v1/plugins/6749/installs.json', headers.Date));
    // And is definitely not the signature over the queried path.
    expect(sig).not.toBe(expectedSig('/v1/plugins/6749/installs.json?count=50&offset=100', headers.Date));
  });

  it('base64url-encodes the HEX digest, matching the PHP SDK', async () => {
    const c = new FreemiusClient(CREDS);
    await c.getProduct();
    const { headers } = calls[0];
    const sig = headers.Authorization.split(':').pop()!;

    const path = '/v1/plugins/6749.json';
    const stringToSign = ['GET', '', '', headers.Date, path].join('\n');
    const raw = crypto.createHmac('sha256', CREDS.secretKey).update(stringToSign, 'utf8').digest();
    const rawEncoded = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    expect(sig).toBe(expectedSig(path, headers.Date));
    expect(sig).not.toBe(rawEncoded); // signing raw bytes is the other easy mistake
  });

  it('uses the FS scheme and an RFC-2822 date with a numeric offset', async () => {
    const c = new FreemiusClient(CREDS);
    await c.getProduct();
    const { headers } = calls[0];
    expect(headers.Authorization).toMatch(/^FS 6749:pk_test:/);
    expect(headers.Date).toMatch(/\+0000$/);
    expect(headers.Date).not.toMatch(/GMT/);
  });

  it('switches to FSP when the keys are identical', async () => {
    const c = new FreemiusClient({ entityId: '1', publicKey: 'same', secretKey: 'same' });
    await c.getProduct();
    expect(calls[0].headers.Authorization).toMatch(/^FSP /);
  });
});

describe('path building', () => {
  it('builds plugin-scope paths', async () => {
    await new FreemiusClient(CREDS).getProduct();
    expect(calls[0].url).toBe('https://api.freemius.com/v1/plugins/6749.json');
  });

  it('builds developer-scope paths from the same client', async () => {
    respond = () => ({ status: 200, body: { installs: [] } });
    await new FreemiusClient({ ...CREDS, scope: 'developer' }).listInstalls(0);
    expect(calls[0].url).toContain('/v1/developers/6749/installs.json');
  });

  it('does not double the .json suffix', async () => {
    await new FreemiusClient(CREDS).get('installs.json');
    expect(calls[0].url).toBe('https://api.freemius.com/v1/plugins/6749/installs.json');
  });

  it('caps a page at the API maximum of 50', async () => {
    respond = () => ({ status: 200, body: { installs: [] } });
    await new FreemiusClient(CREDS).listInstalls(0, 500);
    expect(calls[0].url).toContain('count=50');
  });
});

describe('event type filter guard', () => {
  it('returns matching rows when the filter is honoured', async () => {
    respond = () => ({ status: 200, body: { events: [
      { id: 1, type: 'install.uninstalled', install_id: 11 },
      { id: 2, type: 'install.uninstalled', install_id: 12 },
    ] } });
    const rows = await new FreemiusClient(CREDS).listEventsOfType('install.uninstalled');
    expect(rows).toHaveLength(2);
  });

  it('returns nothing when the API ignores the filter and sends the raw stream', async () => {
    // The live API does exactly this for an unrecognised type: 200 with
    // unrelated events whose {from,to} payload looks plausible.
    respond = () => ({ status: 200, body: { events: [
      { id: 1, type: 'install.version.upgraded', data: { from: '1.0', to: '1.1' } },
      { id: 2, type: 'install.platform.version.updated' },
    ] } });
    const rows = await new FreemiusClient(CREDS).listEventsOfType('uninstall.created');
    expect(rows).toEqual([]);
  });

  it('drops stray non-matching rows from an otherwise filtered page', async () => {
    respond = () => ({ status: 200, body: { events: [
      { id: 1, type: 'install.uninstalled', install_id: 11 },
      { id: 2, type: 'install.version.upgraded' },
    ] } });
    const rows = await new FreemiusClient(CREDS).listEventsOfType('install.uninstalled');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
  });
});

describe('uninstall retrieval', () => {
  it('returns the record when feedback exists', async () => {
    respond = () => ({ status: 200, body: { id: 5, install_id: 11, reason_id: 15, reason: 'Temporary deactivation' } });
    const u = await new FreemiusClient(CREDS).getUninstall(11);
    expect(u!.reason).toBe('Temporary deactivation');
  });

  it('treats 404 as "no feedback given", not an error', async () => {
    // ~45% of uninstalls, so this must not throw.
    respond = () => ({ status: 404, body: { error: { message: 'Uninstall 11 not found.' } } });
    await expect(new FreemiusClient(CREDS).getUninstall(11)).resolves.toBeNull();
  });

  it('still raises other failures', async () => {
    respond = () => ({ status: 401, body: { error: { message: 'Invalid Authorization header.' } } });
    await expect(new FreemiusClient(CREDS).getUninstall(11)).rejects.toThrow(FreemiusApiError);
  });

  it('carries status and path on the error for diagnosis', async () => {
    respond = () => ({ status: 500, body: { error: { message: 'boom' } } });
    try {
      await new FreemiusClient(CREDS).getProduct();
      expect.unreachable();
    } catch (e: any) {
      expect(e.status).toBe(500);
      expect(e.path).toBe('/v1/plugins/6749.json');
    }
  });
});

describe('rate limiting', () => {
  /** Records requested sleeps instead of waiting, so the tests stay instant. */
  const fakeSleep = () => {
    const slept: number[] = [];
    return { slept, sleep: async (ms: number) => { slept.push(ms); } };
  };

  it('paces successive requests on the same client', async () => {
    const { slept, sleep } = fakeSleep();
    const c = new FreemiusClient(CREDS, { minIntervalMs: 250, sleep });
    await c.getProduct();
    await c.getProduct();
    // First request goes straight out; the second waits out the gap.
    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThan(0);
    expect(slept[0]).toBeLessThanOrEqual(250);
  });

  it('retries a throttled request and returns the eventual success', async () => {
    const { slept, sleep } = fakeSleep();
    let n = 0;
    respond = () => (++n < 3
      ? { status: 429, body: { error: { message: 'Too many requests. Please try again later.' } } }
      : { status: 200, body: { id: 6749, title: 'ok', slug: 's' } });

    const c = new FreemiusClient(CREDS, { minIntervalMs: 0, sleep });
    await expect(c.verify()).resolves.toMatchObject({ title: 'ok' });
    expect(n).toBe(3);
    // Geometric backoff: 1s then 2s.
    expect(slept).toEqual([1000, 2000]);
  });

  it('recognises throttling sent without a 429 status', async () => {
    const { sleep } = fakeSleep();
    let n = 0;
    respond = () => (++n < 2
      ? { status: 400, body: { error: { message: 'Too many requests. Please try again later.' } } }
      : { status: 200, body: { installs: [] } });
    const c = new FreemiusClient(CREDS, { minIntervalMs: 0, sleep });
    await expect(c.listInstalls(0)).resolves.toEqual([]);
    expect(n).toBe(2);
  });

  it('gives up after the retry budget and reports it as rate limiting', async () => {
    const { slept, sleep } = fakeSleep();
    respond = () => ({ status: 429, body: { error: { message: 'Too many requests.' } } });
    const c = new FreemiusClient(CREDS, { minIntervalMs: 0, maxRetries: 2, sleep });
    try {
      await c.getProduct();
      expect.unreachable();
    } catch (e: any) {
      expect(e.isRateLimited).toBe(true);
      expect(slept).toHaveLength(2);
    }
  });

  it('honours Retry-After when the API sends one', async () => {
    const { slept, sleep } = fakeSleep();
    let n = 0;
    respond = () => (++n < 2
      ? { status: 429, body: { error: { message: 'Too many requests.' } }, responseHeaders: { 'retry-after': '7' } }
      : { status: 200, body: {} });
    const c = new FreemiusClient(CREDS, { minIntervalMs: 0, sleep });
    await c.getProduct();
    expect(slept).toEqual([7000]);
  });

  it('does not retry an ordinary failure', async () => {
    const { sleep } = fakeSleep();
    let n = 0;
    respond = () => { n++; return { status: 401, body: { error: { message: 'Invalid Authorization header.' } } }; };
    const c = new FreemiusClient(CREDS, { minIntervalMs: 0, sleep });
    await expect(c.getProduct()).rejects.toThrow(/Invalid Authorization/);
    expect(n).toBe(1);
  });

  it('re-signs each retry, since the Date header is part of the signature', async () => {
    const { sleep } = fakeSleep();
    let n = 0;
    respond = () => (++n < 2 ? { status: 429, body: {} } : { status: 200, body: {} });
    const c = new FreemiusClient(CREDS, { minIntervalMs: 0, sleep });
    await c.getProduct();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers.Authorization.split(':').pop())
        .toBe(expectedSig('/v1/plugins/6749.json', call.headers.Date));
    }
  });
});

describe('construction', () => {
  it('refuses incomplete credentials rather than sending unsigned requests', () => {
    expect(() => new FreemiusClient({ entityId: '', publicKey: 'p', secretKey: 's' })).toThrow(/incomplete/i);
    expect(() => new FreemiusClient({ entityId: '1', publicKey: '', secretKey: 's' })).toThrow(/incomplete/i);
  });
});
