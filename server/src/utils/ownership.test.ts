import { describe, it, expect } from 'vitest';
import {
  storeFilter, assertStoreAccess, assertStoreRole, requireStoreId, assigneeFilter,
} from './ownership';
import { roleAtLeast } from '../models/Store';
import type { AuthUser } from '../types/auth';

/**
 * The tenancy boundary. Every scoped read in the app trusts these four
 * functions, so the cases that matter are the ones where a mistake reads as
 * "works fine" — an absent store, an admin, a lower role.
 */

const ACME = '111111111111111111111111';
const GLOBEX = '222222222222222222222222';

const owner: AuthUser = { id: 'u1', role: 'user', isRoot: false, storeId: ACME, storeRole: 'owner' };
const manager: AuthUser = { id: 'u2', role: 'user', isRoot: false, storeId: ACME, storeRole: 'manager' };
const developer: AuthUser = { id: 'u3', role: 'user', isRoot: false, storeId: ACME, storeRole: 'developer' };
const outsider: AuthUser = { id: 'u4', role: 'user', isRoot: false, storeId: GLOBEX, storeRole: 'owner' };
const storeless: AuthUser = { id: 'u5', role: 'user', isRoot: false };
const admin: AuthUser = { id: 'u6', role: 'admin', isRoot: false };

const status = (fn: () => void) => {
  try { fn(); return 0; } catch (e) { return (e as { statusCode?: number }).statusCode ?? -1; }
};

describe('storeFilter', () => {
  it('scopes an ordinary member to their own store', () => {
    expect(storeFilter(developer)).toEqual({ storeId: ACME });
    expect(storeFilter(developer, { status: 'active' })).toEqual({ status: 'active', storeId: ACME });
  });

  it('leaves an admin unscoped, so support can see every store', () => {
    expect(storeFilter(admin)).toEqual({});
    expect(storeFilter(admin, { status: 'active' })).toEqual({ status: 'active' });
  });

  it('matches nothing for a user with no store', () => {
    // The failure that would matter: omitting the clause entirely would return
    // every store's rows to someone who belongs to none.
    const f = storeFilter(storeless) as Record<string, unknown>;
    expect('storeId' in f).toBe(true);
    expect(f.storeId).not.toBeUndefined();
    expect(f.storeId).not.toBe(null);
  });

  it('matches nothing when there is no user at all', () => {
    const f = storeFilter(undefined) as Record<string, unknown>;
    expect('storeId' in f).toBe(true);
  });

  it('never drops the caller-supplied base filter', () => {
    for (const u of [developer, admin, storeless, undefined]) {
      expect(storeFilter(u, { productId: 'p1' })).toMatchObject({ productId: 'p1' });
    }
  });
});

describe('assertStoreAccess', () => {
  const doc = { storeId: ACME };

  it('passes for a member of the same store, whatever their role', () => {
    for (const u of [owner, manager, developer]) {
      expect(() => assertStoreAccess(doc, u)).not.toThrow();
    }
  });

  it('passes for an admin', () => {
    expect(() => assertStoreAccess(doc, admin)).not.toThrow();
  });

  it('answers 404 — not 403 — for another store, so ids cannot be probed', () => {
    expect(status(() => assertStoreAccess(doc, outsider))).toBe(404);
  });

  it('answers 404 for a storeless user and for no user', () => {
    expect(status(() => assertStoreAccess(doc, storeless))).toBe(404);
    expect(status(() => assertStoreAccess(doc, undefined))).toBe(404);
  });

  it('answers 404 for a missing document', () => {
    expect(status(() => assertStoreAccess(null, owner))).toBe(404);
  });

  it('compares ObjectId-like values by string, not by identity', () => {
    const objectIdish = { storeId: { toString: () => ACME } };
    expect(() => assertStoreAccess(objectIdish, developer)).not.toThrow();
  });
});

describe('assertStoreRole', () => {
  it('lets each role do what its own level allows', () => {
    expect(() => assertStoreRole(developer, 'developer')).not.toThrow();
    expect(() => assertStoreRole(manager, 'manager')).not.toThrow();
    expect(() => assertStoreRole(owner, 'owner')).not.toThrow();
  });

  it('lets higher roles do lower-role work', () => {
    expect(() => assertStoreRole(owner, 'developer')).not.toThrow();
    expect(() => assertStoreRole(manager, 'developer')).not.toThrow();
  });

  it('stops a developer reaching settings, integrations and members', () => {
    // The product rule: developers get products/activities/issues, nothing else.
    expect(status(() => assertStoreRole(developer, 'manager'))).toBe(403);
    expect(status(() => assertStoreRole(developer, 'owner'))).toBe(403);
    expect(status(() => assertStoreRole(manager, 'owner'))).toBe(403);
  });

  it('answers 403 rather than 404, because the store is visible and only authority is missing', () => {
    expect(status(() => assertStoreRole(developer, 'owner'))).toBe(403);
  });

  it('lets an admin through any role gate', () => {
    expect(() => assertStoreRole(admin, 'owner')).not.toThrow();
  });

  it('refuses a user with no store', () => {
    expect(status(() => assertStoreRole(storeless, 'developer'))).toBe(403);
    expect(status(() => assertStoreRole(undefined, 'developer'))).toBe(403);
  });
});

describe('requireStoreId', () => {
  it('returns the store a write belongs to', () => {
    expect(requireStoreId(developer)).toBe(ACME);
  });

  it('refuses rather than writing an unscoped row', () => {
    // Silently creating a row with no storeId would make it invisible to
    // everyone and undeletable through the UI.
    expect(status(() => requireStoreId(storeless))).toBe(403);
    expect(status(() => requireStoreId(undefined))).toBe(403);
    expect(status(() => requireStoreId(admin))).toBe(403);
  });
});

describe('assigneeFilter', () => {
  it('narrows to own or assigned work inside the store', () => {
    const f = assigneeFilter(developer) as Record<string, unknown>;
    expect(f.storeId).toBe(ACME);
    expect(f.$or).toEqual([{ createdBy: 'u3' }, { assigneeIds: 'u3' }]);
  });

  it('leaves an admin unnarrowed', () => {
    expect(assigneeFilter(admin)).toEqual({});
  });

  it('keeps the store clause even while narrowing', () => {
    const f = assigneeFilter(developer, { status: 'open' }) as Record<string, unknown>;
    expect(f).toMatchObject({ status: 'open', storeId: ACME });
  });
});

describe('roleAtLeast', () => {
  it('orders developer < manager < owner', () => {
    expect(roleAtLeast('owner', 'manager')).toBe(true);
    expect(roleAtLeast('manager', 'developer')).toBe(true);
    expect(roleAtLeast('developer', 'manager')).toBe(false);
  });

  it('treats an absent role as no authority', () => {
    expect(roleAtLeast(undefined, 'developer')).toBe(false);
  });
});

describe('the no-store sentinel', () => {
  it('is a castable ObjectId, not a made-up string', () => {
    // A non-castable sentinel makes Mongoose throw a CastError, which the API
    // reports as a 500 — safe, but a fault rather than an empty list.
    const f = storeFilter(storeless) as Record<string, string>;
    expect(f.storeId).toMatch(/^[0-9a-f]{24}$/);
  });

  it('is not null, which would match documents that never had a store', () => {
    for (const u of [storeless, undefined]) {
      expect((storeFilter(u) as Record<string, unknown>).storeId).not.toBe(null);
    }
  });

  it('is the same for a storeless user and for no user at all', () => {
    expect(storeFilter(storeless)).toEqual(storeFilter(undefined));
  });
});
