import { describe, it, expect } from 'vitest';
import { buildActivityBulkUpdate } from './activityBulkUpdate';
import { bulkUpdateActivitiesSchema } from '../schemas/activityBulk.schema';

const validId = 'a'.repeat(24);

describe('buildActivityBulkUpdate', () => {
  it('builds $set for scalar fields', () => {
    const doc = buildActivityBulkUpdate({ type: 'feature', tier: 'pro' });
    expect(doc).toEqual({ $set: { type: 'feature', tier: 'pro' } });
  });

  it('builds $addToSet / $pull for tag operations', () => {
    const doc = buildActivityBulkUpdate({ addTags: ['released'], removeTags: ['unreleased'] });
    expect(doc.$addToSet).toEqual({ tags: { $each: ['released'] } });
    expect(doc.$pull).toEqual({ tags: { $in: ['unreleased'] } });
    expect(doc.$set).toBeUndefined();
  });

  it('parses activityDate into a Date', () => {
    const doc = buildActivityBulkUpdate({ activityDate: '2026-01-15' });
    expect(doc.$set?.activityDate).toBeInstanceOf(Date);
  });

  it('rejects an invalid activityDate', () => {
    expect(() => buildActivityBulkUpdate({ activityDate: 'not-a-date' })).toThrowError(/valid date/);
  });

  it('rejects combining tags replace with addTags/removeTags', () => {
    expect(() => buildActivityBulkUpdate({ tags: ['a'], addTags: ['b'] })).toThrowError(/Cannot combine/);
  });

  it('rejects an empty payload', () => {
    expect(() => buildActivityBulkUpdate({})).toThrowError(/No valid fields/);
  });

  it('ignores rogue operator keys and never emits them', () => {
    // A rogue operator key is simply not a recognized field, so it contributes
    // nothing — the builder throws "no valid fields" rather than forwarding it.
    expect(() => buildActivityBulkUpdate({ $set: { storeId: 'evil' } } as any)).toThrowError(/No valid fields/);
    // And when mixed with a real field, only the real field is emitted.
    const doc = buildActivityBulkUpdate({ type: 'feature', $set: { storeId: 'evil' } } as any);
    expect(JSON.stringify(doc)).not.toContain('storeId');
    expect(doc).toEqual({ $set: { type: 'feature' } });
  });
});

describe('bulkUpdateActivitiesSchema (operator-injection guard)', () => {
  it('accepts a clean named-field payload', () => {
    const result = bulkUpdateActivitiesSchema.safeParse({
      body: { ids: [validId], update: { addTags: ['released'] } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a raw $addToSet operator in update', () => {
    const result = bulkUpdateActivitiesSchema.safeParse({
      body: { ids: [validId], update: { $addToSet: { tags: 'released' } } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a $set storeId reassignment attempt', () => {
    const result = bulkUpdateActivitiesSchema.safeParse({
      body: { ids: [validId], update: { $set: { storeId: validId } } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects $unset / $rename operators', () => {
    expect(
      bulkUpdateActivitiesSchema.safeParse({
        body: { ids: [validId], update: { $unset: { shortDescription: '' } } },
      }).success
    ).toBe(false);
    expect(
      bulkUpdateActivitiesSchema.safeParse({
        body: { ids: [validId], update: { $rename: { title: 'x' } } },
      }).success
    ).toBe(false);
  });
});
