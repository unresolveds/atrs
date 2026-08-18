import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadAtrsIgnore, ATRSIGNORE_FILE, DEFAULT_ATRSIGNORE_PATTERNS } from './atrsIgnore';

let base: string;
/** Repo with no .atrsignore — exercises the built-in defaults alone. */
let bare: string;
/** Repo whose .atrsignore extends and overrides the defaults. */
let custom: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'atrs-ignore-'));
  bare = path.join(base, 'bare');
  custom = path.join(base, 'custom');
  fs.mkdirSync(bare, { recursive: true });
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(
    path.join(custom, ATRSIGNORE_FILE),
    [
      '# extend the defaults',
      'docs/',
      '*.snap',
      '',
      '# ...and put tests back in',
      '!test/',
      '!*.test.*',
    ].join('\n'),
    'utf8',
  );
});

afterAll(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('default ignore rules', () => {
  it('keeps ordinary source files', () => {
    const ig = loadAtrsIgnore(bare);
    for (const p of [
      'src/index.ts',
      'server/src/controllers/ProductController.ts',
      'client/src/pages/Dashboard.tsx',
      'includes/class-plugin.php',
      'readme.txt',
      'src/styles/app.scss',
    ]) {
      expect(ig.accepts(p), p).toBe(true);
    }
  });

  it('drops dependencies, build output and bundles', () => {
    const ig = loadAtrsIgnore(bare);
    for (const p of [
      'node_modules/react/index.js',
      'vendor/autoload.php',
      'dist/app.js',
      'build/main.css',
      'out/index.html',
      'coverage/lcov.info',
      'assets/app.min.js',
      'assets/app.min.css',
      'assets/vendor.bundle.js',
      'dist/app.js.map',
    ]) {
      expect(ig.accepts(p), p).toBe(false);
    }
  });

  it('drops lockfiles', () => {
    const ig = loadAtrsIgnore(bare);
    for (const p of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock']) {
      expect(ig.accepts(p), p).toBe(false);
    }
  });

  it('drops tests by default', () => {
    const ig = loadAtrsIgnore(bare);
    for (const p of [
      'test/helper.js',
      'tests/unit/foo.php',
      'src/__tests__/Button.tsx',
      'src/utils/slug.test.ts',
      'src/utils/slug.spec.ts',
    ]) {
      expect(ig.accepts(p), p).toBe(false);
    }
  });

  it('matches nested build directories, not just top-level', () => {
    const ig = loadAtrsIgnore(bare);
    expect(ig.accepts('packages/ui/dist/index.js')).toBe(false);
    expect(ig.accepts('plugins/foo/node_modules/bar/index.js')).toBe(false);
  });

  it('reports that no .atrsignore was present', () => {
    const ig = loadAtrsIgnore(bare);
    expect(ig.hasFile).toBe(false);
    expect(ig.filePatternCount).toBe(0);
  });

  it('treats a non-existent repo path as having no ignore file', () => {
    const ig = loadAtrsIgnore(path.join(base, 'does-not-exist'));
    expect(ig.hasFile).toBe(false);
    expect(ig.accepts('src/index.ts')).toBe(true);
    expect(ig.accepts('node_modules/x/y.js')).toBe(false);
  });
});

describe('.atrsignore in the repo root', () => {
  it('is detected and its rule count reported (comments and blanks excluded)', () => {
    const ig = loadAtrsIgnore(custom);
    expect(ig.hasFile).toBe(true);
    expect(ig.filePatternCount).toBe(4); // docs/, *.snap, !test/, !*.test.*
  });

  it('extends the defaults with repo-specific rules', () => {
    const ig = loadAtrsIgnore(custom);
    expect(ig.accepts('docs/guide.md')).toBe(false);
    expect(ig.accepts('src/__snapshots__/a.snap')).toBe(false);
    // defaults still apply alongside the custom rules
    expect(ig.accepts('dist/app.js')).toBe(false);
    expect(ig.accepts('src/index.ts')).toBe(true);
  });

  it('can re-include something the defaults dropped, via negation', () => {
    const ig = loadAtrsIgnore(custom);
    expect(ig.accepts('test/helper.js')).toBe(true);
    expect(ig.accepts('src/utils/slug.test.ts')).toBe(true);
    // a default not negated stays dropped
    expect(ig.accepts('src/utils/slug.spec.ts')).toBe(false);
  });
});

describe('path normalisation', () => {
  it('accepts Windows-style separators', () => {
    const ig = loadAtrsIgnore(bare);
    expect(ig.accepts('src\\index.ts')).toBe(true);
    expect(ig.accepts('node_modules\\react\\index.js')).toBe(false);
    expect(ig.accepts('packages\\ui\\dist\\index.js')).toBe(false);
  });

  it('tolerates a leading ./', () => {
    const ig = loadAtrsIgnore(bare);
    expect(ig.accepts('./src/index.ts')).toBe(true);
    expect(ig.accepts('./dist/app.js')).toBe(false);
  });

  it('rejects an empty path rather than throwing', () => {
    const ig = loadAtrsIgnore(bare);
    expect(ig.accepts('')).toBe(false);
    expect(ig.accepts('/')).toBe(false);
  });
});

describe('DEFAULT_ATRSIGNORE_PATTERNS', () => {
  it('covers every category the generator is meant to exclude', () => {
    const joined = DEFAULT_ATRSIGNORE_PATTERNS.join('\n');
    for (const needle of ['node_modules/', 'dist/', 'build/', '*.min.js', 'package-lock.json', 'test/']) {
      expect(joined).toContain(needle);
    }
  });
});
