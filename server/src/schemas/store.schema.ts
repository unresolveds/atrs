import { z } from 'zod';

/** Roles a member can be given. `owner` is excluded: it moves by transfer only. */
const assignableRole = z.enum(['manager', 'developer']);

export const createStoreSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1, 'A store name is required').max(120),
    description: z.string().trim().max(500).optional(),
  }),
});

export const updateStoreSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    logoUrl: z.string().trim().max(500).optional(),
    branding: z
      .object({
        companyName: z.string().trim().max(80).optional(),
        logoUrl: z.string().trim().max(500).optional(),
        accentColor: z.string().trim().max(7).optional(),
        accentDynamic: z.boolean().optional(),
        thankYouEnabled: z.boolean().optional(),
        thankYouTitle: z.string().trim().max(80).optional(),
        thankYouMessage: z.string().trim().max(300).optional(),
      })
      .optional(),
    intelligence: z
      .object({
        model: z.string().trim().max(120).optional(),
        ollamaMode: z.enum(['local', 'cloud']).optional(),
        ollamaCloudUrl: z.string().trim().max(500).optional(),
        // Write-only. Omitted or empty keeps the stored key; 'null' clears it.
        ollamaCloudKey: z.string().max(500).optional(),
        staleAlertDays: z.number().int().min(1).max(365).optional(),
      })
      .optional(),
  }),
});

export const addMemberSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().email('A valid email is required'),
    role: assignableRole,
  }),
});

export const setMemberRoleSchema = z.object({
  params: z.object({ memberId: z.string().min(1) }),
  body: z.object({ role: assignableRole }),
});

export const memberParamsSchema = z.object({
  params: z.object({ memberId: z.string().min(1) }),
});

export const transferOwnershipSchema = z.object({
  body: z.object({ toUserId: z.string().min(1) }),
});

export const moveProductSchema = z.object({
  body: z.object({
    productId: z.string().min(1),
    toStoreId: z.string().min(1),
  }),
});
