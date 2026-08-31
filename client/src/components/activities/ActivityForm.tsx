import { useEffect } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import { SuggestTitleButton, GenerateDescriptionButton } from '../ai/AiAssist';
import { htmlToPlainText } from '@/lib/richText';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getProducts } from '../../services/products';
import { useProductVersions } from '../../hooks/useVersions';
import { VersionBadge } from '../versions/VersionBadge';
import { getIssues, type Issue } from '../../services/issues';
import { MediaUploader } from '@/components/ui/MediaUploader';
import { DatePicker } from '@/components/ui/DatePicker';
import { format } from 'date-fns';
// Extension is explicit on purpose: building the server emits a CommonJS
// consts/index.js beside the shared source, and Vite resolves .js before .ts.
// Without the extension that artifact wins, ACTIVITY_TYPES arrives undefined,
// and the z.enum() below throws while this module is still loading.
import { ACTIVITY_TYPES } from '../../../../consts/index.ts';
const formSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  type: z.enum(ACTIVITY_TYPES),
  title: z.string().min(1, 'Title is required'),
  shortDescription: z.string().min(1, 'Short description is required'),
  tier: z.enum(['free', 'pro']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  referenceUrl: z.string().nullable().optional(),
  versionId: z.string().nullable().optional(),
  relatedIssueIds: z.array(z.string()).optional(),
  mediaType: z.enum(['image', 'gif', 'video']).nullable().optional().or(z.literal('')),
  mediaUrl: z.string().nullable().optional(),
  mediaUrls: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  activityDate: z.string().min(1, 'Date is required'),
  items: z.array(z.object({
    title: z.string().min(1, 'Title is required'),
    description: z.string().nullable().optional(),
    mediaType: z.enum(['image', 'gif', 'video']).nullable().optional().or(z.literal('')),
    mediaUrl: z.string().nullable().optional(),
    mediaUrls: z.array(z.string()).optional()
  }))
});

type FormValues = z.infer<typeof formSchema>;

