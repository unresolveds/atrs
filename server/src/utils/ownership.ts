import createHttpError from './httpError';
import type { AuthUser } from '../types/auth';
import { roleAtLeast, type StoreRole } from '../models/Store';

/**
 * Tenancy enforcement. Every read and write of store-scoped data goes through
 * one of these — nothing hand-rolls `{ storeId: ... }`.
 *
 * The rules, in one place so they can be argued with:
 *
 *  - A platform `admin` sees inside every store. That is an explicit product
 *    decision for support, not an accident of implementation.
 *  - Everyone else sees exactly one store, the one on their account.
 *  - A user with no store sees nothing at all. This matters: the old code keyed
 *    on `storeId`, so a missing value silently matched documents with no owner.
 *    Here it matches nothing, because "not in a store yet" must never mean
 *    "can read everything".
 *  - Missing documents and forbidden documents both answer 404, so ids cannot be
 *    probed for existence.
 */

/** Filter restricting a query to what `user` may read. */
export function storeFilter(user: AuthUser | undefined, base: Record<string, unknown> = {}): Record<string, unknown> {
  if (!user) return { ...base, storeId: null as never };
  if (user.role === 'admin') return { ...base };
  // An impossible id rather than an absent clause: an unscoped filter here would
  // return every store's rows.
  if (!user.storeId) return { ...base, storeId: '__no_store__' as never };
  return { ...base, storeId: user.storeId };
}

/** Throws 404 unless `doc` belongs to the user's store (admins always pass). */
export function assertStoreAccess(doc: { storeId?: unknown } | null, user: AuthUser | undefined): void {
  if (!doc) throw createHttpError(404, 'Not found');
  if (user && user.role === 'admin') return;
  if (!user || !user.storeId) throw createHttpError(404, 'Not found');
  const storeId = (doc.storeId as { toString?: () => string })?.toString?.() ?? String(doc.storeId);
  if (storeId !== user.storeId) throw createHttpError(404, 'Not found');
}

/**
 * Throws 403 unless the user holds at least `required` in their store.
 *
 * Deliberately 403 rather than 404: the caller can see the store, so hiding the
 * resource would only be confusing. What they lack is authority, and saying so
 * is the difference between a bug report and a support ticket.
 */
export function assertStoreRole(user: AuthUser | undefined, required: StoreRole): void {
  if (user && user.role === 'admin') return;
  if (!user?.storeId) throw createHttpError(403, 'You are not a member of a store.');
  if (!roleAtLeast(user.storeRole, required)) {
    throw createHttpError(403, `This action requires the ${required} role.`);
  }
}

/** The store a write should be attributed to, or a 403 explaining why there isn't one. */
export function requireStoreId(user: AuthUser | undefined): string {
  if (!user?.storeId) {
    throw createHttpError(403, 'Create or join a store before adding data.');
  }
  return user.storeId;
}

/**
 * Filter matching documents in the user's store that they either created or are
 * assigned to. Used where a store wants per-person work queues rather than a
 * shared pool; the store boundary still applies on top.
 */
export function assigneeFilter(
  user: AuthUser | undefined,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const scoped = storeFilter(user, base);
  if (!user || user.role === 'admin') return scoped;
  return { ...scoped, $or: [{ createdBy: user.id }, { assigneeIds: user.id }] };
}

/** Throws 404 unless the user may see the document, and it is theirs or assigned to them. */
export function assertAssignedOrStoreAccess(
  doc: { storeId?: unknown; createdBy?: unknown; assigneeIds?: unknown[] } | null,
  user: AuthUser | undefined,
): void {
  assertStoreAccess(doc, user);
  if (user && user.role === 'admin') return;
  // Inside a store, a member may act on their own work or work assigned to them.
  // Managers and owners are not restricted this way.
  if (roleAtLeast(user?.storeRole, 'manager')) return;
  const mine = String((doc as { createdBy?: unknown })?.createdBy ?? '') === user?.id;
  const assigned = ((doc?.assigneeIds ?? []) as unknown[]).some(
    (a) => ((a as { _id?: unknown })?._id ?? a)?.toString?.() === user?.id,
  );
  if (!mine && !assigned) throw createHttpError(404, 'Not found');
}
