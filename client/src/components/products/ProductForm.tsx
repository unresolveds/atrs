import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { FolderSearch } from 'lucide-react';
import { RepoPathBrowser } from './RepoPathBrowser';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import { MediaUploader } from '@/components/ui/MediaUploader';
import { useFormDraft } from '@/hooks/useFormDraft';
import { SuggestTitleButton, GenerateDescriptionButton } from '../ai/AiAssist';
import { htmlToPlainText } from '@/lib/richText';

/**
 * - `wp`: manual WordPress/CMS product — Plugin/Block/Theme category, WP.org
 *   slug shown, repo URL required.
 * - `standalone`: non-WP app — category fixed to "standalone", no WP.org slug,
 *   repo/website URL optional.
 * - `full`: everything (used when editing an existing product of any kind).
 */
export type ProductFormVariant = 'wp' | 'standalone' | 'full';

const buildSchema = (variant: ProductFormVariant) =>
  z.object({
    name: z.string().min(1, 'Name is required'),
    githubUrl:
      variant === 'standalone'
        ? z.string().url('Must be a valid URL').optional().or(z.literal(''))
        : z.string().url('Must be a valid URL'),
    description: z.string().optional(),
    category: z.enum(['plugin', 'block', 'theme', 'standalone']),
    status: z.enum(['active', 'inactive']),
    icon: z.string().optional(),
    banner: z.string().optional(),
    wpOrgSlug: z.string().optional(),
    repoPath: z.string().optional(),
  });

type FormValues = z.infer<ReturnType<typeof buildSchema>>;

const CATEGORY_OPTIONS: Record<ProductFormVariant, { value: FormValues['category']; label: string }[]> = {
  wp: [
    { value: 'plugin', label: 'Plugin' },
    { value: 'block', label: 'Block' },
    { value: 'theme', label: 'Theme' },
  ],
  standalone: [{ value: 'standalone', label: 'Standalone App' }],
  full: [
    { value: 'plugin', label: 'Plugin' },
    { value: 'block', label: 'Block' },
    { value: 'theme', label: 'Theme' },
    { value: 'standalone', label: 'Standalone App' },
  ],
};

export function ProductForm({
  initialData,
  onSubmit,
  variant = 'full',
}: {
  initialData?: any;
  onSubmit: (data: FormValues) => void;
  variant?: ProductFormVariant;
}) {
  const isStandalone = variant === 'standalone';
  const schema = useMemo(() => buildSchema(variant), [variant]);
  const [repoBrowserOpen, setRepoBrowserOpen] = useState(false);

  const defaultCategory: FormValues['category'] =
    variant === 'standalone' ? 'standalone' : variant === 'wp' ? 'plugin' : 'plugin';

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: initialData || {
      name: '',
      githubUrl: '',
      description: '',
      category: defaultCategory,
      status: 'active',
      icon: '',
      banner: '',
      wpOrgSlug: '',
      repoPath: '',
    },
  });

  // Browser-style draft: autosave inputs and silently restore them on return.
  // Keyed per entity (or "new" for the create flow); media fields are excluded.
  const draftKey = `draft:product:${initialData?._id ?? 'new'}`;
  const { clearDraft } = useFormDraft(form, { key: draftKey, exclude: ['icon', 'banner'] });
  const handleSubmit = (data: FormValues) => {
    clearDraft();
    onSubmit(data);
  };

  return (
    <Form {...(form as any)}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <FormField
          control={form.control as any}
          name="name"
          render={({ field }: any) => (
            <FormItem>
              <div className="flex items-center justify-between gap-2">
                <FormLabel>Name</FormLabel>
                <SuggestTitleButton
                  entity="product"
                  getContext={() => ({
                    category: form.getValues('category'),
                    description: htmlToPlainText(form.getValues('description') || ''),
                    wpOrgSlug: form.getValues('wpOrgSlug'),
                  })}
                  onPick={(t) => field.onChange(t)}
                />
              </div>
              <FormControl>
                <Input placeholder={isStandalone ? 'e.g. My Desktop App' : 'e.g. Test Plugin'} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control as any}
          name="description"
          render={({ field }: any) => (
            <FormItem>
              <div className="flex items-center justify-between gap-2">
                <FormLabel>Description</FormLabel>
                <GenerateDescriptionButton
                  entity="product"
                  getContext={() => ({
                    name: form.getValues('name'),
                    category: form.getValues('category'),
                    wpOrgSlug: form.getValues('wpOrgSlug'),
                  })}
                  getTitle={() => form.getValues('name')}
                  onResult={(t) => field.onChange(t)}
                />
              </div>
              <FormControl>
                <RichTextEditor
                  ariaLabel="Product description"
                  placeholder="Brief description of the product..."
                  value={field.value || ''}
                  onChange={field.onChange}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control as any}
          name="githubUrl"
          render={({ field }: any) => (
            <FormItem>
              <FormLabel>{isStandalone ? 'GitHub / Website URL (optional)' : 'GitHub URL'}</FormLabel>
              <FormControl>
                <Input placeholder="https://github.com/..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* WP.org slug is meaningless for standalone apps. */}
        {!isStandalone && (
          <FormField
            control={form.control as any}
            name="wpOrgSlug"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>WP.org Slug (optional)</FormLabel>
                <FormControl>
                  <Input placeholder="e.g. test-plugin" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control as any}
          name="repoPath"
          render={({ field }: any) => (
            <FormItem>
              <FormLabel>Local repo path (optional)</FormLabel>
              <div className="flex items-center gap-2">
                <FormControl>
                  <Input placeholder="e.g. C:\\Users\\you\\projects\\my-plugin" {...field} />
                </FormControl>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRepoBrowserOpen(true)}
                  className="shrink-0 gap-1.5"
                >
                  <FolderSearch className="w-4 h-4" /> Browse
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Absolute path to this product's Git working copy on{' '}
                <span className="font-medium">your machine</span> (where ATRS runs). The Git Changelog
                Generator runs <span className="font-mono">git</span> there to read commits and
                uncommitted changes. Add a <span className="font-mono">.atrsignore</span> in the repo
                root to keep build output and vendored code out of the AI's context.
                Click <span className="font-medium">Browse</span> to pick a folder.
              </p>
              <FormMessage />
              <RepoPathBrowser
                open={repoBrowserOpen}
                onOpenChange={setRepoBrowserOpen}
                initialPath={field.value || ''}
                onSelect={(p) => field.onChange(p)}
              />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Standalone has a fixed category, so the select is hidden. */}
          {!isStandalone && (
            <FormField
              control={form.control as any}
              name="category"
              render={({ field }: any) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CATEGORY_OPTIONS[variant].map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          <FormField
            control={form.control as any}
            name="status"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control as any}
            name="icon"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Icon Upload (optional)</FormLabel>
                <FormControl>
                  <MediaUploader
                    value={field.value}
                    onChange={field.onChange}
                    accept="image/*"
                    label="Upload product icon"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control as any}
            name="banner"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Banner Upload (optional)</FormLabel>
                <FormControl>
                  <MediaUploader
                    value={field.value}
                    onChange={field.onChange}
                    accept="image/*"
                    label="Upload product banner"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <Button type="submit" className="w-full">
          {initialData ? 'Update Product' : 'Create Product'}
        </Button>
      </form>
    </Form>
  );
}
