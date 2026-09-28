import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import type { StreamJobContext } from '../utils/sseStream';
import { getOllamaUrl, getOllamaHeaders, getModel, ollamaErrorMessage, DETERMINISTIC_OPTIONS, KEEP_ALIVE } from '../utils/ollama';
import { Activity } from '../models/Activity';
import { loadAtrsIgnore, ATRSIGNORE_FILE } from '../utils/atrsIgnore';

const execFileP = promisify(execFile);

/** Maximum characters of diff text sent per chunk to the model. */
const MAX_CHUNK_CHARS = 3500;

/**
 * Token caps for the two prompt shapes: a small JSON object, and a full report.
 *
 * `num_predict` is a ceiling, not a target — a model that finishes early stops
 * early — so these are sized for the worst case rather than the typical one.
 * Reasoning models (e.g. `gpt-oss`) spend a few hundred tokens on an internal
 * `thinking` pass *before* emitting `response`, and that comes out of the same
 * budget. The previous caps of 200/220 were consumed by thinking alone, so the
 * JSON came back truncated or empty and every chunk failed to parse.
 */
const JSON_BUDGET = 700;
const REPORT_BUDGET = 2600;

/**
 * Returns the model's `response` text, or throws a message that names the real
 * cause. An empty `response` alongside a populated `thinking` means the token
 * cap ran out during the reasoning pass — reporting that as a JSON parse error
 * (or as "check Ollama connectivity") sends people chasing the wrong problem.
 */
function parseableResponse(data: any, model: string): string {
  const response = String(data?.response ?? '');
  if (response.trim()) return response;
  if (String(data?.thinking ?? '').trim()) {
    throw new Error(
      `Model "${model}" used its whole token budget on reasoning and returned no answer. ` +
      'Raise the budget or pick a non-reasoning model.',
    );
  }
  throw new Error(`Model "${model}" returned an empty response.`);
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro',
  '.py', '.php', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.cs',
  '.css', '.scss', '.sass', '.less', '.html', '.json', '.md', '.sql', '.sh', '.yml', '.yaml',
]);

/** Classify a file path into a high-level category. */
function classifyFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const lower = filePath.toLowerCase().replace(/\\/g, '/');

  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(lower) || lower.includes('__tests__')) return 'test';
  if (/\.(md|txt|rst)$/.test(ext) || lower.includes('docs/')) return 'docs';
  if (/\.(css|scss|sass|less)$/.test(ext)) return 'style';
  if (/\.(json|yml|yaml|toml|env|ini)$/.test(ext) || lower.includes('config')) return 'config';
  if (/webpack|vite|rollup|babel|eslint|prettier|tsconfig|package\.json|dockerfile/i.test(lower)) return 'build';
  if (/^(client|src\/components|src\/pages|src\/hooks|src\/contexts|src\/lib|frontend)/i.test(lower)) return 'frontend';
  if (/^(server|api|src\/controllers|src\/services|src\/models|src\/routes|backend)/i.test(lower)) return 'backend';
  if (CODE_EXTENSIONS.has(ext)) return 'source';
  return 'other';
}

// Which files reach the model is decided by `utils/atrsIgnore.ts`: built-in
// defaults for dependencies, build output, bundles, lockfiles and tests, plus an
// optional per-repo `.atrsignore` that can extend or override them.
//
// This replaced a hardcoded substring filter that dropped any path merely
// containing "dist" or "tools" (so `src/redistribute.ts` never reached the model,
// and every .md file was discarded), and that baked one project's own paths into
// logic shared by every user's repo.

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export type RangeType = 'tags' | 'commit' | 'date' | 'working';

export interface GenerateInput {
  repoPath: string;
  rangeType: RangeType;
  from?: string;
  to?: string;
  model?: string;
  /** Product the generated entries belong to (for the review queue). */
  productId?: string;
  /** Owner the drafted review entries are scoped to. */
  storeId?: string;
  /** When false, skip creating review-queue drafts (reports only). Defaults to true. */
  createReviewEntries?: boolean;
}

