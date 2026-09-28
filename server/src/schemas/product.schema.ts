import { z } from 'zod';

export const createProductSchema = z.object({
  body: z.object({
    name: z.string(),
    // Optional: standalone products may omit a repo URL. Allow empty string too.
    githubUrl: z.string().url('Invalid URL format').optional().or(z.literal('')),
    description: z.string().optional(),
    category: z.enum(['plugin', 'block', 'theme', 'standalone']),
    status: z.enum(['active', 'inactive']).optional(),
    icon: z.string().optional(),
    banner: z.string().optional(),
    wpOrgSlug: z.string().optional(),
    wpReadme: z.string().optional(),
    repoPath: z.string().optional(),
    // Links the product to its Freemius account so uninstall feedback can be
    // pulled. The API keys are deliberately NOT settable here — they are
    // write-only credentials and belong on a dedicated connect route.
    freemiusProductId: z.string().trim().regex(/^[0-9]*$/, 'Freemius product id must be numeric').optional(),
  }),
});

export const updateProductSchema = z.object({
  body: z.object({
    name: z.string().optional(),
    githubUrl: z.string().url('Invalid URL format').optional(),
    description: z.string().optional(),
    category: z.enum(['plugin', 'block', 'theme', 'standalone']).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    icon: z.string().optional(),
    banner: z.string().optional(),
    wpOrgSlug: z.string().optional(),
    wpReadme: z.string().optional(),
    repoPath: z.string().optional(),
    // Links the product to its Freemius account so uninstall feedback can be
    // pulled. The API keys are deliberately NOT settable here — they are
    // write-only credentials and belong on a dedicated connect route.
    freemiusProductId: z.string().trim().regex(/^[0-9]*$/, 'Freemius product id must be numeric').optional(),
    publicChangelogEnabled: z.boolean().optional(),
    publicIssuesEnabled: z.boolean().optional(),
    listedInDirectory: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string(),
  }),
});
