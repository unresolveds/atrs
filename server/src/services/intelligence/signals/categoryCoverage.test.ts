/**
 * Guards against a signal category existing in the engine but being invisible
 * to users.
 *
 * `churn` was added to the vocabulary and to every `Record<SignalCategory, …>`
 * the compiler checks, but `CATEGORY_ORDER` in InsightEngine is a plain array —
 * a category missing from it is still detected and stored, and simply never
 * earns an insight card. Nothing failed; the signals just never reached anyone.
 * These assertions turn that silent gap into a failing test.
 */
import { describe, it, expect } from 'vitest';
import { SIGNAL_CATEGORIES, SIGNAL_CODES, type SignalCategory } from './types';
import { CATEGORY_ORDER, CATEGORY_LABEL, CATEGORY_TO_TYPE } from '../InsightEngine';
import { getSignalsSchema } from '../../../schemas/intelligence.schema';

describe('every category can reach a user', () => {
  it('appears in the insight feed order', () => {
    const missing = SIGNAL_CATEGORIES.filter((c) => !CATEGORY_ORDER.includes(c));
    expect(missing, `categories detected but never shown: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no stale entries in the feed order', () => {
    const stale = CATEGORY_ORDER.filter((c) => !SIGNAL_CATEGORIES.includes(c));
    expect(stale, `feed order lists unknown categories: ${stale.join(', ')}`).toEqual([]);
  });

  it('lists each category exactly once in the feed order', () => {
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
  });

  it('has a human label and lens', () => {
    for (const c of SIGNAL_CATEGORIES) {
      expect(CATEGORY_LABEL[c]?.title, `no title for "${c}"`).toBeTruthy();
      expect(CATEGORY_LABEL[c]?.lens, `no lens for "${c}"`).toBeTruthy();
    }
  });

  it('maps onto a persisted insight type', () => {
    for (const c of SIGNAL_CATEGORIES) {
      expect(CATEGORY_TO_TYPE[c], `no insight type for "${c}"`).toBeTruthy();
    }
  });

  it('is accepted by the signals API filter', () => {
    // The API enum used to be hand-copied; a category valid in the engine but
    // rejected here would 400 on a perfectly legitimate request.
    for (const c of SIGNAL_CATEGORIES) {
      const parsed = getSignalsSchema.safeParse({
        params: { productId: '507f1f77bcf86cd799439011' },
        query: { category: c },
      });
      expect(parsed.success, `API rejects category "${c}"`).toBe(true);
    }
  });

  it('rejects a category that is not in the vocabulary', () => {
    const parsed = getSignalsSchema.safeParse({
      params: { productId: '507f1f77bcf86cd799439011' },
      query: { category: 'not_a_category' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('signal codes', () => {
  it('are unique — a duplicate would silently merge two conditions', () => {
    expect(new Set(SIGNAL_CODES).size).toBe(SIGNAL_CODES.length);
  });

  it('are namespaced by a prefix, so the code reads as a category', () => {
    for (const code of SIGNAL_CODES) {
      expect(code, `"${code}" has no prefix`).toMatch(/^[a-z]+\./);
    }
  });

  it('includes the churn vocabulary', () => {
    const churn = SIGNAL_CODES.filter((c) => c.startsWith('churn.'));
    expect(churn.length).toBeGreaterThanOrEqual(6);
  });
});