interface ChangedFile {
  status: 'A' | 'M' | 'D' | string;
  path: string;
  diff: string;
  category: string;
}

interface ChunkSummary {
  file: string;
  category: string;
  title: string;
  type: 'feature' | 'improvement' | 'bug-fix';
  summary: string;
  impact: string;
  breakingChange: boolean;
}

export interface GenerationResult {
  stats: {
    filesAnalyzed: number;
    chunksProcessed: number;
    commits: number;
    model: string;
    /** Draft changelog entries created in the review queue for this run. */
    reviewEntriesCreated: number;
  };
  outputs: {
    developerChangelog: string;
    userReleaseNotes: string;
    githubReleaseNotes: string;
    qaChecklist: string;
  };
}

// ────────────────────────────────────────────────────────────────────
// Stage 1 — Git Analyzer
// ────────────────────────────────────────────────────────────────────

async function gitAnalyze(
  repoPath: string, rangeType: RangeType, from?: string, to?: string, ctx?: StreamJobContext,
): Promise<{ files: ChangedFile[]; commitMessages: string[]; commitCount: number; range: string }> {
  ctx?.emit({ type: 'info', step: 'git', message: 'Analyzing git history…' });

  const execOpts = { cwd: repoPath, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 };
  let range = '';
  let diffArgs: string[] = [];
  let logArgs: string[] = [];

  switch (rangeType) {
    case 'tags':
      range = `${from}..${to || 'HEAD'}`;
      // --end-of-options guarantees the (schema-validated) range is treated as
      // a revision, never an option, even if a leading-dash value slips past.
      diffArgs = ['diff', '--no-color', '--name-status', '--end-of-options', range];
      logArgs = ['log', '--oneline', '--end-of-options', range];
      break;
    case 'commit':
      range = `${from}..${to || 'HEAD'}`;
      diffArgs = ['diff', '--no-color', '--name-status', '--end-of-options', range];
      logArgs = ['log', '--oneline', '--end-of-options', range];
      break;
    case 'date': {
      // No shell here (execFile takes an argv array), so these quotes were never
      // stripped — git only tolerated them because approxidate skips characters
      // it can't parse. Pass the value bare rather than rely on that.
      const since = `--since=${from}`;
      const until = to ? `--until=${to}` : '';
      logArgs = ['log', '--oneline', since, ...(until ? [until] : [])];
      // For date range we'll use the log to find bounding commits.
      const { stdout: firstCommit } = await execFileP('git', ['log', '--oneline', '--reverse', '--format=%H', since, ...(until ? [until] : [])], execOpts);
      const commits = firstCommit.trim().split('\n').filter(Boolean);
      if (commits.length === 0) {
        return { files: [], commitMessages: [], commitCount: 0, range: '' };
      }
      range = `${commits[0]}~1..${commits[commits.length - 1]}`;
      diffArgs = ['diff', '--no-color', '--name-status', range];
      break;
    }
    case 'working':
      diffArgs = ['diff', '--no-color', '--name-status', 'HEAD'];
      logArgs = [];
      break;
  }

  // Get commit list
  let commitMessages: string[] = [];
  let commitCount = 0;
  if (logArgs.length) {
    try {
      const { stdout } = await execFileP('git', logArgs, execOpts);
      commitMessages = stdout.trim().split('\n').filter(Boolean);
      commitCount = commitMessages.length;
    } catch { /* no commits in range */ }
  }

  // Get changed file list
  let nameStatusOutput = '';
  try {
    const { stdout } = await execFileP('git', diffArgs, execOpts);
    nameStatusOutput = stdout;
  } catch (err: any) {
    throw new Error(`Git diff failed: ${err.message}`);
  }

  // Parse name-status into file entries
  const lines = nameStatusOutput.trim().split('\n').filter(Boolean);
  const parsedFiles: { status: string; path: string }[] = [];
  for (const line of lines) {
    const match = line.match(/^([AMDRC]\d*)\t(.+)$/);
    if (match) {
      parsedFiles.push({ status: match[1][0], path: match[2] });
    }
  }

  // Keep only source files, then collect their per-file diffs.
  const atrsIgnore = loadAtrsIgnore(repoPath);
  const kept = parsedFiles.filter((f) => atrsIgnore.accepts(f.path));
  const skipped = parsedFiles.length - kept.length;
  if (skipped > 0) {
    ctx?.emit({
      type: 'info',
      step: 'git',
      message: atrsIgnore.hasFile
        ? `Skipped ${skipped} non-source file(s) — ${ATRSIGNORE_FILE} (${atrsIgnore.filePatternCount} rules) plus defaults`
        : `Skipped ${skipped} non-source file(s) — default ignore rules (add ${ATRSIGNORE_FILE} to customise)`,
    });
  }

  const files: ChangedFile[] = [];
  const diffRange = rangeType === 'working' ? ['HEAD'] : ['--end-of-options', range];

  for (const f of kept) {
    let diff = '';
    if (f.status !== 'D') {
      try {
        const { stdout } = await execFileP(
          'git', ['diff', '--no-color', ...diffRange, '--', f.path],
          { ...execOpts, maxBuffer: 2 * 1024 * 1024 },
        );
        diff = stdout.trim();
      } catch { /* deleted or binary — skip diff */ }
    }
    files.push({
      status: f.status,
      path: f.path,
      diff,
      category: classifyFile(f.path),
    });
  }

  ctx?.emit({ type: 'success', step: 'git', message: `Found ${files.length} changed files across ${commitCount} commits` });
  return { files, commitMessages, commitCount, range };
}

