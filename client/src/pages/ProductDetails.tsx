import { useParams, Link, useLocation, useSearchParams } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { useQuery, useInfiniteQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { getProductById } from '../services/products';
import { getActivities, reorderActivity, updateActivity, deleteActivity } from '../services/activities';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/DatePicker';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ActivityForm } from '../components/activities/ActivityForm';
import { ArrowLeft, GitBranch, Globe, ChevronDown, ChevronRight, Download, GripVertical, Edit2, Trash2, Bug, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import PageTransition from '../components/layout/PageTransition';
import { MarketingManager } from '../components/marketing/MarketingManager';
import { VersionManager } from '../components/versions/VersionManager';
import { VersionBadge } from '../components/versions/VersionBadge';
import { useProductVersions } from '../hooks/useVersions';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { compareVersionDesc } from '../lib/versions';
import { IssueManager } from '../components/issues/IssueManager';
import { IntelligenceHub } from '../components/intelligence/IntelligenceHub';
import { ReleaseReadinessPanel } from '../components/intelligence/ReleaseReadinessPanel';
import { WpReadmeViewer } from '../components/products/WpReadmeViewer';
import { ReleasePublish } from '../components/products/ReleasePublish';
import { MediaCarousel } from '@/components/ui/media-carousel';
import { AuthorAvatar } from '@/components/ui/AuthorAvatar';
import { RichText } from '@/components/ui/RichText';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { playSound } from '@/lib/sound';
import { useConfirm } from '../contexts/ConfirmContext';
import { ProductDetailsSkeleton, ProductActivitiesSkeleton } from '@/components/ui/skeletons';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ACTIVITY_TYPES } from '../../../consts';

// Issue status / severity → badge classes, dark-mode aware (mirrors the Issue Tracker).
const ISSUE_STATUS_BADGE: Record<string, string> = {
  open: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  'in-progress': 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  resolved: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  closed: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700/50 dark:text-zinc-300',
};
const ISSUE_SEVERITY_DOT: Record<string, string> = {
  low: 'bg-sky-500',
  medium: 'bg-amber-500',
  high: 'bg-orange-500',
  critical: 'bg-red-500',
};
const ISSUE_STATUS_LABEL: Record<string, string> = {
  open: 'Open', 'in-progress': 'In Progress', resolved: 'Resolved', closed: 'Closed',
};

const SortableActivityCard = ({ act, isActive, onClick, onEdit, onDelete, avatarFor, onIssueClick, latestLabel }: { act: any, isActive: boolean, onClick: () => void, onEdit: (act: any) => void, onDelete: (act: any) => void, avatarFor: (author: string) => string | undefined, onIssueClick: (issueId: string) => void, latestLabel?: string }) => {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: act._id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div 
      ref={setNodeRef} 
      style={style} 
      id={`activity-${act._id}`} 
      className={cn(
        "transition-all duration-300 h-full cursor-pointer",
        isActive ? "scale-[1.02]" : "hover:-translate-y-1"
      )}
      onClick={onClick}
    >
      <div className={cn(
        "bg-card text-card-foreground border rounded-[12px] p-6 h-full flex flex-col group relative transition-all duration-300",
        isActive
          ? "border-primary ring-2 ring-primary ring-offset-2 ring-offset-background shadow-xl shadow-primary/10"
          : "border-border shadow-sm hover:shadow-md"
      )}>
        <div className="absolute top-4 right-4 z-30 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
           <button
             type="button"
             aria-label={`Edit ${act.title}`}
             onClick={(e) => { e.stopPropagation(); onEdit(act); }}
             className="text-muted-foreground hover:text-foreground p-1 bg-muted rounded-md border"
           >
             <Edit2 className="w-4 h-4" />
           </button>
           <button
             type="button"
             aria-label={`Delete ${act.title}`}
             onClick={(e) => { e.stopPropagation(); onDelete(act); }}
             className="text-muted-foreground hover:text-destructive p-1 bg-muted rounded-md border"
           >
             <Trash2 className="w-4 h-4" />
           </button>
           <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground p-1 bg-muted rounded-md border">
             <GripVertical className="w-4 h-4" />
           </div>
        </div>

        {/* Media Presentation at the top */}
        {(() => {
          const urls = act.mediaUrls?.length ? act.mediaUrls : (act.mediaUrl ? [act.mediaUrl] : []);
          if (urls.length === 0) return null;
          return (
            <div className="mb-5 -mx-2">
              <MediaCarousel urls={urls} title={act.title} />
            </div>
          );
        })()}

        {/* Typography & Hierarchy */}
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-2 pr-8">
            <h4 className="font-semibold text-[18px] text-foreground leading-tight">{act.title}</h4>
            {act.versionId?.label && <span className="bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase">{act.versionId.label}</span>}
            {act.versionId?.label && latestLabel && act.versionId.label === latestLabel && <VersionBadge kind="latest" />}
            {act.tier === 'pro' && <span className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase">PRO</span>}
            {act.tags?.includes('released') && <VersionBadge kind="released" />}
            {act.tags?.includes('unreleased') && <VersionBadge kind="unreleased" />}
            {act.needsReview && (
              <Link
                to="/review"
                onClick={(e) => e.stopPropagation()}
                title="Imported type was guessed — review it"
                className="inline-flex items-center gap-1 bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300 ring-1 ring-amber-500/30 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase hover:bg-amber-200 dark:hover:bg-amber-900/70 transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Needs review
              </Link>
            )}
          </div>
          
          <p className="text-[14px] text-muted-foreground uppercase tracking-wider font-medium mb-2">
            {new Date(act.activityDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
          </p>

          {act.versionId?.author && (
            <div className="flex items-center gap-2 mb-3">
              <AuthorAvatar author={act.versionId.author} avatarUrl={avatarFor(act.versionId.author)} className="w-5 h-5" />
              <span className="text-[13px] text-muted-foreground font-medium">{act.versionId.author}</span>
            </div>
          )}

          <RichText html={act.shortDescription} className="text-[14px] text-muted-foreground leading-[1.6]" />

          {/* Resolved issues — linked from the Issue Tracker for bug-fix entries */}
          {Array.isArray(act.relatedIssueIds) && act.relatedIssueIds.length > 0 && (
            <div className="mt-5">
              <h5 className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">
                <Bug className="w-3.5 h-3.5" /> Resolved {act.relatedIssueIds.length === 1 ? 'issue' : 'issues'}
                <span className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal">{act.relatedIssueIds.length}</span>
              </h5>
              <div className="space-y-1.5">
                {act.relatedIssueIds.map((issue: any) => {
                  const issueId = issue?._id || issue;
                  return (
                    <button
                      key={issueId}
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onIssueClick(issueId); }}
                      title={issue?.title ? `View issue: ${issue.title}` : 'View issue'}
                      className="w-full flex items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-left transition-colors hover:bg-muted hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    >
                      <span
                        className={cn('w-1.5 h-1.5 rounded-full shrink-0', ISSUE_SEVERITY_DOT[issue?.severity] || 'bg-muted-foreground')}
                        title={issue?.severity ? `${issue.severity} severity` : undefined}
                      />
                      <span className="flex-1 text-[13px] text-foreground truncate">
                        {issue?.title || 'Untitled issue'}
                      </span>
                      {issue?.versionLabel && (
                        <span className="hidden sm:inline text-[11px] text-muted-foreground font-medium shrink-0">{issue.versionLabel}</span>
                      )}
                      {issue?.status && (
                        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase shrink-0', ISSUE_STATUS_BADGE[issue.status] || 'bg-muted text-muted-foreground')}>
                          {ISSUE_STATUS_LABEL[issue.status] || issue.status}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Sub-items */}
          {act.items && act.items.length > 0 && (
            <div className="mt-8 space-y-4">
              <h5 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Included Items</h5>
              {act.items.map((item: any, idx: number) => (
                <div key={idx} className="bg-muted/50 border border-border rounded-xl p-4 transition-colors hover:bg-muted">
                  {(() => {
                    const itemUrls = item.mediaUrls?.length ? item.mediaUrls : (item.mediaUrl ? [item.mediaUrl] : []);
                    if (itemUrls.length === 0) return null;
                    return (
                      <div className="mb-4">
                        <MediaCarousel urls={itemUrls} title={item.title} />
                      </div>
                    );
                  })()}
                  <h6 className="font-semibold text-[15px] text-foreground">{item.title}</h6>
                  <RichText html={item.description} className="text-[14px] text-muted-foreground leading-[1.6] mt-1.5" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ActivitySection = ({ title, items: typeActs, colorClass, activeCardId, onCardClick, onEdit, onDelete, avatarFor, onIssueClick, latestLabel }: { title: string, items: any[], colorClass: string, activeCardId: string | null, onCardClick: (id: string) => void, onEdit: (act: any) => void, onDelete: (act: any) => void, avatarFor: (author: string) => string | undefined, onIssueClick: (issueId: string) => void, latestLabel?: string }) => {
  const [isOpen, setIsOpen] = useState(true);
  // Clip only while the height animation runs; once open, allow overflow so an
  // active card's scale/ring/shadow aren't sliced off at the grid edges.
  const [animating, setAnimating] = useState(false);
  if (typeActs.length === 0) return null;
  return (
    <div className="space-y-4 mb-10">
      <h3 
        className={`text-xl font-semibold flex items-center gap-2 ${colorClass} cursor-pointer select-none hover:opacity-80 transition-opacity w-fit`}
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? <ChevronDown className="w-5 h-5 shrink-0" /> : <ChevronRight className="w-5 h-5 shrink-0" />} 
        {title} <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-xs font-medium ml-1">{typeActs.length}</span>
      </h3>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            onAnimationStart={() => setAnimating(true)}
            onAnimationComplete={() => setAnimating(false)}
            style={{ overflow: animating ? 'hidden' : 'visible' }}
          >
            <div className="mt-4 pt-2 pb-4">
              <SortableContext items={typeActs.map(a => a._id)} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
                  {typeActs.map((act: any) => (
                    <SortableActivityCard
                      key={act._id}
                      act={act}
                      isActive={activeCardId === act._id}
                      onClick={() => onCardClick(act._id)}
                      onEdit={onEdit}
                      onDelete={onDelete}
                      avatarFor={avatarFor}
                      onIssueClick={onIssueClick}
                      latestLabel={latestLabel}
                    />
                  ))}
                </div>
              </SortableContext>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default function ProductDetails() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  // Single source for this product's versions — drives the filter options and
  // the "Latest" flag on activity cards (shared with VersionManager's cache).
  const { versions: productVersions } = useProductVersions(id);
  const [activeTab, setActiveTab] = useState<'activities' | 'marketing' | 'versions' | 'readme' | 'release' | 'issues' | 'intelligence'>('activities');
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [type, setType] = useState('all');
  const [tier, setTier] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [versionFilter, setVersionFilter] = useState<string>('all');
  const [editingActivity, setEditingActivity] = useState<any>(null);
  // Set when a linked issue is clicked from a changelog card — switches to the
  // Issues tab and tells IssueManager which issue to scroll to and highlight.
  const [focusIssueId, setFocusIssueId] = useState<string | null>(null);
  const handleIssueClick = (issueId: string) => { setActiveTab('issues'); setFocusIssueId(issueId); };

  const updateMutation = useMutation({
    mutationFn: updateActivity,
    onSuccess: () => {
      playSound('success');
      toast.success('Changelog entry updated successfully');
      queryClient.invalidateQueries({ queryKey: ['activities', id] });
      setEditingActivity(null);
    },
    onError: () => {
      playSound('error');
      toast.error('Failed to update changelog entry');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteActivity,
    onSuccess: () => {
      playSound('delete');
      toast.success('Changelog entry deleted successfully');
      queryClient.invalidateQueries({ queryKey: ['activities', id] });
    },
    onError: () => {
      playSound('error');
      toast.error('Failed to delete changelog entry');
    },
  });

  const handleEditActivity = (act: any) => {
    setEditingActivity({
      ...act,
      productId: act.productId?._id || id,
      versionId: typeof act.versionId === 'object' ? act.versionId?._id : act.versionId,
      activityDate: format(new Date(act.activityDate), 'yyyy-MM-dd'),
      tags: act.tags || [],
    });
  };

  const handleDeleteActivity = async (act: any) => {
    if (await confirm({ title: 'Delete Changelog Entry', description: 'Are you sure you want to permanently delete this changelog entry?' })) {
      deleteMutation.mutate(act._id);
    }
  };

  const { data: product, isLoading: productLoading } = useQuery({
    queryKey: ['product', id],
    queryFn: () => getProductById(id as string),
  });
  useDocumentTitle(product?.name);

  const { data: wpData } = useQuery({
    queryKey: ['wp-plugin', product?.wpOrgSlug],
    queryFn: async () => {
      if (!product?.wpOrgSlug) return null;
      try {
        const res = await fetch(`https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=${product.wpOrgSlug}`);
        if (!res.ok) return null;
        return res.json();
      } catch (e) {
        return null;
      }
    },
    enabled: !!product?.wpOrgSlug,
  });

  // The timeline lazy-loads in pages (infinite scroll + "Load More") instead of
  // fetching every entry up front.
  const ACTIVITIES_PAGE_SIZE = 9;

  const queryParams: any = { productId: id, limit: ACTIVITIES_PAGE_SIZE, sortBy: 'displayOrder', sortOrder: 'asc' };
  if (type !== 'all') queryParams.type = type;
  if (type === 'feature' && tier !== 'all') queryParams.tier = tier;
  if (tagFilter !== 'all') queryParams.tags = tagFilter;
  if (debouncedSearch) queryParams.search = debouncedSearch;
  if (startDate) queryParams.startDate = startDate;
  if (endDate) queryParams.endDate = endDate;
  if (versionFilter === '__none__') queryParams.versioned = 'none';

  const {
    data: activitiesPages,
    isLoading: activitiesLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['activities', id, type, tier, tagFilter, debouncedSearch, startDate, endDate, versionFilter === '__none__' ? 'none' : 'all'],
    queryFn: ({ pageParam }) => getActivities({ ...queryParams, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (lastPage: any) => (lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined),
    enabled: !!id,
  });
  // Dedupe by _id while flattening. The server now sorts on a total ordering so
  // pages can't overlap, but offset pagination still shifts if a row is inserted
  // or deleted between page fetches (e.g. a WP.org import running while the user
  // scrolls) — which would otherwise render the same entry twice.
  const allActivities: any[] = (() => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const p of activitiesPages?.pages ?? []) {
      for (const a of (p as any).data ?? []) {
        const key = String(a?._id ?? '');
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        out.push(a);
      }
    }
    return out;
  })();
  const totalActivities: number = activitiesPages?.pages?.[0]?.total ?? 0;

  // Sentinel for infinite scroll; observed only when the Activity tab is open and
  // no version filter is active (a filter narrows the loaded set, so we fall back
  // to the manual "Load More" button to avoid auto-loading the whole list).
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const location = useLocation();

  // Allow the sidebar (and any link) to deep-link to a tab via ?tab=.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'activities' || tab === 'versions' || tab === 'marketing' || tab === 'readme' || tab === 'release' || tab === 'issues' || tab === 'intelligence') {
      setActiveTab(tab);
    }
    // Deep-link straight to a specific issue (e.g. from the dashboard): open the
    // Issues tab and let IssueManager scroll to / highlight it.
    const issueId = searchParams.get('issue');
    if (issueId) {
      setActiveTab('issues');
      setFocusIssueId(issueId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (allActivities.length && location.hash && activeTab === 'activities') {
      const targetId = location.hash.replace('#', '');
      const timer = setTimeout(() => {
        const element = document.getElementById(targetId);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          element.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'rounded-lg');
          setTimeout(() => {
            element.classList.remove('ring-2', 'ring-primary', 'ring-offset-2');
          }, 2000);
        }
      }, 300);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allActivities.length, location.hash, activeTab]);

  // Auto-load the next page when the sentinel scrolls into view.
  useEffect(() => {
    if (activeTab !== 'activities' || versionFilter !== 'all' || !hasNextPage) return;
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage();
      },
      { rootMargin: '300px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeTab, versionFilter, hasNextPage, isFetchingNextPage, fetchNextPage, allActivities.length]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = async (event: any) => {
    const { active, over } = event;
    // Dropping outside any sortable target -> no-op (over is null).
    if (!over || active.id === over.id) return;

    const list: any[] = allActivities;
    const act = list.find((a: any) => a._id === active.id);
    const overAct = list.find((a: any) => a._id === over.id);
    if (!act || !overAct) return;

    // Cards are rendered grouped by type. Reorder only within the active card's
    // type group so it lands where it was dropped (computing against the global
    // mixed list would land it at the wrong position).
    const group = list.filter((a: any) => a.type === act.type);
    const targetIndex = group.findIndex((a: any) => a._id === over.id);
    if (targetIndex === -1) return;

    try {
      await reorderActivity(act._id, targetIndex);
      queryClient.invalidateQueries({ queryKey: ['activities', id] });
    } catch (err) {
      console.error('Failed to reorder activity:', err);
      toast.error('Failed to reorder activity');
    }
  };

  const exportChangelog = async () => {
    // Export always covers the full changelog, not just the loaded pages.
    let all: any[] = [];
    try {
      const res = await getActivities({ productId: id, limit: -1, sortBy: 'displayOrder', sortOrder: 'asc' });
      all = res?.data || [];
    } catch {
      toast.error('Failed to export changelog');
      return;
    }
    if (!all.length) return;
    let markdown = `# Changelog - ${product?.name}\n\n`;
    all.forEach((act: any) => {
      markdown += `## ${act.title}\n`;
      const versionPart = act.versionId?.label ? ` | Version: ${act.versionId.label}` : '';
      markdown += `*Date: ${new Date(act.activityDate).toLocaleDateString()} | Type: ${act.type}${versionPart}*\n\n`;
      markdown += `${act.shortDescription}\n\n`;
    });
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${product?.slug}-changelog.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (productLoading) return <ProductDetailsSkeleton />;
  if (!product) return <div>Product not found</div>;

  // The version filter is populated from the product's real version list, so
  // every version shows (even ones with no activities yet) with its Latest /
  // Unreleased badge. Any orphan labels still on activities are appended.
  const activityLabels = Array.from(
    new Set(allActivities.map((a: any) => a.versionId?.label).filter(Boolean) as string[]),
  );
  const knownLabels = new Set(productVersions.map((v) => v.label));
  const versionOptions = [
    ...productVersions.map((v) => ({ label: v.label, isUnreleased: v.isUnreleased, isLatest: v.isLatest })),
    ...activityLabels
      .filter((l) => !knownLabels.has(l))
      .sort(compareVersionDesc)
      .map((label) => ({ label, isUnreleased: false, isLatest: false })),
  ];
  const latestLabel = productVersions.find((v) => v.isLatest)?.label;
  const hasUnversioned = allActivities.some((a: any) => !a.versionId?.label);

  const activities = allActivities.filter((a: any) => {
    if (versionFilter === 'all') return true;
    if (versionFilter === '__none__') return !a.versionId?.label;
    return a.versionId?.label === versionFilter;
  });
  // Map WP.org contributor usernames -> avatar URL so activity authors that are
  // plugin contributors get their exact WP.org avatar (others fall back to the
  // WP.org gravatar redirect inside AuthorAvatar).
  const contribAvatars: Record<string, string> = {};
  if (wpData?.contributors) {
    for (const [username, c] of Object.entries<any>(wpData.contributors)) {
      if (c?.avatar) contribAvatars[username.toLowerCase()] = c.avatar;
    }
  }
  const avatarFor = (author: string) => contribAvatars[author.trim().toLowerCase()];



  return (
    <PageTransition>
    <div className="space-y-6">
      <Button variant="ghost" asChild className="mb-4 -ml-4">
        <Link to="/products">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Products
        </Link>
      </Button>

      <div className="bg-card text-card-foreground border rounded-lg overflow-hidden mb-8 shadow-sm">
        {product.banner ? (
          <div className="w-full h-[375px] bg-muted relative">
            <img src={product.banner} alt={`${product.name} Banner`} className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="w-full h-[375px] bg-muted/30 flex flex-col items-center justify-center text-muted-foreground border-b relative overflow-hidden">
             <div className="absolute inset-0 bg-grid-slate-100 [mask-image:linear-gradient(0deg,#fff,rgba(255,255,255,0.6))] dark:bg-grid-slate-700/25 dark:[mask-image:linear-gradient(0deg,rgba(255,255,255,0.1),rgba(255,255,255,0.5))]" style={{ backgroundSize: '30px 30px', backgroundImage: 'linear-gradient(to right, #e2e8f0 1px, transparent 1px), linear-gradient(to bottom, #e2e8f0 1px, transparent 1px)'}}></div>
             <div className="z-10 text-xl font-semibold opacity-50">{product.name}</div>
          </div>
        )}

        <div className="p-6 flex flex-col md:flex-row md:items-start gap-6">
          {product.icon ? (
            <img src={product.icon} alt="Icon" className="w-[100px] h-[100px] rounded-md object-cover flex-shrink-0 bg-muted border shadow-sm" />
          ) : (
            <div className="w-[100px] h-[100px] rounded-md bg-primary flex items-center justify-center text-primary-foreground font-bold flex-shrink-0 text-3xl">
               {product.name.substring(0, 2).toUpperCase()}
            </div>
          )}
          
          <div className="flex-1 space-y-1">
            <h1 className="text-2xl font-bold text-foreground leading-tight">
               {wpData && wpData.name ? wpData.name : product.name.replace(/-/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}
            </h1>
            <p className="text-sm text-muted-foreground">
               By <span className="text-primary font-medium hover:underline cursor-pointer">{wpData && wpData.author ? wpData.author.replace(/(<([^>]+)>)/gi, "") : 'bPlugins'}</span>
            </p>
            <RichText html={product.description} className="text-muted-foreground text-sm mt-2" />
            
            <div className="flex gap-4 mt-3 pt-2">
              <Badge variant="outline" className="capitalize">{product.category}</Badge>
              <Badge variant={product.status === 'active' ? 'default' : 'secondary'} className="capitalize">
                {product.status}
              </Badge>
              <a href={product.githubUrl} target="_blank" rel="noreferrer" className="flex items-center text-muted-foreground hover:text-primary transition-colors" title="GitHub Repository">
                <GitBranch className="w-5 h-5" />
              </a>
              {product.wpOrgSlug && (
                <a href={`https://wordpress.org/plugins/${product.wpOrgSlug}`} target="_blank" rel="noreferrer" className="flex items-center text-muted-foreground hover:text-primary transition-colors" title="WordPress.org Page">
                  <Globe className="w-5 h-5" />
                </a>
              )}
            </div>
          </div>
          
          {/* <div className="w-full md:w-[250px] shrink-0">
            <Card className="h-full">
              <CardHeader className="py-3 px-4">
                <CardTitle className="text-sm">Activity Distribution</CardTitle>
              </CardHeader>
              <CardContent className="py-0 px-4 pb-3">
                <DonutChart data={{ features: features.length, improvements: improvements.length, bugFixes: bugFixes.length }} />
              </CardContent>
            </Card>
          </div> */}
        </div>
      </div>

      <div className="pt-2">
        <div className="flex space-x-4 border-b mb-6 pb-2">
          <button 
            className={`pb-2 text-lg font-bold border-b-2 transition-colors ${activeTab === 'intelligence' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => setActiveTab('intelligence')}
          >
            Intelligence
          </button>
          <button 
            className={`pb-2 text-lg font-bold border-b-2 transition-colors ${activeTab === 'activities' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => setActiveTab('activities')}
          >
            Activity Timeline
          </button>
          <button 
            className={`pb-2 text-lg font-bold border-b-2 transition-colors ${activeTab === 'versions' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => setActiveTab('versions')}
          >
            Versions
          </button>
          <button
            className={`pb-2 text-lg font-bold border-b-2 transition-colors ${activeTab === 'marketing' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => setActiveTab('marketing')}
          >
            Marketing Hub
          </button>
          <button
            className={`pb-2 text-lg font-bold border-b-2 transition-colors ${activeTab === 'release' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => setActiveTab('release')}
          >
            Release
          </button>
          <button
            className={`pb-2 text-lg font-bold border-b-2 transition-colors ${activeTab === 'issues' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => setActiveTab('issues')}
          >
            Issues
          </button>
          {product?.wpReadme && (
            <button 
              className={`pb-2 text-lg font-bold border-b-2 transition-colors ${activeTab === 'readme' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              onClick={() => setActiveTab('readme')}
            >
              Readme
            </button>
          )}
        </div>

        {activeTab === 'intelligence' && (
          <div className="mt-6 mb-12">
            <IntelligenceHub productId={id as string} />
          </div>
        )}

        {activeTab === 'activities' && (
          <div className="space-y-6">
            <div className="bg-card rounded-lg border overflow-hidden">
              <div className="flex flex-wrap items-center gap-3 p-3 border-b">
                <Input
                  placeholder="Search changelogs..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-9 w-[220px] flex-shrink-0"
                />
                <div className="w-px h-5 bg-border flex-shrink-0" />
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger className="h-9 w-[150px] flex-shrink-0">
                    <SelectValue placeholder="All Types" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="feature">Feature</SelectItem>
                    <SelectItem value="improvement">Improvement</SelectItem>
                    <SelectItem value="bug-fix">Bug Fix</SelectItem> */}

                    {ACTIVITY_TYPES.map((type: string) => (
                      <SelectItem key={type} value={type}>{type}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {type === 'feature' && (
                  <Select value={tier} onValueChange={setTier}>
                    <SelectTrigger className="h-9 w-[110px] flex-shrink-0">
                      <SelectValue placeholder="All Tiers" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Tiers</SelectItem>
                      <SelectItem value="free">Free</SelectItem>
                      <SelectItem value="pro">Pro</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                <Select value={tagFilter} onValueChange={setTagFilter}>
                  <SelectTrigger className="h-9 w-[130px] flex-shrink-0">
                    <SelectValue placeholder="All Tags" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Tags</SelectItem>
                    <SelectItem value="released">Released</SelectItem>
                    <SelectItem value="unreleased">Unreleased</SelectItem>
                  </SelectContent>
                </Select>
                {(versionOptions.length > 0 || hasUnversioned) && (
                  <Select value={versionFilter} onValueChange={setVersionFilter}>
                    <SelectTrigger className="h-9 w-[200px] flex-shrink-0">
                      <SelectValue placeholder="All Versions" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Versions</SelectItem>
                      {versionOptions.map((opt) => (
                        <SelectItem key={opt.label} value={opt.label}>
                          <span className="flex items-center gap-2">
                            {opt.label}
                            {opt.isUnreleased && <VersionBadge kind="unreleased" size="xs" />}
                            {opt.isLatest && <VersionBadge kind="latest" size="xs" />}
                          </span>
                        </SelectItem>
                      ))}
                      {hasUnversioned && <SelectItem value="__none__">Unversioned</SelectItem>}
                    </SelectContent>
                  </Select>
                )}
                <div className="ml-auto flex shrink-0">
                  <Button variant="outline" size="sm" onClick={exportChangelog} className="h-9">
                    <Download className="w-4 h-4 mr-2" /> Export
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 px-3 py-2.5 bg-muted/20">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                  Date Range
                </span>
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5">
                    <label className="text-xs text-muted-foreground whitespace-nowrap">From</label>
                    <DatePicker
                      value={startDate}
                      onChange={setStartDate}
                      placeholder="Start date"
                      max={endDate || undefined}
                      clearable
                      className="h-8 w-[160px] text-sm"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <label className="text-xs text-muted-foreground whitespace-nowrap">To</label>
                    <DatePicker
                      value={endDate}
                      onChange={setEndDate}
                      placeholder="End date"
                      min={startDate || undefined}
                      clearable
                      className="h-8 w-[160px] text-sm"
                    />
                  </div>
                  {(startDate || endDate) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => { setStartDate(''); setEndDate(''); }}
                    >
                      Clear dates
                    </Button>
                  )}
                </div>
                {(search || type !== 'all' || tagFilter !== 'all' || versionFilter !== 'all' || startDate || endDate) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground ml-auto"
                    onClick={() => {
                      setSearch('');
                      setType('all');
                      setTier('all');
                      setTagFilter('all');
                      setVersionFilter('all');
                      setStartDate('');
                      setEndDate('');
                    }}
                  >
                    Reset all filters
                  </Button>
                )}
              </div>
            </div>
            {activitiesLoading ? (
              <ProductActivitiesSkeleton />
            ) : allActivities.length === 0 ? (
              <div className="text-muted-foreground">No activities recorded for this product yet.</div>
            ) : (
              <>
                {activities.length === 0 ? (
                  <div className="text-muted-foreground">
                    No activities found for the selected version{hasNextPage ? ' yet — load more to keep looking.' : '.'}
                  </div>
                ) : (
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    {/* <ActivitySection title="Features" items={features} colorClass="text-blue-600 dark:text-blue-400" activeCardId={activeCardId} onCardClick={setActiveCardId} onEdit={handleEditActivity} onDelete={handleDeleteActivity} avatarFor={avatarFor} onIssueClick={handleIssueClick} latestLabel={latestLabel} />
                    <ActivitySection title="Improvements" items={improvements} colorClass="text-purple-600 dark:text-purple-400" activeCardId={activeCardId} onCardClick={setActiveCardId} onEdit={handleEditActivity} onDelete={handleDeleteActivity} avatarFor={avatarFor} onIssueClick={handleIssueClick} latestLabel={latestLabel} />
                    <ActivitySection title="Bug Fixes" items={bugFixes} colorClass="text-red-600 dark:text-red-400" activeCardId={activeCardId} onCardClick={setActiveCardId} onEdit={handleEditActivity} onDelete={handleDeleteActivity} avatarFor={avatarFor} onIssueClick={handleIssueClick} latestLabel={latestLabel} /> */}
                    {ACTIVITY_TYPES.map((type: string) => (
                      <ActivitySection key={type} title={type} 
                      items={activities.filter((activity: any) => activity.type === type)} colorClass="text-blue-600 dark:text-blue-400" activeCardId={activeCardId} onCardClick={setActiveCardId} onEdit={handleEditActivity} onDelete={handleDeleteActivity} avatarFor={avatarFor} onIssueClick={handleIssueClick} latestLabel={latestLabel} />
                    ))} 
                  </DndContext>
                )}

                {/* Lazy-load footer: sentinel (auto), spinner, and a manual Load More */}
                {versionFilter === 'all' && hasNextPage && <div ref={loadMoreRef} aria-hidden className="h-px" />}
                {isFetchingNextPage && (
                  <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading more…
                  </div>
                )}
                {hasNextPage && !isFetchingNextPage && (
                  <div className="flex justify-center pt-2 pb-4">
                    <Button variant="outline" onClick={() => fetchNextPage()}>
                      Load more
                      <span className="ml-1.5 text-muted-foreground">({Math.max(totalActivities - allActivities.length, 0)} more)</span>
                    </Button>
                  </div>
                )}
                {!hasNextPage && totalActivities > ACTIVITIES_PAGE_SIZE && (
                  <p className="text-center text-xs text-muted-foreground pt-2 pb-4">
                    All {totalActivities} entries loaded.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'versions' && id && (
          <VersionManager productId={id} wpData={wpData} githubUrl={product?.githubUrl} />
        )}

        {activeTab === 'marketing' && id && (
          <MarketingManager productId={id} />
        )}

        {activeTab === 'release' && id && (
          <div className="space-y-8">
            {/* The readiness gate lives here rather than under Intelligence: it answers a
                question you have at the moment of shipping, not one you browse. */}
            <ReleaseReadinessPanel productId={id} />
            <ReleasePublish productId={id} />
          </div>
        )}

        {activeTab === 'issues' && id && (
          <IssueManager productId={id} focusIssueId={focusIssueId} onFocusHandled={() => setFocusIssueId(null)} />
        )}

        {activeTab === 'readme' && product?.wpReadme && (
          <WpReadmeViewer content={product.wpReadme} wpData={wpData} />
        )}
      </div>

      <Dialog open={!!editingActivity} onOpenChange={(open: boolean) => !open && setEditingActivity(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Changelog Entry</DialogTitle>
          </DialogHeader>
          {editingActivity && (
            <ActivityForm
              key={editingActivity._id}
              initialData={editingActivity}
              onSubmit={(data: any) => {
                if (!data.mediaType) data.mediaType = null;
                if (!data.mediaUrl) data.mediaUrl = null;
                updateMutation.mutate({ id: editingActivity._id, ...data });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
    </PageTransition>
  );
}
