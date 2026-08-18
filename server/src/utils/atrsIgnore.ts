import fs from 'fs';
import path from 'path';
import ignore, { type Ignore } from 'ignore';

/** Name of the per-repo ignore file, read from the working copy root. */
export const ATRSIGNORE_FILE = '.atrsignore';

/**
 * Paths whose diffs are never worth an AI summary: dependencies, build output,
 * bundled/minified artefacts, lockfiles and tests. The model should reason about
 * source changes only — generated files add tokens and dilute the changelog.
 *
 * These apply when a repo has no `.atrsignore`, and as the base layer when it
 * does. Because gitignore semantics are last-match-wins, a repo can re-include
 * anything here with a negation (e.g. `!tests/` to summarise test changes).
 */
export const DEFAULT_ATRSIGNORE_PATTERNS: readonly string[] = [
  // Dependencies
  'node_modules/',
  'vendor/',
  'bower_components/',
  // Build / release output
  'dist/',
  'build/',
  'out/',
  'release/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  'coverage/',
  // Bundled, minified and generated assets
  '*.min.js',
  '*.min.css',
  '*.bundle.js',
  '*.bundle.css',
  '*.map',
  // Lockfiles — huge diffs, no reviewable intent
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'shrinkwrap.json',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  // Tests
  'test/',
  'tests/',
  '__tests__/',
  '__mocks__/',
  '*.test.*',
  '*.spec.*',
  // VCS internals
  '.git/',
];

export interface AtrsIgnore {
  /** True when the file's diff should be sent to the model. */
  accepts(repoRelativePath: string): boolean;
  /** Whether a `.atrsignore` was found in the repo root. */
  hasFile: boolean;
  /** Count of non-empty, non-comment lines read from `.atrsignore`. */
  filePatternCount: number;
}

/** Strips comments and blank lines the way git does, for reporting counts. */
function countPatterns(contents: string): number {
  return contents
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .length;
}

/**
 * Builds the ignore matcher for a working copy: the built-in defaults, then the
 * repo's own `.atrsignore` layered on top so it can extend *or* override them.
 *
 * A missing or unreadable `.atrsignore` is not an error — the defaults simply
 * stand on their own.
 */
export function loadAtrsIgnore(repoPath: string): AtrsIgnore {
  const matcher: Ignore = ignore().add([...DEFAULT_ATRSIGNORE_PATTERNS]);

  let hasFile = false;
  let filePatternCount = 0;
  try {
    const contents = fs.readFileSync(path.join(repoPath, ATRSIGNORE_FILE), 'utf8');
    hasFile = true;
    filePatternCount = countPatterns(contents);
    matcher.add(contents);
  } catch { /* no .atrsignore — defaults only */ }

  return {
    accepts(repoRelativePath: string): boolean {
      // git reports POSIX-style paths; normalise anyway so Windows-style input
      // from other callers matches the patterns too.
      const rel = repoRelativePath.replace(/\\/g, '/').replace(/^\.?\//, '');
      if (!rel) return false;
      return !matcher.ignores(rel);
    },
    hasFile,
    filePatternCount,
  };
}