// ────────────────────────────────────────────────────────────────────
// Stage 2 — Code Analyzer (classify & chunk)
// ────────────────────────────────────────────────────────────────────

interface Chunk {
  file: string;
  category: string;
  diff: string;
  index: number;
  total: number;
}

function buildChunks(files: ChangedFile[], ctx?: StreamJobContext): Chunk[] {
  ctx?.emit({ type: 'info', step: 'classify', message: `Classifying ${files.length} files…` });

  const chunks: Chunk[] = [];
  for (const f of files) {
    if (!f.diff) {
      // Deleted files or no diff — still include as a single entry
      chunks.push({ file: f.path, category: f.category, diff: `[${f.status}] ${f.path} (no diff)`, index: 0, total: 1 });
      continue;
    }
    if (f.diff.length <= MAX_CHUNK_CHARS) {
      chunks.push({ file: f.path, category: f.category, diff: f.diff, index: 0, total: 1 });
    } else {
      // Split the diff on hunk headers (@@ ... @@) to get logical pieces.
      const hunks = f.diff.split(/(?=^@@\s)/m).filter(Boolean);
      let current = '';
      let chunkIndex = 0;
      const subChunks: string[] = [];
      for (const hunk of hunks) {
        if ((current + hunk).length > MAX_CHUNK_CHARS && current) {
          subChunks.push(current);
          current = hunk;
        } else {
          current += hunk;
        }
      }
      if (current) subChunks.push(current);

      for (const sub of subChunks) {
        chunks.push({ file: f.path, category: f.category, diff: sub.slice(0, MAX_CHUNK_CHARS), index: chunkIndex++, total: subChunks.length });
      }
    }
  }

  const catCounts: Record<string, number> = {};
  for (const c of chunks) catCounts[c.category] = (catCounts[c.category] || 0) + 1;
  const catSummary = Object.entries(catCounts).map(([k, v]) => `${k}:${v}`).join(', ');
  ctx?.emit({ type: 'success', step: 'classify', message: `Created ${chunks.length} chunks (${catSummary})` });

  return chunks;
}

// ────────────────────────────────────────────────────────────────────
// Stage 3 — Summarizer (Ollama per-chunk)
// ────────────────────────────────────────────────────────────────────

