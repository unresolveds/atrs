import { readAppConfig } from './appConfig';
import { unsealSecret } from './crypto';

/** Reads the `changelogGen` block from the app config (empty object on any failure). */
function readConfig(): any {
  try {
    return readAppConfig()?.changelogGen || {};
  } catch { /* fall through to defaults */ }
  return {};
}

/**
 * Resolves the Ollama base URL from config. In "cloud" mode the configured
 * endpoint is used; otherwise we fall back to the local daemon. A trailing
 * `/api/generate` (as pasted from the Ollama docs) and any trailing slashes
 * are stripped so callers can append their own path.
 */
export function getOllamaUrl(): string {
  const cfg = readConfig();
  let url = '';
  if (cfg.ollamaMode === 'cloud') {
    url = String(cfg.ollamaCloudUrl || process.env.OLLAMA_CLOUD_URL || '').trim();
  }
  if (!url) {
    url = process.env.OLLAMA_URL || 'http://localhost:11434';
  }
  url = url.replace(/\/+$/, '');
  if (url.endsWith('/api/generate')) {
    url = url.slice(0, -'/api/generate'.length);
  }
  return url || 'http://localhost:11434';
}

/** Request headers, including the Bearer token when a cloud API key is set. */
export function getOllamaHeaders(): Record<string, string> {
  const cfg = readConfig();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.ollamaMode === 'cloud') {
    // Stored keys are sealed at rest; the OLLAMA_CLOUD_KEY env var is the
    // fallback (and the primary source on serverless deployments).
    const key =
      unsealSecret(String(cfg.ollamaCloudKey || '').trim()) ||
      String(process.env.OLLAMA_CLOUD_KEY || '').trim();
    if (key) headers['Authorization'] = `Bearer ${key}`;
  }
  return headers;
}

/** The configured model name (shared by every generation call). */
export function getModel(): string {
  return readConfig().model || 'qwen2.5-coder';
}

/** Current mode — 'cloud' when a remote endpoint is configured, else 'local'. */
export function getOllamaMode(): 'local' | 'cloud' {
  return readConfig().ollamaMode === 'cloud' ? 'cloud' : 'local';
}

/**
 * Maps an Ollama HTTP failure to an actionable message. Auth failures in cloud
 * mode are almost always a missing/invalid API key, and a missing model reads
 * very differently on a remote endpoint than a local `ollama pull`.
 */
export function ollamaErrorMessage(status: number, body: string, model: string): string {
  const cloud = getOllamaMode() === 'cloud';
  if (status === 401 || status === 403) {
    return cloud
      ? `Ollama Cloud rejected the request (${status}) — add a valid API key in Settings → Git Changelog Generator.`
      : `Ollama rejected the request (${status}) — check the endpoint's authentication.`;
  }
  if (status === 404 || /not found/i.test(body)) {
    return cloud
      ? `Model "${model}" isn't available on this Ollama Cloud endpoint — pick a model it serves.`
      : `Model "${model}" not found — run: ollama pull ${model}`;
  }
  const detail = body.trim().slice(0, 200);
  return `Ollama responded ${status}${detail ? ` — ${detail}` : ''}`;
}

/**
 * Deterministic sampling options. Greedy decoding (temperature 0) plus a fixed
 * seed makes a given (model, prompt) produce byte-identical output — so the
 * "local" and "cloud" Ollama modes yield the same result for the same model.
 * Spread this into each request's `options` and add per-call `num_predict`.
 */
export const DETERMINISTIC_OPTIONS = {
  temperature: 0,
  top_p: 1,
  top_k: 0,
  seed: 42,
} as const;

/** Keep the model resident between calls so back-to-back requests stay fast. */
export const KEEP_ALIVE = '30m';
