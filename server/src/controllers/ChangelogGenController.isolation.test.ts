/**
 * Per-user isolation for the Git Changelog Generator.
 *
 * The generator is meant to be independent per user: each user points a product
 * at a working copy on their own machine, and generating reads *that* repo —
 * never another user's. These tests build two real git repos owned by two
 * different users and assert the boundary from both directions.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The controller reaches Mongo through Product.findById(...).select(...).lean().
// Stub that chain so these tests exercise the authorization path, not the DB.
const findById = vi.fn();
vi.mock('../models/Product', () => ({
  Product: { findById: (...args: any[]) => findById(...args) },
}));

const { generate, getTags } = await import('./ChangelogGenController');

// Two stores, and a member of each. Isolation is per store now, not per user:
// a colleague of Alice's must see her products, a member of another store must not.
const ACME = '111111111111111111111111';
const GLOBEX = '222222222222222222222222';

const ALICE = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', role: 'user', storeId: ACME, storeRole: 'owner', name: 'Alice' };
/** Alice's colleague — same store, lower role. Must still reach the store's products. */
const DEV = { id: 'dddddddddddddddddddddddd', role: 'user', storeId: ACME, storeRole: 'developer', name: 'Dev' };
const BOB = { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', role: 'user', storeId: GLOBEX, storeRole: 'owner', name: 'Bob' };
const ADMIN = { id: 'cccccccccccccccccccccccc', role: 'admin', name: 'Root' };
/** Signed up, no store yet — must reach nothing at all. */
const STORELESS = { id: 'eeeeeeeeeeeeeeeeeeeeeeee', role: 'user', name: 'New' };

let root: string;
let aliceRepo: string;
let bobRepo: string;

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.test',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.test',
    },
  });
}

/** A working copy with one commit, one tag, and a distinctive source file. */
function makeRepo(dir: string, marker: string, tag: string, atrsignore?: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'core.autocrlf', 'false'); // keeps git's LF/CRLF warnings out of test output
  fs.writeFileSync(path.join(dir, 'source.js'), `// ${marker}\n`);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), `// generated for ${marker}\n`);
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes', 'todo.md'), `notes for ${marker}\n`);
  if (atrsignore !== undefined) fs.writeFileSync(path.join(dir, '.atrsignore'), atrsignore);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `init ${marker}`);
  git(dir, 'tag', tag);
}

/** Express double that records status + body, plus whatever reached next(). */
function fakeRes() {
  const cap: { status: number; body: any; nextErr: any } = { status: 200, body: undefined, nextErr: undefined };
  const res: any = {
    headersSent: false,
    status(code: number) { cap.status = code; return res; },
    json(body: any) { cap.body = body; return res; },
    setHeader() { return res; },
    write() { return true; },
    end() { return res; },
    flushHeaders() { /* SSE no-op */ },
  };
  return { res, cap };
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'atrs-iso-'));
  aliceRepo = path.join(root, 'alice-plugin');
  bobRepo = path.join(root, 'bob-plugin');
  // Alice keeps the defaults. Bob ignores notes/ and re-includes dist/.
  makeRepo(aliceRepo, 'ALICE_SECRET_SOURCE', 'v1.0.0');
  makeRepo(bobRepo, 'BOB_SECRET_SOURCE', 'v9.9.9', 'notes/\n!dist/\n');
});

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

const originalRoot = process.env.REPO_BROWSE_ROOT;
beforeEach(() => {
  process.env.REPO_BROWSE_ROOT = root;
  findById.mockReset();
});
afterEach(() => {
  if (originalRoot === undefined) delete process.env.REPO_BROWSE_ROOT;
  else process.env.REPO_BROWSE_ROOT = originalRoot;
});

/** Makes Product.findById resolve to one product doc, whoever asks. */
function productIs(doc: any) {
  findById.mockReturnValue({ select: () => ({ lean: async () => doc }) });
}

const aliceProduct = () => ({ _id: 'p-alice', name: 'Acme Plugin', repoPath: aliceRepo, storeId: ACME });
const bobProduct = () => ({ _id: 'p-bob', name: 'Globex Plugin', repoPath: bobRepo, storeId: GLOBEX });