async function summarizeChunk(chunk: Chunk, model: string): Promise<ChunkSummary> {
  const prompt = [
    'You are a senior developer writing changelog entries.',
    'From the diff below, produce a JSON object with:',
    '- "title": imperative mood, max 10 words, no trailing period',
    '- "type": one of "feature" | "improvement" | "bug-fix"',
    '- "summary": one concise sentence describing what changed',
    '- "impact": one sentence on how this affects users or developers',
    '- "breakingChange": boolean — true if this could break existing behaviour',
    '',
    'Respond with JSON only: {"title": string, "type": string, "summary": string, "impact": string, "breakingChange": boolean}',
    '',
    `File: ${chunk.file} (${chunk.category})`,
    chunk.total > 1 ? `Part ${chunk.index + 1} of ${chunk.total}` : '',
    'Diff:',
    chunk.diff,
  ].join('\n');

  const res = await fetch(`${getOllamaUrl()}/api/generate`, {
    method: 'POST',
    headers: getOllamaHeaders(),
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      format: 'json',
      keep_alive: KEEP_ALIVE,
      options: { ...DETERMINISTIC_OPTIONS, num_predict: JSON_BUDGET },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(ollamaErrorMessage(res.status, body, model));
  }

  const data: any = await res.json();
  const parsed = JSON.parse(parseableResponse(data, model));

  return {
    file: chunk.file,
    category: chunk.category,
    title: String(parsed.title || '').trim().replace(/\.$/, '').slice(0, 120),
    type: ['feature', 'improvement', 'bug-fix'].includes(parsed.type) ? parsed.type : 'improvement',
    summary: String(parsed.summary || '').trim().slice(0, 400),
    impact: String(parsed.impact || '').trim().slice(0, 400),
    breakingChange: !!parsed.breakingChange,
  };
}

async function summarizeAll(chunks: Chunk[], model: string, ctx?: StreamJobContext): Promise<ChunkSummary[]> {
  ctx?.emit({ type: 'info', step: 'summarize', message: `Summarizing ${chunks.length} chunks with ${model}…` });

  const summaries: ChunkSummary[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (ctx?.isCancelled()) {
      ctx.emit({ type: 'warn', step: 'summarize', message: 'Cancelled by user' });
      break;
    }
    ctx?.emit({
      type: 'info', step: 'summarize',
      message: `Summarizing ${chunks[i].file}${chunks[i].total > 1 ? ` (part ${chunks[i].index + 1}/${chunks[i].total})` : ''}`,
      itemIndex: i + 1,
      totalItems: chunks.length,
      label: chunks[i].file.split('/').pop(),
    });

    try {
      const summary = await summarizeChunk(chunks[i], model);
      summaries.push(summary);
    } catch (err: any) {
      ctx?.emit({ type: 'error', step: 'summarize', message: `Failed on ${chunks[i].file}: ${err.message}` });
      // Continue with remaining chunks
    }
  }

  ctx?.emit({ type: 'success', step: 'summarize', message: `Summarized ${summaries.length}/${chunks.length} chunks` });
  return summaries;
}

// ────────────────────────────────────────────────────────────────────
// Stage 4 — Report Generator (Ollama final synthesis)
// ────────────────────────────────────────────────────────────────────

const REPORT_PROMPTS: Record<string, string> = {
  developerChangelog: [
    'You are a technical writer creating a DEVELOPER CHANGELOG.',
    'From the structured summaries below, produce a comprehensive developer-oriented changelog in markdown.',
    'Rules:',
    '- Group changes by category (Backend, Frontend, Config, Tests, etc.)',
    '- Include file paths in parentheses',
    '- Flag any breaking changes with ⚠️',
    '- Use imperative mood for entries',
    '- Include a "Migration Notes" section if there are breaking changes',
    '- Start with a brief overview paragraph',
  ].join('\n'),

  userReleaseNotes: [
    'You are a technical writer creating USER-FACING RELEASE NOTES.',
    'From the structured summaries below, produce polished, non-technical release notes in markdown.',
    'Rules:',
    '- NO file paths, function names, or code references',
    '- Focus on WHAT changed for the user, not HOW',
    '- Group into: ✨ New Features, 🔧 Improvements, 🐛 Bug Fixes',
    '- Use friendly, concise language',
    '- Start with a brief intro paragraph',
    '- Skip purely internal/test changes',
  ].join('\n'),

  githubReleaseNotes: [
    'You are creating GITHUB RELEASE NOTES in markdown.',
    'From the summaries below, produce compact release notes suitable for a GitHub Release.',
    'Rules:',
    '- Use ### headers for sections (Features, Improvements, Bug Fixes)',
    '- Use bullet points for each change',
    '- Keep entries to one line each',
    '- Include a "Breaking Changes" section if applicable',
    '- Add a "Contributors" mention if authors are available',
    '- Keep it concise — GitHub releases should be scannable',
  ].join('\n'),

  qaChecklist: [
    'You are a QA engineer creating a TEST CHECKLIST.',
    'From the structured summaries below, produce a QA checklist in markdown.',
    'Rules:',
    '- Use checkbox syntax: - [ ] for each item',
    '- Group by area/component',
    '- Include specific things to verify for each change',
    '- Add a "Regression Risk" section rating areas that might be affected',
    '- Include a "Smoke Test" section with critical-path items',
    '- Flag any changes that need special test environments',
  ].join('\n'),
};

async function generateReport(
  summaries: ChunkSummary[],
  commitMessages: string[],
  model: string,
  format: string,
  ctx?: StreamJobContext,
): Promise<string> {
  const systemPrompt = REPORT_PROMPTS[format];
  const summaryText = summaries.map((s) => [
    `- **${s.title}** [${s.type}] (${s.file}, ${s.category})`,
    `  Summary: ${s.summary}`,
    `  Impact: ${s.impact}`,
    s.breakingChange ? '  ⚠️ BREAKING CHANGE' : '',
  ].filter(Boolean).join('\n')).join('\n');

  const prompt = [
    systemPrompt,
    '',
    'Commit messages:',
    commitMessages.slice(0, 100).join('\n') || '(no commits — working tree diff)',
    '',
    'Change summaries:',
    summaryText,
    '',
    'Now produce the output in markdown. Do not wrap in code fences.',
  ].join('\n');

  const res = await fetch(`${getOllamaUrl()}/api/generate`, {
    method: 'POST',
    headers: getOllamaHeaders(),
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: { ...DETERMINISTIC_OPTIONS, num_predict: REPORT_BUDGET },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(ollamaErrorMessage(res.status, body, model));
  }

  const data: any = await res.json();
  return String(data.response || '').trim();
}

async function generateAllReports(
  summaries: ChunkSummary[],
  commitMessages: string[],
  model: string,
  ctx?: StreamJobContext,
): Promise<GenerationResult['outputs']> {
  const formats = ['developerChangelog', 'userReleaseNotes', 'githubReleaseNotes', 'qaChecklist'] as const;
  const labels: Record<string, string> = {
    developerChangelog: 'Developer Changelog',
    userReleaseNotes: 'User Release Notes',
    githubReleaseNotes: 'GitHub Release Notes',
    qaChecklist: 'QA Checklist',
  };

  const outputs: Record<string, string> = {};

  for (let i = 0; i < formats.length; i++) {
    if (ctx?.isCancelled()) {
      ctx.emit({ type: 'warn', step: 'report', message: 'Cancelled by user' });
      break;
    }
    const fmt = formats[i];
    ctx?.emit({
      type: 'info', step: 'report',
      message: `Generating ${labels[fmt]}…`,
      itemIndex: i + 1,
      totalItems: formats.length,
      label: labels[fmt],
    });

    try {
      outputs[fmt] = await generateReport(summaries, commitMessages, model, fmt, ctx);
    } catch (err: any) {
      ctx?.emit({ type: 'error', step: 'report', message: `Failed: ${labels[fmt]} — ${err.message}` });
      outputs[fmt] = `> ⚠️ Generation failed: ${err.message}`;
    }
  }

  ctx?.emit({ type: 'success', step: 'report', message: 'All reports generated' });
  return outputs as GenerationResult['outputs'];
}

// ────────────────────────────────────────────────────────────────────
// Stage 5 — Review-queue drafts (one entry per logical change)
// ────────────────────────────────────────────────────────────────────

/** Cap on commits summarized per run, and on the diff size sent per commit. */
const MAX_COMMITS = 100;
const MAX_COMMIT_DIFF_CHARS = 6000;

/** A single AI-drafted changelog entry destined for the review queue. */
interface ReviewEntry {
  /** Dedupe suffix, unique per logical change (e.g. `commit|<hash>` or `logical|<slug>`). */
  key: string;
  title: string;
  type: 'feature' | 'improvement' | 'bug-fix';
  summary: string;
  impact: string;
  breakingChange: boolean;
}

function normalizeType(t: any): ReviewEntry['type'] {
  return ['feature', 'improvement', 'bug-fix'].includes(t) ? t : 'improvement';
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'change';
}

/** Lists commits in a range as {hash, subject, body}, newest first, capped. */
async function getCommits(
  repoPath: string, range: string, ctx?: StreamJobContext,
): Promise<{ hash: string; subject: string; body: string }[]> {
  const execOpts = { cwd: repoPath, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 };
  // Unit separator (\x1f) between fields, record separator (\x1e) between commits.
  const format = '%H%x1f%s%x1f%b%x1e';
  let stdout = '';
  try {
    ({ stdout } = await execFileP('git', ['log', '--no-color', `--format=${format}`, range], execOpts));
  } catch {
    return [];
  }
  const commits = stdout.split('\x1e')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [hash, subject, body] = rec.split('\x1f');
      return { hash: (hash || '').trim(), subject: (subject || '').trim(), body: (body || '').trim() };
    })
    .filter((c) => c.hash);
  if (commits.length > MAX_COMMITS) {
    ctx?.emit({ type: 'warn', step: 'review', message: `Range has ${commits.length} commits — drafting entries for the ${MAX_COMMITS} most recent` });
    return commits.slice(0, MAX_COMMITS);
  }
  return commits;
}