export function ActivityForm({
  initialData,
  onSubmit,
}: {
  initialData?: any;
  onSubmit: (data: FormValues) => void;
}) {
  const { data: productsData } = useQuery({ queryKey: ['products'], queryFn: () => getProducts() });
  const products = productsData?.data || [];

  const processedInitialData = initialData ? {
    ...initialData,
    versionId: typeof initialData.versionId === 'object' ? initialData.versionId?._id : (initialData.versionId || ''),
    relatedIssueIds: (initialData.relatedIssueIds || []).map((i: any) => (typeof i === 'object' ? i?._id : i)).filter(Boolean),
    mediaUrls: initialData.mediaUrls && initialData.mediaUrls.length > 0 ? initialData.mediaUrls : (initialData.mediaUrl ? [initialData.mediaUrl] : []),
    items: (initialData.items || []).map((item: any) => ({
      ...item,
      mediaUrls: item.mediaUrls && item.mediaUrls.length > 0 ? item.mediaUrls : (item.mediaUrl ? [item.mediaUrl] : [])
    }))
  } : undefined;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: processedInitialData || {
      productId: '',
      type: 'feature',
      title: '',
      shortDescription: '',
      tier: 'free',
      priority: 'medium',
      referenceUrl: '',
      versionId: '',
      relatedIssueIds: [],
      mediaType: '',
      mediaUrls: [],
      tags: [],
      activityDate: format(new Date(), 'yyyy-MM-dd'),
      items: [],
    },
  });

  // Reset form whenever initialData changes (e.g. opening edit dialog for a different activity)
  useEffect(() => {
    if (initialData) {
      form.reset(processedInitialData);
    }
  }, [initialData?._id]);

  const selectedProductId = form.watch('productId');
  const { versions } = useProductVersions(selectedProductId);

  const { data: issuesData } = useQuery({
    queryKey: ['issues', selectedProductId],
    queryFn: () => getIssues(selectedProductId),
    enabled: !!selectedProductId,
  });
  const issues: Issue[] = issuesData || [];

  const { fields, append, remove } = useFieldArray({
    name: "items",
    control: form.control,
  });

  return (
    <Form {...(form as any)}>
      <form onSubmit={form.handleSubmit((data) => {
        data.mediaUrl = ''; // Clear legacy field
        data.items = data.items.map(item => ({ ...item, mediaUrl: '' })); // Clear legacy field
        if (data.type !== 'bug-fix') data.relatedIssueIds = []; // Issue links only apply to bug fixes
        onSubmit(data);
      })} className="space-y-4 px-1">
        <FormField
          control={form.control as any}
          name="productId"
          render={({ field }: any) => (
            <FormItem>
              <FormLabel>Product</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a product" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {products?.map((p: any) => (
                    <SelectItem key={p._id} value={p._id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control as any}
            name="type"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Type</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {/* <SelectItem value="feature">Feature</SelectItem>
                    <SelectItem value="improvement">Improvement</SelectItem>
                    <SelectItem value="bug-fix">Bug Fix</SelectItem> */}
                    {ACTIVITY_TYPES.map((type: string) => (
                      <SelectItem key={type} value={type}>{type}</SelectItem>
                    ))}

                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control as any}
            name="priority"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Priority</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value || 'medium'}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select priority" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control as any}
            name="activityDate"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Date</FormLabel>
                <FormControl>
                  <DatePicker
                    value={field.value || ''}
                    onChange={field.onChange}
                    placeholder="Pick changelog date"
                    clearable={false}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {form.watch('type') === 'feature' && (
            <FormField
              control={form.control as any}
              name="tier"
              render={({ field }: any) => (
                <FormItem>
                  <FormLabel>Tier</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value || 'free'}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select tier" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="free">Free</SelectItem>
                      <SelectItem value="pro">Pro</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>

        <FormField
          control={form.control as any}
          name="title"
          render={({ field }: any) => (
            <FormItem>
              <div className="flex items-center justify-between gap-2">
                <FormLabel>Title</FormLabel>
                <SuggestTitleButton
                  entity="changelog entry"
                  getContext={() => ({
                    productName: products.find((p: any) => p._id === form.getValues('productId'))?.name,
                    type: form.getValues('type'),
                    tags: form.getValues('tags'),
                    existingContent: htmlToPlainText(form.getValues('shortDescription') || ''),
                  })}
                  onPick={(t) => field.onChange(t)}
                />
              </div>
              <FormControl>
                <Input placeholder="e.g. Added new dashboard" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control as any}
            name="referenceUrl"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Reference URL (e.g. PR link)</FormLabel>
                <FormControl>
                  <Input placeholder="https://github.com/..." {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control as any}
            name="versionId"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Version (Optional)</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value || undefined} disabled={!selectedProductId || versions.length === 0}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={!selectedProductId ? "Select product first" : versions.length === 0 ? "No versions found" : "Select version"} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        <span className="flex items-center gap-2">
                          {v.label}
                          {v.isUnreleased && <VersionBadge kind="unreleased" size="xs" />}
                          {v.isLatest && <VersionBadge kind="latest" size="xs" />}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {form.watch('type') === 'bug-fix' && (
          <FormField
            control={form.control as any}
            name="relatedIssueIds"
            render={({ field }: any) => {
              const selected: string[] = field.value || [];
              const toggle = (id: string) => {
                field.onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
              };
              return (
                <FormItem>
                  <FormLabel>Resolved Issues (Optional)</FormLabel>
                  <p className="text-xs text-muted-foreground -mt-1 mb-1">
                    Link the issues this fix resolves. Linked open issues are marked <span className="font-medium">resolved</span> when you save.
                  </p>
                  <FormControl>
                    {!selectedProductId ? (
                      <p className="text-sm text-muted-foreground">Select a product first.</p>
                    ) : issues.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No issues logged for this product.</p>
                    ) : (
                      <div className="max-h-40 overflow-y-auto rounded-md border divide-y">
                        {issues.map((issue) => (
                          <label key={issue._id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50 text-sm">
                            <input
                              type="checkbox"
                              className="accent-primary"
                              checked={selected.includes(issue._id)}
                              onChange={() => toggle(issue._id)}
                            />
                            <span className="flex-1 truncate">{issue.title}</span>
                            <span className="text-[10px] font-bold uppercase tracking-wider rounded-full px-2 py-0.5 bg-muted text-muted-foreground shrink-0">
                              {issue.status}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </FormControl>
                  <FormMessage />
                </FormItem>
              );
            }}
          />
        )}

        <FormField
          control={form.control as any}
          name="shortDescription"
          render={({ field }: any) => (
            <FormItem>
              <div className="flex items-center justify-between gap-2">
                <FormLabel>Short Description</FormLabel>
                <GenerateDescriptionButton
                  entity="changelog entry"
                  getContext={() => ({
                    productName: products.find((p: any) => p._id === form.getValues('productId'))?.name,
                    type: form.getValues('type'),
                    tags: form.getValues('tags'),
                  })}
                  getTitle={() => form.getValues('title')}
                  onResult={(t) => field.onChange(t)}
                />
              </div>
              <FormControl>
                <RichTextEditor
                  ariaLabel="Short description"
                  placeholder="Brief summary of the change..."
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
          name="tags"
          render={({ field }: any) => {
            const currentTags = field.value || [];
            const toggleTag = (tag: string) => {
              if (currentTags.includes(tag)) {
                field.onChange(currentTags.filter((t: string) => t !== tag));
              } else {
                field.onChange([...currentTags, tag]);
              }
            };
            return (
              <FormItem>
                <FormLabel>Tags</FormLabel>
                <FormControl>
                  <div className="flex gap-2">
                    <Badge
                      variant={currentTags.includes('released') ? 'default' : 'outline'}
                      className="cursor-pointer transition-colors"
                      onClick={() => toggleTag('released')}
                    >
                      Released
                    </Badge>
                    <Badge
                      variant={currentTags.includes('unreleased') ? 'default' : 'outline'}
                      className="cursor-pointer transition-colors"
                      onClick={() => toggleTag('unreleased')}
                    >
                      Unreleased
                    </Badge>
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            );
          }}
        />

        <div className="space-y-2 border p-4 rounded-md">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium leading-none">Items</h4>
            <Button type="button" variant="outline" size="sm" onClick={() => append({ title: '', description: '' })}>
              <Plus className="w-3 h-3 mr-1" /> Add Item
            </Button>
          </div>
          {fields.map((field, index) => (
            <div key={field.id} className="flex gap-2 items-start mt-2 border-b pb-4 mb-4 border-dashed last:border-0 last:pb-0 last:mb-0">
              <div className="flex-1 space-y-4">
                <div className="space-y-2">
                  <Input placeholder="Item Title" {...form.register(`items.${index}.title` as const)} />
                  <RichTextEditor
                    ariaLabel="Item description"
                    placeholder="Item Description"
                    value={form.watch(`items.${index}.description`) || ''}
                    onChange={(v) => form.setValue(`items.${index}.description`, v, { shouldDirty: true })}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField
                    control={form.control as any}
                    name={`items.${index}.mediaType`}
                    render={({ field: itemMediaField }: any) => (
                      <FormItem>
                        <FormLabel>Item Media Type</FormLabel>
                        <Select onValueChange={itemMediaField.onChange} defaultValue={itemMediaField.value || undefined}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="None" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="image">Image</SelectItem>
                            <SelectItem value="gif">GIF</SelectItem>
                            <SelectItem value="video">Video</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control as any}
                    name={`items.${index}.mediaUrls`}
                    render={({ field: itemMediaUrlField }: any) => (
                      <FormItem>
                        <FormLabel>Item Media Upload</FormLabel>
                        <FormControl>
                          <MediaUploader
                            multiple
                            value={itemMediaUrlField.value}
                            onChange={itemMediaUrlField.onChange}
                            accept="image/*,video/*"
                            label="Upload item media"
                            onUploadComplete={(_urls, files) => {
                              const fileList = Array.isArray(files) ? files : [files];
                              if (fileList.length > 0) {
                                const fileType = fileList[0].type;
                                if (fileType.startsWith('video/')) {
                                  form.setValue(`items.${index}.mediaType`, 'video');
                                } else if (fileType === 'image/gif') {
                                  form.setValue(`items.${index}.mediaType`, 'gif');
                                } else if (fileType.startsWith('image/')) {
                                  form.setValue(`items.${index}.mediaType`, 'image');
                                }
                              }
                            }}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
              <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)}>
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border p-4 rounded-md">
          <FormField
            control={form.control as any}
            name="mediaType"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Media Type (Optional)</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value || undefined}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="image">Image</SelectItem>
                    <SelectItem value="gif">GIF</SelectItem>
                    <SelectItem value="video">Video</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control as any}
            name="mediaUrls"
            render={({ field }: any) => (
              <FormItem>
                <FormLabel>Media Upload</FormLabel>
                <FormControl>
                  <MediaUploader
                    multiple
                    value={field.value}
                    onChange={field.onChange}
                    accept="image/*,video/*"
                    label="Upload media"
                    onUploadComplete={(_urls, files) => {
                      const fileList = Array.isArray(files) ? files : [files];
                      if (fileList.length > 0) {
                        const fileType = fileList[0].type;
                        if (fileType.startsWith('video/')) {
                          form.setValue('mediaType', 'video');
                        } else if (fileType === 'image/gif') {
                          form.setValue('mediaType', 'gif');
                        } else if (fileType.startsWith('image/')) {
                          form.setValue('mediaType', 'image');
                        }
                      }
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <Button type="submit" className="w-full">
          {initialData ? 'Update Changelog Entry' : 'Create Changelog Entry'}
        </Button>
      </form>
    </Form>
  );
}