describe('ownership boundary — getTags', () => {
  it("returns the owner's own tags", async () => {
    productIs(aliceProduct());
    const { res, cap } = fakeRes();
    await getTags({ params: { productId: 'p-alice' }, user: ALICE } as any, res, ((e: any) => { cap.nextErr = e; }) as any);
    expect(cap.nextErr).toBeUndefined();
    expect(cap.body).toEqual(['v1.0.0']);
  });

  it("refuses another user's product with a 404, leaking nothing", async () => {
    productIs(bobProduct()); // Bob's product, Alice asking
    const { res, cap } = fakeRes();
    await getTags({ params: { productId: 'p-bob' }, user: ALICE } as any, res, ((e: any) => { cap.nextErr = e; }) as any);
    expect(cap.nextErr).toBeDefined();
    expect(cap.nextErr.statusCode).toBe(404);
    // No tag list, and nothing that reveals Bob's repo or version.
    expect(cap.body).toBeUndefined();
    expect(JSON.stringify(cap.nextErr.message)).not.toContain('v9.9.9');
    expect(JSON.stringify(cap.nextErr.message)).not.toContain(bobRepo);
  });

  it('lets an admin through', async () => {
    productIs(bobProduct());
    const { res, cap } = fakeRes();
    await getTags({ params: { productId: 'p-bob' }, user: ADMIN } as any, res, ((e: any) => { cap.nextErr = e; }) as any);
    expect(cap.nextErr).toBeUndefined();
    expect(cap.body).toEqual(['v9.9.9']);
  });

  it('refuses an unauthenticated caller', async () => {
    productIs(aliceProduct());
    const { res, cap } = fakeRes();
    await getTags({ params: { productId: 'p-alice' }, user: undefined } as any, res, ((e: any) => { cap.nextErr = e; }) as any);
    expect(cap.nextErr?.statusCode).toBe(404);
  });
});

describe('ownership boundary — generate', () => {
  it("refuses to run the pipeline against another user's repo", async () => {
    productIs(bobProduct());
    const { res, cap } = fakeRes();
    await generate(
      { body: { productId: 'p-bob', rangeType: 'working' }, user: ALICE } as any,
      res,
      ((e: any) => { cap.nextErr = e; }) as any,
    );
    expect(cap.nextErr?.statusCode).toBe(404);
    // Rejected before any SSE stream opened, so no diff could have been emitted.
    expect(res.headersSent).toBe(false);
  });

  it('rejects a repo path outside the browse root even for its owner', async () => {
    const outside = path.join(os.tmpdir(), 'atrs-iso-outside');
    productIs({ ...aliceProduct(), repoPath: outside });
    const { res, cap } = fakeRes();
    await generate(
      { body: { productId: 'p-alice', rangeType: 'working' }, user: ALICE } as any,
      res,
      ((e: any) => { cap.nextErr = e; }) as any,
    );
    expect(cap.nextErr?.statusCode).toBe(403);
    expect(cap.nextErr.message).toMatch(/outside the allowed root/i);
  });

  it('rejects a path that is not a git working copy', async () => {
    const notARepo = path.join(root, 'not-a-repo');
    fs.mkdirSync(notARepo, { recursive: true });
    productIs({ ...aliceProduct(), repoPath: notARepo });
    const { res, cap } = fakeRes();
    await generate(
      { body: { productId: 'p-alice', rangeType: 'working' }, user: ALICE } as any,
      res,
      ((e: any) => { cap.nextErr = e; }) as any,
    );
    expect(cap.nextErr?.statusCode).toBe(400);
    expect(cap.nextErr.message).toMatch(/not a Git repository/i);
  });

  it('still requires a configured repo path', async () => {
    productIs({ ...aliceProduct(), repoPath: '' });
    const { res, cap } = fakeRes();
    await generate(
      { body: { productId: 'p-alice', rangeType: 'working' }, user: ALICE } as any,
      res,
      ((e: any) => { cap.nextErr = e; }) as any,
    );
    expect(cap.status).toBe(400);
    expect(cap.body.message).toMatch(/no repository path/i);
  });
});

