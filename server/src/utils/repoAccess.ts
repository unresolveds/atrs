import fs from 'fs';
import path from 'path';
import os from 'os';
import createHttpError from './httpError';

/**
 * Root directory that the server-side folder picker and the changelog
 * generator are allowed to touch. Defaults to the OS home directory (where dev
 * repos normally live) and is widened/narrowed with the REPO_BROWSE_ROOT env
 * var. This is the jail that prevents an authenticated user from walking the
 * whole host filesystem (e.g. /etc, C:\Windows, another user's home) via the
 * folder picker or a hand-set product `repoPath`.
 */
export function getRepoRoot(): string {
  const configured = (process.env.REPO_BROWSE_ROOT || '').trim();
  return path.resolve(configured || os.homedir());
}

/**
 * Resolves symlinks when the path exists, so a link (or NTFS junction) planted
 * inside the root cannot be used to reach a target outside it — `path.resolve`
 * alone is purely lexical and would let that through. A path that doesn't exist
 * falls back to its lexical form: this is a containment check, not an existence
 * check.
 */
function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/** True when `target` is the root itself or lives somewhere beneath it. */
export function isWithinRepoRoot(target: string): boolean {
  const root = realpathOrSelf(getRepoRoot());
  const resolved = realpathOrSelf(path.resolve(target));
  if (resolved === root) return true;
  const rel = path.relative(root, resolved);
  // Outside the root iff the relative path climbs out ('..') or is absolute
  // (different drive on Windows). Compare the '..' segment exactly, so a real
  // directory named e.g. '..config' isn't mistaken for an escape.
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * Resolves `raw` and confirms it stays inside {@link getRepoRoot}. Throws a 403
 * otherwise. Empty input resolves to the root itself.
 */
export function resolveWithinRepoRoot(raw: string): string {
  const root = getRepoRoot();
  const resolved = raw ? path.resolve(raw) : root;
  if (!isWithinRepoRoot(resolved)) {
    throw createHttpError(403, 'Path is outside the allowed repository root.');
  }
  return resolved;
}

/** Guard for a stored product repoPath before running git against it. */
export function assertRepoPathAllowed(repoPath: string): void {
  if (!isWithinRepoRoot(repoPath)) {
    throw createHttpError(
      403,
      'This product’s repository path is outside the allowed root. Ask an admin to set REPO_BROWSE_ROOT or choose a folder within it.'
    );
  }
}

/**
 * Throws a 400 unless `repoPath` is a Git working copy. Without this the first
 * failure a user sees is a raw "Git diff failed: …" from deep inside the
 * pipeline, which doesn't say what is actually wrong.
 */
export function assertIsGitRepo(repoPath: string): void {
  try {
    if (fs.existsSync(path.join(repoPath, '.git'))) return;
  } catch { /* fall through to the error below */ }
  throw createHttpError(
    400,
    `${repoPath} is not a Git repository — no .git directory found. Point this product at a Git working copy.`,
  );
}
