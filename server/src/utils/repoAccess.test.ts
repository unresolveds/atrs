import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getRepoRoot, isWithinRepoRoot, resolveWithinRepoRoot, assertRepoPathAllowed, assertIsGitRepo,
} from './repoAccess';

const isWin = process.platform === 'win32';

let base: string;
let root: string;
let inside: string;
let outside: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'atrs-repoaccess-'));
  root = path.join(base, 'repos');
  inside = path.join(root, 'my-plugin');
  outside = path.join(base, 'secrets');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});

afterAll(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
});

const original = process.env.REPO_BROWSE_ROOT;
beforeEach(() => { process.env.REPO_BROWSE_ROOT = root; });
afterEach(() => {
  if (original === undefined) delete process.env.REPO_BROWSE_ROOT;
  else process.env.REPO_BROWSE_ROOT = original;
});

describe('getRepoRoot', () => {
  it('honours REPO_BROWSE_ROOT, resolved', () => {
    expect(getRepoRoot()).toBe(path.resolve(root));
  });

  it('falls back to the home directory when unset or blank', () => {
    delete process.env.REPO_BROWSE_ROOT;
    expect(getRepoRoot()).toBe(path.resolve(os.homedir()));
    process.env.REPO_BROWSE_ROOT = '   ';
    expect(getRepoRoot()).toBe(path.resolve(os.homedir()));
  });
});

describe('isWithinRepoRoot', () => {
  it('accepts the root itself and paths beneath it', () => {
    expect(isWithinRepoRoot(root)).toBe(true);
    expect(isWithinRepoRoot(inside)).toBe(true);
    expect(isWithinRepoRoot(path.join(root, 'a', 'b', 'c'))).toBe(true);
  });

  it('rejects the parent and unrelated paths', () => {
    expect(isWithinRepoRoot(base)).toBe(false);
    expect(isWithinRepoRoot(outside)).toBe(false);
    expect(isWithinRepoRoot(isWin ? 'C:\\Windows\\System32' : '/etc')).toBe(false);
  });

  it('rejects traversal out of the root', () => {
    expect(isWithinRepoRoot(path.join(root, '..', 'secrets'))).toBe(false);
    expect(isWithinRepoRoot(path.join(root, 'a', '..', '..', 'secrets'))).toBe(false);
  });

  it('keeps traversal that stays inside the root', () => {
    expect(isWithinRepoRoot(path.join(root, 'a', '..', 'my-plugin'))).toBe(true);
  });

  it('rejects a sibling whose name merely starts with the root', () => {
    expect(isWithinRepoRoot(`${root}-evil`)).toBe(false);
    expect(isWithinRepoRoot(`${root}x`)).toBe(false);
  });

  // A lexical '..' prefix check would call this an escape; it is a real directory.
  it('accepts a real directory whose name begins with dots', () => {
    const dotted = path.join(root, '..config');
    fs.mkdirSync(dotted, { recursive: true });
    try {
      expect(isWithinRepoRoot(dotted)).toBe(true);
    } finally {
      fs.rmSync(dotted, { recursive: true, force: true });
    }
  });

  // path.resolve is lexical, so without realpath a link inside the root reaches out.
  it('rejects a symlink inside the root that points outside it', () => {
    const link = path.join(root, 'escape');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      return; // symlink creation needs privileges on some setups
    }
    try {
      expect(isWithinRepoRoot(link)).toBe(false);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it.runIf(isWin)('rejects a path on another drive', () => {
    expect(isWithinRepoRoot(path.join(`D:${path.sep}`, 'repos', 'thing'))).toBe(false);
  });
});

describe('resolveWithinRepoRoot', () => {
  it('resolves empty input to the root', () => {
    expect(resolveWithinRepoRoot('')).toBe(path.resolve(root));
  });

  it('returns a resolved path inside the root', () => {
    expect(resolveWithinRepoRoot(inside)).toBe(path.resolve(inside));
  });

  it('throws 403 for a path outside the root', () => {
    let thrown: any;
    try { resolveWithinRepoRoot(outside); } catch (e) { thrown = e; }
    expect(thrown?.statusCode).toBe(403);
  });
});

describe('assertRepoPathAllowed', () => {
  it('passes for a path inside the root', () => {
    expect(() => assertRepoPathAllowed(inside)).not.toThrow();
  });

  it('throws 403 for a path outside the root', () => {
    let thrown: any;
    try { assertRepoPathAllowed(outside); } catch (e) { thrown = e; }
    expect(thrown?.statusCode).toBe(403);
    expect(thrown.message).toMatch(/outside the allowed root/i);
  });
});

describe('assertIsGitRepo', () => {
  it('passes when a .git directory is present', () => {
    const repo = path.join(root, 'with-git');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    try {
      expect(() => assertIsGitRepo(repo)).not.toThrow();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('throws 400 naming the path when .git is missing', () => {
    let thrown: any;
    try { assertIsGitRepo(inside); } catch (e) { thrown = e; }
    expect(thrown?.statusCode).toBe(400);
    expect(thrown.message).toMatch(/not a Git repository/i);
    expect(thrown.message).toContain(inside);
  });

  it('throws for a path that does not exist', () => {
    expect(() => assertIsGitRepo(path.join(root, 'nope'))).toThrowError(/not a Git repository/i);
  });
});