describe('each user\'s data comes from their own working copy', () => {
  it('reads tags from the requesting owner\'s repo, not a shared one', async () => {
    productIs(aliceProduct());
    const a = fakeRes();
    await getTags({ params: { productId: 'p-alice' }, user: ALICE } as any, a.res, (() => {}) as any);

    productIs(bobProduct());
    const b = fakeRes();
    await getTags({ params: { productId: 'p-bob' }, user: BOB } as any, b.res, (() => {}) as any);

    expect(a.cap.body).toEqual(['v1.0.0']);
    expect(b.cap.body).toEqual(['v9.9.9']);
    expect(a.cap.body).not.toEqual(b.cap.body);
  });

  it('applies each repo\'s own .atrsignore independently', async () => {
    const { loadAtrsIgnore } = await import('../utils/atrsIgnore');
    const alice = loadAtrsIgnore(aliceRepo);
    const bob = loadAtrsIgnore(bobRepo);

    expect(alice.hasFile).toBe(false);
    expect(bob.hasFile).toBe(true);

    // Same relative path, opposite verdicts — driven purely by each repo's file.
    expect(alice.accepts('dist/bundle.js')).toBe(false); // default rule applies
    expect(bob.accepts('dist/bundle.js')).toBe(true);    // re-included via !dist/

    expect(alice.accepts('notes/todo.md')).toBe(true);   // nothing excludes it
    expect(bob.accepts('notes/todo.md')).toBe(false);    // excluded by notes/

    // Source is kept for both.
    expect(alice.accepts('source.js')).toBe(true);
    expect(bob.accepts('source.js')).toBe(true);
  });
});

describe('store membership, not personal ownership', () => {
  it("lets a colleague reach the store's product", async () => {
    // The whole point of the refactor: Alice's developer sees Acme's products
    // even though Alice created them.
    productIs(aliceProduct());
    const { res, cap } = fakeRes();
    await getTags({ params: { productId: 'p-alice' }, user: DEV } as any, res, ((e: any) => { cap.nextErr = e; }) as any);
    expect(cap.nextErr).toBeUndefined();
    expect(cap.body).toEqual(['v1.0.0']);
  });

  it('still refuses a member of a different store', async () => {
    productIs(aliceProduct());
    const { res, cap } = fakeRes();
    await getTags({ params: { productId: 'p-alice' }, user: BOB } as any, res, ((e: any) => { cap.nextErr = e; }) as any);
    expect(cap.nextErr?.statusCode).toBe(404);
    expect(cap.body).toBeUndefined();
  });

  it('gives a user with no store access to nothing', async () => {
    // The dangerous case: an absent storeId must match no documents rather than
    // behaving like an unscoped query.
    productIs(aliceProduct());
    const { res, cap } = fakeRes();
    await getTags({ params: { productId: 'p-alice' }, user: STORELESS } as any, res, ((e: any) => { cap.nextErr = e; }) as any);
    expect(cap.nextErr?.statusCode).toBe(404);
    expect(cap.body).toBeUndefined();
  });

  it('does not leak the other store\'s tags or path in the refusal', async () => {
    productIs(bobProduct());
    const { res, cap } = fakeRes();
    await getTags({ params: { productId: 'p-bob' }, user: ALICE } as any, res, ((e: any) => { cap.nextErr = e; }) as any);
    const message = String(cap.nextErr?.message ?? '');
    expect(message).not.toContain('v9.9.9');
    expect(message).not.toContain(bobRepo);
  });

  it('refuses to run the pipeline for a storeless user before any stream opens', async () => {
    productIs(aliceProduct());
    const { res, cap } = fakeRes();
    await generate(
      { body: { productId: 'p-alice', rangeType: 'working' }, user: STORELESS } as any,
      res,
      ((e: any) => { cap.nextErr = e; }) as any,
    );
    expect(cap.nextErr?.statusCode).toBe(404);
    expect(res.headersSent).toBe(false);
  });
});