/** Summarizes one commit (message + diff) into a single changelog entry. */
async function summarizeCommit(
  commit: { hash: string; subject: string; body: string }, repoPath: string, model: string,
): Promise<ReviewEntry> {
  let diff = '';
  try {
    const { stdout } = await execFileP(
      'git', ['show', commit.hash, '--no-color', '--format='],
      { cwd: repoPath, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );
    diff = stdout.trim().slice(0, MAX_COMMIT_DIFF_CHARS);
  } catch { /* merge/binary/empty — rely on the message */ }

  const prompt = [
    'You are a senior developer writing a single changelog entry for one git commit.',
    'Use the commit message as the primary signal and the diff for detail.',
    'Produce JSON only: {"title": string, "type": "feature"|"improvement"|"bug-fix", "summary": string, "impact": string, "breakingChange": boolean}',
    '- "title": imperative mood, max 10 words, no trailing period',
    '- "summary": one concise sentence describing what changed',
    '- "impact": one sentence on how this affects users or developers',
    '',
    `Commit subject: ${commit.subject}`,
    commit.body ? `Commit body:\n${commit.body}` : '',
    'Diff:',
    diff || '(no textual diff available)',
  ].filter(Boolean).join('\n');

  let parsed: any = {};
  try {
    const res = await fetch(`${getOllamaUrl()}/api/generate`, {
      method: 'POST',
      headers: getOllamaHeaders(),
      body: JSON.stringify({
        model, prompt, stream: false, format: 'json', keep_alive: KEEP_ALIVE,
        options: { ...DETERMINISTIC_OPTIONS, num_predict: JSON_BUDGET },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(ollamaErrorMessage(res.status, body, model));
    }
    const data: any = await res.json();
    parsed = JSON.parse(parseableResponse(data, model));
  } catch {
    // Fall back to the commit subject so a model hiccup still yields an entry.
    parsed = {};
  }

  return {
    key: `commit|${commit.hash}`,
    title: (String(parsed.title || '').trim() || commit.subject || 'Update').replace(/\.$/, '').slice(0, 200),
    type: normalizeType(parsed.type),
    summary: String(parsed.summary || commit.subject || '').trim().slice(0, 600),
    impact: String(parsed.impact || '').trim().slice(0, 600),
    breakingChange: !!parsed.breakingChange,
  };
}

/** Summarizes every commit in the range into one review entry each. */
async function summarizeCommits(
  repoPath: string, range: string, model: string, ctx?: StreamJobContext,
): Promise<ReviewEntry[]> {
  const commits = await getCommits(repoPath, range, ctx);
  if (commits.length === 0) return [];

  ctx?.emit({ type: 'info', step: 'review', message: `Drafting ${commits.length} entries — one per commit…` });
  const entries: ReviewEntry[] = [];
  for (let i = 0; i < commits.length; i++) {
    if (ctx?.isCancelled()) break;
    ctx?.emit({
      type: 'info', step: 'review',
      message: `Commit ${commits[i].hash.slice(0, 7)}: ${commits[i].subject}`,
      itemIndex: i + 1, totalItems: commits.length, label: commits[i].hash.slice(0, 7),
    });
    entries.push(await summarizeCommit(commits[i], repoPath, model));
  }
  return entries;
}

/**
 * Working-tree fallback: no commits to key off, so cluster the per-file
 * summaries into logical changelog entries in a single grouping pass.
 */
async function synthesizeLogicalEntries(
  summaries: ChunkSummary[], model: string, ctx?: StreamJobContext,
): Promise<ReviewEntry[]> {
  ctx?.emit({ type: 'info', step: 'review', message: 'Grouping changes into logical entries…' });

  const summaryText = summaries.map((s) =>
    `- [${s.type}] ${s.title} (${s.file}): ${s.summary}${s.breakingChange ? ' [BREAKING]' : ''}`,
  ).join('\n');

  const prompt = [
    'You are a senior developer turning file-level change summaries into a concise changelog.',
    'Cluster related changes (e.g. several files that together implement one feature) into a single logical entry.',
    'Respond with JSON only: {"entries": [{"title": string, "type": "feature"|"improvement"|"bug-fix", "summary": string, "impact": string, "breakingChange": boolean}]}',
    '- "title": imperative mood, max 10 words, no trailing period',
    '- Merge duplicates; do not emit one entry per file when they belong together.',
    '',
    'File-level summaries:',
    summaryText,
  ].join('\n');

  try {
    const res = await fetch(`${getOllamaUrl()}/api/generate`, {
      method: 'POST',
      headers: getOllamaHeaders(),
      body: JSON.stringify({
        model, prompt, stream: false, format: 'json', keep_alive: KEEP_ALIVE,
        options: { ...DETERMINISTIC_OPTIONS, num_predict: REPORT_BUDGET },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(ollamaErrorMessage(res.status, body, model));
    }
    const data: any = await res.json();
    const parsed = JSON.parse(parseableResponse(data, model));
    const list: any[] = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const seen = new Set<string>();
    return list.map((e, idx) => {
      const title = String(e.title || '').trim().replace(/\.$/, '').slice(0, 200) || `Change ${idx + 1}`;
      let slug = slugify(title);
      while (seen.has(slug)) slug = `${slug}-${idx}`;
      seen.add(slug);
      return {
        key: `logical|${slug}`,
        title,
        type: normalizeType(e.type),
        summary: String(e.summary || '').trim().slice(0, 600),
        impact: String(e.impact || '').trim().slice(0, 600),
        breakingChange: !!e.breakingChange,
      };
    });
  } catch (err: any) {
    ctx?.emit({ type: 'error', step: 'review', message: `Grouping failed: ${err.message}` });
    return [];
  }
}

/**
 * Upserts AI-drafted entries into the review queue (needsReview). Re-running for
 * the same product/change refreshes the still-pending draft instead of piling up
 * duplicates; entries a user has already confirmed (needsReview=false) are left
 * untouched.
 */
async function persistReviewEntries(
  entries: ReviewEntry[],
  productId: string,
  storeId: string,
  ctx?: StreamJobContext,
): Promise<number> {
  let created = 0;
  for (const e of entries) {
    const shortDescription = (e.summary || e.title)
      + (e.impact ? `\n\nImpact: ${e.impact}` : '')
      + (e.breakingChange ? '\n\n⚠️ Potential breaking change.' : '');
    const importSourceKey = `ai-gen|${productId}|${e.key}`;
    try {
      const doc = await Activity.findOneAndUpdate(
        { importSourceKey, needsReview: true },
        {
          $set: {
            productId, storeId,
            type: e.type,
            title: e.title,
            shortDescription,
            needsReview: true,
            reviewReason: 'ai-generated',
          },
          $setOnInsert: {
            tags: ['unreleased', 'ai-generated'],
            activityDate: new Date(),
            importSourceKey,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      if (doc) created++;
    } catch (err: any) {
      ctx?.emit({ type: 'error', step: 'review', message: `Failed to draft "${e.title}": ${err.message}` });
    }
  }
  ctx?.emit({ type: 'success', step: 'review', message: `${created} entries sent to the review queue` });
  return created;
}

// ────────────────────────────────────────────────────────────────────
// Public API — orchestrates the full pipeline
// ────────────────────────────────────────────────────────────────────

export async function runPipeline(
  input: GenerateInput,
  ctx: StreamJobContext,
): Promise<GenerationResult> {
  const model = input.model?.trim() || getModel();

  // Stage 1: Git Analyzer
  const { files, commitMessages, commitCount, range } = await gitAnalyze(
    input.repoPath, input.rangeType, input.from, input.to, ctx,
  );

  if (files.length === 0) {
    ctx.emit({ type: 'warn', step: 'git', message: 'No changes found in the specified range' });
    return {
      stats: { filesAnalyzed: 0, chunksProcessed: 0, commits: commitCount, model, reviewEntriesCreated: 0 },
      outputs: {
        developerChangelog: '> No changes found in the specified range.',
        userReleaseNotes: '> No changes found in the specified range.',
        githubReleaseNotes: '> No changes found in the specified range.',
        qaChecklist: '> No changes found in the specified range.',
      },
    };
  }

  // Stage 2: Code Analyzer
  const chunks = buildChunks(files, ctx);

  // Stage 3: Summarizer
  const summaries = await summarizeAll(chunks, model, ctx);

  if (summaries.length === 0) {
    // Every chunk failed. Connectivity is only one possible cause — the model
    // name, the token budget and a refused key all land here too, so point at
    // the per-chunk errors already streamed rather than guessing.
    throw new Error(
      `No chunks could be summarised with model "${model}". See the per-file errors above for the cause.`,
    );
  }

  // Stage 4: Report Generator
  const outputs = await generateAllReports(summaries, commitMessages, model, ctx);

  // Stage 5: Draft review-queue entries — one per commit for commit-based
  // ranges, or a single AI-grouped pass for the working tree (no commits).
  // Skipped when the caller opts out or the product is unknown.
  let reviewEntriesCreated = 0;
  if (input.createReviewEntries !== false && input.productId && input.storeId) {
    const commitBased = input.rangeType !== 'working' && !!range;
    let entries: ReviewEntry[] = [];
    if (commitBased) {
      entries = await summarizeCommits(input.repoPath, range, model, ctx);
    }
    // Fall back to logical grouping for the working tree, or if a commit-based
    // range yielded no commits (e.g. only uncommitted changes present).
    if (entries.length === 0) {
      entries = await synthesizeLogicalEntries(summaries, model, ctx);
    }
    reviewEntriesCreated = await persistReviewEntries(entries, input.productId, input.storeId, ctx);
  }

  return {
    stats: {
      filesAnalyzed: files.length,
      chunksProcessed: chunks.length,
      commits: commitCount,
      model,
      reviewEntriesCreated,
    },
    outputs,
  };
}
