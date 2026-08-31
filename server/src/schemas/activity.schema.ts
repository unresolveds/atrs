import { z } from 'zod';
import { objectId } from './common.schema';
import { ACTIVITY_TYPES } from '../constants/activityTypes';

export const createActivitySchema = z.object({
  body: z.object({
    productId: objectId,
    type: z.enum(ACTIVITY_TYPES),
    title: z.string(),
    shortDescription: z.string(),
    tier: z.enum(['free', 'pro']).optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    referenceUrl: z.string().nullable().optional().transform(val => val === '' ? null : val),
    versionId: z.preprocess(val => (val === '' ? null : val), objectId.nullish()),
    relatedIssueIds: z.array(objectId).optional(),
    displayOrder: z.number().optional(),
    tags: z.array(z.string()).optional(),
    mediaType: z.preprocess(val => val === '' ? null : val, z.enum(['image', 'gif', 'video']).nullable().optional()),
    mediaUrl: z.string().nullable().optional().transform(val => val === '' ? null : val),
    mediaUrls: z.array(z.string()).optional(),
    items: z
      .array(
        z.object({
          title: z.string(),
          description: z.string().nullable().optional(),
          mediaType: z.preprocess(val => val === '' ? null : val, z.enum(['image', 'gif', 'video']).nullable().optional()),
          mediaUrl: z.string().nullable().optional().transform(val => val === '' ? null : val),
          mediaUrls: z.array(z.string()).optional(),
        })
      )
      .default([]),
    activityDate: z.string(),
    assigneeIds: z.array(objectId).optional(),
    estimatedHours: z.number().optional(),
    actualHours: z.number().optional(),
  }),
});

export const updateActivitySchema = z.object({
  body: z.object({
    productId: objectId.optional(),
    type: z.enum(ACTIVITY_TYPES).optional(),
    title: z.string().optional(),
    shortDescription: z.string().optional(),
    tier: z.enum(['free', 'pro']).optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    referenceUrl: z.string().nullable().optional().transform(val => val === '' ? null : val),
    versionId: z.preprocess(val => (val === '' ? null : val), objectId.nullish()),
    relatedIssueIds: z.array(objectId).optional(),
    displayOrder: z.number().optional(),
    tags: z.array(z.string()).optional(),
    mediaType: z.preprocess(val => val === '' ? null : val, z.enum(['image', 'gif', 'video']).nullable().optional()),
    mediaUrl: z.string().nullable().optional().transform(val => val === '' ? null : val),
    mediaUrls: z.array(z.string()).optional(),
    items: z
      .array(
        z.object({
          title: z.string(),
          description: z.string().nullable().optional(),
          mediaType: z.preprocess(val => val === '' ? null : val, z.enum(['image', 'gif', 'video']).nullable().optional()),
          mediaUrl: z.string().nullable().optional().transform(val => val === '' ? null : val),
          mediaUrls: z.array(z.string()).optional(),
        })
      )
      .optional(),
    activityDate: z.string().optional(),
    assigneeIds: z.array(objectId).optional(),
    estimatedHours: z.number().optional(),
    actualHours: z.number().optional(),
    needsReview: z.boolean().optional(),
  }),
  params: z.object({
    id: objectId,
  }),
});
