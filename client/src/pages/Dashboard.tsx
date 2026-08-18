import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { getMonthlyReport, getTrendData } from '../services/reports';
import { getProducts, getStaleProducts, type StaleProduct } from '../services/products';
import { getActivities, updateActivity } from '../services/activities';
import { getAuditLogs } from '../services/auditLogs';
import { getAllIssues, type IssueWithProduct } from '../services/issues';
import { useAllVersions } from '../hooks/useVersions';
import { VersionBadge } from '../components/versions/VersionBadge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { playSound } from '@/lib/sound';
import { Package, PlusCircle, Wrench, Bug, FileText, Activity as ActivityIcon, ArrowRight, Play, ServerOff, Puzzle, LayoutGrid, AlertTriangle, Rocket, CircleCheck, Tag, Clock, Globe, Copy, Check } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import PageTransition, { staggerContainer, staggerItem } from '../components/layout/PageTransition';
import { TrendChart } from '../components/reports/TrendChart';
import { DashboardSkeleton } from '@/components/ui/skeletons';
import { QuickIssueDialog } from '../components/issues/QuickIssueDialog';
import { classifyStale } from '../components/products/StaleProductAlert';
import { PortfolioHealthWidget } from '../components/intelligence/PortfolioHealthWidget';

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-red-500', high: 'bg-orange-500', medium: 'bg-amber-500', low: 'bg-sky-500',
};
const TYPE_DOT: Record<string, string> = {
  feature: 'bg-blue-500', improvement: 'bg-purple-500', 'bug-fix': 'bg-red-500',
};

export default function Dashboard() {
  const [quickIssueOpen, setQuickIssueOpen] = useState(false);
  const [copiedPublic, setCopiedPublic] = useState(false);

  // Quick access to the public-facing product directory.
  const publicDirectoryUrl = `${window.location.origin}/explore`;
  const copyPublicUrl = async () => {
    try {
      await navigator.clipboard.writeText(publicDirectoryUrl);
      setCopiedPublic(true);
      playSound('click');
      setTimeout(() => setCopiedPublic(false), 1800);
    } catch {
      toast.error('Could not copy link');
    }
  };
  const [staleBannerDismissed, setStaleBannerDismissed] = useState(false);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const assignVersion = useMutation({
    mutationFn: ({ id, productId, versionId }: { id: string; productId: string; versionId: string }) =>
      updateActivity({ id, productId, versionId }),
    onMutate: (vars) => setAssigningId(vars.id),
    onSuccess: (_res, vars) => {
      playSound('success');
      toast.success('Version assigned');
      queryClient.invalidateQueries({ queryKey: ['dashboardActivities'] });
      queryClient.invalidateQueries({ queryKey: ['release', vars.productId] });
      queryClient.invalidateQueries({ queryKey: ['allVersions'] });
    },
    onError: () => { playSound('error'); toast.error('Could not assign version'); },
    onSettled: () => setAssigningId(null),
  });
  const today = new Date();
  const currentMonth = today.getMonth() + 1;
  const currentYear = today.getFullYear();

  const { data: report, isLoading: isReportLoading, isError: isReportError } = useQuery({
    queryKey: ['dashboardReport', currentMonth, currentYear],
    queryFn: () => getMonthlyReport({ month: currentMonth, year: currentYear }),
  });

  const { data: productsData, isLoading: isProductsLoading, isError: isProductsError } = useQuery({
    queryKey: ['dashboardProducts'],
    queryFn: () => getProducts(),
  });

  const { data: activitiesData, isLoading: isActivitiesLoading, isError: isActivitiesError } = useQuery({
    queryKey: ['dashboardActivities'],
    queryFn: () => getActivities({ limit: -1 }),
  });

  const { data: auditLogsData, isLoading: isAuditLogsLoading, isError: isAuditLogsError } = useQuery({
    queryKey: ['dashboardAuditLogs'],
    queryFn: () => getAuditLogs(),
  });

  const { data: trendData, isLoading: isTrendLoading, isError: isTrendError } = useQuery({
    queryKey: ['dashboardTrend'],
    queryFn: () => getTrendData({ months: 6 }),
  });

  // Issues load independently so a slow/failed issues fetch never blocks the
  // rest of the dashboard.
  const { data: issuesData, isLoading: isIssuesLoading } = useQuery({
    queryKey: ['allIssues'],
    queryFn: () => getAllIssues(),
  });

  // Single source for all products' versions (decorated + grouped per product).
  const { raw: versionsData, byProduct: versionsByProduct } = useAllVersions();

  const { data: staleData, isLoading: isStaleLoading } = useQuery({
    queryKey: ['staleProducts'],
    queryFn: () => getStaleProducts(),
  });

  if (isReportLoading || isProductsLoading || isActivitiesLoading || isAuditLogsLoading || isTrendLoading) {
    return <DashboardSkeleton />;
  }

  if (isReportError || isProductsError || isActivitiesError || isAuditLogsError || isTrendError) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ServerOff className="w-10 h-10 text-destructive mb-4" />
        <h2 className="text-xl font-semibold">Couldn't load your dashboard</h2>
        <p className="text-muted-foreground mt-2">Something went wrong fetching your data. Please try again.</p>
      </div>
    );
  }

  const summary = report?.summary || {
    products: 0,
    features: 0,
    improvements: 0,
    bugFixes: 0,
    totalActivities: 0,
  };

  const allProducts = productsData?.data || [];
  const activeProducts = allProducts.filter((p: any) => p.status === 'active');
  const inactiveProducts = allProducts.filter((p: any) => p.status === 'inactive');
  const plugins = allProducts.filter((p: any) => p.category === 'plugin');
  const blocks = allProducts.filter((p: any) => p.category === 'block');

  const allActivities = activitiesData?.data || [];
  
  const recentActivities = auditLogsData || [];

  const totalFeatures = allActivities.filter((a: any) => a.type === 'feature').length;
  const totalImprovements = allActivities.filter((a: any) => a.type === 'improvement').length;
  const totalBugs = allActivities.filter((a: any) => a.type === 'bug-fix').length;
  const totalReleased = allActivities.filter((a: any) => a.tags?.includes('released')).length;
  const totalUnreleased = allActivities.filter((a: any) => a.tags?.includes('unreleased')).length;
  const grandTotal = totalFeatures + totalImprovements + totalBugs || 1;

  const featurePct = Math.round((totalFeatures / grandTotal) * 100);
  const improvePct = Math.round((totalImprovements / grandTotal) * 100);
  const bugPct = grandTotal > 1 ? (100 - featurePct - improvePct) : Math.round((totalBugs / grandTotal) * 100);

  // --- Issues (across all products) ---
  const allIssues: IssueWithProduct[] = issuesData || [];
  const productNameOf = (pid: any) => (typeof pid === 'object' && pid ? pid.name : allProducts.find((p: any) => p._id === pid)?.name) || 'Unknown';
  const productIdOf = (pid: any) => (typeof pid === 'object' && pid ? pid._id : pid);
  const openIssues = allIssues
    .filter((i) => i.status === 'open' || i.status === 'in-progress')
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
  const criticalCount = openIssues.filter((i) => i.severity === 'critical').length;

  // --- Pending release, grouped by product: unreleased changelog entries
  // (activities tagged "unreleased") plus versions explicitly marked unreleased.
  type Pending = { id: string; name: string; entries: number; versions: number; versionLabels: string[] };
  const pendingMap: Record<string, Pending> = {};
  const ensurePending = (rawId: any, name?: string): Pending | null => {
    const id = rawId?._id || rawId;
    if (!id) return null;
    const key = String(id);
    if (!pendingMap[key]) {
      pendingMap[key] = {
        id: key,
        name: name || allProducts.find((p: any) => p._id === key)?.name || 'Unknown',
        entries: 0, versions: 0, versionLabels: [],
      };
    }
    return pendingMap[key];
  };

  const unreleasedActs = allActivities.filter((a: any) => a.tags?.includes('unreleased'));
  unreleasedActs.forEach((a: any) => {
    const p = ensurePending(a.productId, a.productId?.name);
    if (p) p.entries += 1;
  });

  const allVersions: any[] = versionsData || [];
  allVersions
    .filter((v: any) => v.status === 'unreleased')
    .forEach((v: any) => {
      const p = ensurePending(v.productId, v.productId?.name);
      if (p) { p.versions += 1; if (v.label) p.versionLabels.push(v.label); }
    });

  const pendingByProduct = Object.values(pendingMap).sort(
    (a, b) => (b.entries + b.versions) - (a.entries + a.versions)
  );
  const totalUnreleasedVersions = allVersions.filter((v: any) => v.status === 'unreleased').length;

  // --- Unversioned changelog entries (no version assigned) — quick triage ---
  const unversionedActs = allActivities
    .filter((a: any) => !a.versionId)
    .sort((a: any, b: any) => new Date(b.activityDate).getTime() - new Date(a.activityDate).getTime());

  // --- Stale products (no changelog update within the configured window) ---
  const staleProducts: StaleProduct[] = staleData?.products || [];
  const staleDays = staleData?.days ?? 7;
  const criticalStale = staleProducts.map((p) => classifyStale(p, staleDays)).filter((c) => c.level === 'critical');

  // `versionsByProduct` (decorated + per-product Latest/Unreleased flags) now
  // comes from the shared useAllVersions hook above.

  const getLogLink = (log: any) => {
    if (log.action === 'DELETE') return '#';
    if (log.entityType === 'PRODUCT') return `/products/${log.entityId}`;
    if (log.entityType === 'ACTIVITY') {
       const act = allActivities.find((a: any) => a._id === log.entityId);
       if (act && act.productId) {
         return `/products/${act.productId._id || act.productId}#activity-${log.entityId}`;
       }
       return '/activities';
    }
    return '#';
  };

  const getProductNameForLog = (log: any) => {
    if (log.entityType === 'ACTIVITY') {
      const act = allActivities.find((a: any) => a._id === log.entityId);
      if (act && act.productId) {
        const prod = allProducts.find((p: any) => p._id === (act.productId._id || act.productId));
        return prod ? prod.name : null;
      }
    }
    return null;
  };

  return (
    <PageTransition className="space-y-6 pb-12">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Command Center</h2>
          <p className="text-muted-foreground mt-1">Here's what's happening across your products.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/products"><Package className="w-4 h-4 mr-2" /> Manage Products</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/activities"><ActivityIcon className="w-4 h-4 mr-2" /> Log Activity</Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setQuickIssueOpen(true)}
            disabled={allProducts.length === 0}
          >
            <Bug className="w-4 h-4 mr-2" /> Report Issue
          </Button>
          {/* Public site quick access: open the directory + copy its shareable link. */}
          <div className="inline-flex items-center rounded-md border overflow-hidden">
            <a
              href="/explore"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 h-9 px-3 text-sm font-medium hover:bg-accent transition-colors"
            >
              <Globe className="w-4 h-4" /> Public Site
            </a>
            <button
              type="button"
              onClick={copyPublicUrl}
              title="Copy public directory link"
              aria-label="Copy public directory link"
              className="inline-flex items-center justify-center h-9 w-9 border-l hover:bg-accent transition-colors"
            >
              {copiedPublic ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
          <Button size="sm" asChild>
            <Link to="/reports"><FileText className="w-4 h-4 mr-2" /> View Reports</Link>
          </Button>
        </div>
      </div>

      {/* Daily logging habit and Portfolio Health */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* <StreakCard /> */}
        <div className="lg:col-span-3">
          <PortfolioHealthWidget />
        </div>
      </div>

      {/* Priority alert banner — urgent products overdue for a changelog update */}
      <AnimatePresence>
        {criticalStale.length > 0 && !staleBannerDismissed && (
          <motion.div
            initial={{ opacity: 0, y: -8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -8, height: 0 }}
            className="overflow-hidden"
          >
            <div className="relative flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4 pr-10">
              <span className="absolute left-0 top-0 h-full w-1 rounded-l-xl bg-red-500" />
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-500/15 text-red-500">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                  {criticalStale.length} product{criticalStale.length > 1 ? 's' : ''} urgently need updating
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  No changelog activity in {staleDays}+ days
                  {criticalStale.length <= 3 && <>: <span className="font-medium text-foreground">{criticalStale.map((c) => c.name).join(', ')}</span></>}.
                  Review them in <span className="font-medium text-foreground">Needs Updating</span> below.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setStaleBannerDismissed(true)}
                className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-foreground"
                aria-label="Dismiss"
              >
                <span className="block text-lg leading-none">×</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Monthly Summary */}
      <motion.div 
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="grid gap-4 md:grid-cols-3 lg:grid-cols-6"
      >
        <motion.div variants={staggerItem} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="h-full">
          <Card className="h-full flex flex-col">
            <CardHeader className="flex flex-row items-start justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Products Updated</CardTitle>
              <Package className="w-4 h-4 text-primary/70 shrink-0 mt-0.5" />
            </CardHeader>
            <CardContent className="mt-auto">
              <div className="text-2xl font-bold">{summary.products}</div>
              <p className="text-xs text-muted-foreground">This month</p>
            </CardContent>
          </Card>
        </motion.div>
        
        <motion.div variants={staggerItem} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="h-full">
          <Card className="h-full flex flex-col">
            <CardHeader className="flex flex-row items-start justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Features Delivered</CardTitle>
              <PlusCircle className="w-4 h-4 text-emerald-500/70 shrink-0 mt-0.5" />
            </CardHeader>
            <CardContent className="mt-auto">
              <div className="text-2xl font-bold">{summary.features}</div>
              <p className="text-xs text-muted-foreground">This month</p>
            </CardContent>
          </Card>
        </motion.div>
        
        <motion.div variants={staggerItem} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="h-full">
          <Card className="h-full flex flex-col">
            <CardHeader className="flex flex-row items-start justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Improvements Made</CardTitle>
              <Wrench className="w-4 h-4 text-blue-500/70 shrink-0 mt-0.5" />
            </CardHeader>
            <CardContent className="mt-auto">
              <div className="text-2xl font-bold">{summary.improvements}</div>
              <p className="text-xs text-muted-foreground">This month</p>
            </CardContent>
          </Card>
        </motion.div>
        
        <motion.div variants={staggerItem} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="h-full">
          <Card className="h-full flex flex-col">
            <CardHeader className="flex flex-row items-start justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Bug Fixes Resolved</CardTitle>
              <Bug className="w-4 h-4 text-red-500/70 shrink-0 mt-0.5" />
            </CardHeader>
            <CardContent className="mt-auto">
              <div className="text-2xl font-bold">{summary.bugFixes}</div>
              <p className="text-xs text-muted-foreground">This month</p>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div variants={staggerItem} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="h-full">
          <Card className="h-full flex flex-col">
            <CardHeader className="flex flex-row items-start justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Released</CardTitle>
              <div className="w-4 h-4 rounded-full bg-green-500/20 flex items-center justify-center shrink-0 mt-0.5">
                <div className="w-2 h-2 rounded-full bg-green-500" />
              </div>
            </CardHeader>
            <CardContent className="mt-auto">
              <div className="text-2xl font-bold">{totalReleased}</div>
              <p className="text-xs text-muted-foreground">All time</p>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div variants={staggerItem} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="h-full">
          <Card className="h-full flex flex-col">
            <CardHeader className="flex flex-row items-start justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium">Unreleased</CardTitle>
              <div className="w-4 h-4 rounded-full bg-slate-500/20 flex items-center justify-center shrink-0 mt-0.5">
                <div className="w-2 h-2 rounded-full bg-slate-500" />
              </div>
            </CardHeader>
            <CardContent className="mt-auto">
              <div className="text-2xl font-bold">{totalUnreleased}</div>
              <p className="text-xs text-muted-foreground">All time</p>
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>

      {/* Action Center — triage open issues, ship unreleased work, assign versions, refresh stale products */}
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        {/* Open Issues */}
        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
            <div className="space-y-1">
              <CardTitle className="flex items-center text-base">
                <AlertTriangle className="w-5 h-5 mr-2 text-amber-500" /> Open Issues
              </CardTitle>
              <CardDescription>
                {isIssuesLoading
                  ? 'Loading issues…'
                  : openIssues.length === 0
                    ? 'No open issues — nicely done.'
                    : `${openIssues.length} open${criticalCount > 0 ? ` · ${criticalCount} critical` : ''} across your products.`}
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setQuickIssueOpen(true)} disabled={allProducts.length === 0}>
              <Bug className="w-4 h-4 mr-1.5" /> Report
            </Button>
          </CardHeader>
          <CardContent className="flex-1">
            {isIssuesLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 rounded-lg bg-muted/50 animate-pulse" />)}
              </div>
            ) : openIssues.length === 0 ? (
              
              <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                <CircleCheck className="w-8 h-8 mb-2 text-emerald-500" />
                <p className="text-sm">All clear. Nothing needs attention right now.</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {openIssues.slice(0, 5).map((issue) => (
                  <Link
                    key={issue._id}
                    to={`/products/${productIdOf(issue.productId)}?tab=issues&issue=${issue._id}`}
                    className="flex items-center gap-2.5 rounded-lg border border-border bg-card/50 px-3 py-2 transition-colors hover:bg-muted/50"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${SEVERITY_DOT[issue.severity] || 'bg-muted-foreground'}`} title={`${issue.severity} severity`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate leading-tight">{issue.title}</p>
                      <p className="text-xs text-muted-foreground truncate">{productNameOf(issue.productId)}</p>
                    </div>
                    {issue.status === 'in-progress' && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">In Progress</Badge>
                    )}
                  </Link>
                ))}
                {openIssues.length > 5 && (
                  <p className="text-xs text-muted-foreground text-center pt-1">+{openIssues.length - 5} more open</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pending Release */}
        <Card className="flex flex-col">
          <CardHeader className="space-y-1">
            <CardTitle className="flex items-center text-base">
              <Rocket className="w-5 h-5 mr-2 text-primary" /> Pending Release
            </CardTitle>
            <CardDescription>
              {pendingByProduct.length === 0
                ? 'Everything is released — nothing pending.'
                : `${totalUnreleased + totalUnreleasedVersions} unreleased ${totalUnreleased + totalUnreleasedVersions === 1 ? 'item' : 'items'} waiting to ship across ${pendingByProduct.length} ${pendingByProduct.length === 1 ? 'product' : 'products'}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            {pendingByProduct.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                <CircleCheck className="w-8 h-8 mb-2 text-emerald-500" />
                <p className="text-sm">No unreleased changes. You're all shipped.</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {pendingByProduct.slice(0, 5).map((p) => (
                  <div key={p.id} className="rounded-lg border border-border bg-card/50 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium truncate leading-tight">{p.name}</p>
                      <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-none text-[10px] uppercase tracking-wider shrink-0">Unreleased</Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      {p.entries > 0 && (
                        <Link
                          to={`/activities?productId=${p.id}&tag=unreleased`}
                          className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                          title="View these unreleased changelog entries"
                        >
                          {p.entries} {p.entries === 1 ? 'entry' : 'entries'} <ArrowRight className="w-3 h-3" />
                        </Link>
                      )}
                      {p.versions > 0 && (
                        <Link
                          to={`/products/${p.id}?tab=versions&versionStatus=unreleased`}
                          className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                          title={p.versionLabels.length ? p.versionLabels.join(', ') : 'View unreleased versions'}
                        >
                          {p.versions} {p.versions === 1 ? 'version' : 'versions'} <ArrowRight className="w-3 h-3" />
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
                {pendingByProduct.length > 5 && (
                  <p className="text-xs text-muted-foreground text-center pt-1">+{pendingByProduct.length - 5} more products</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Unversioned changelog entries */}
        <Card className="flex flex-col">
          <CardHeader className="space-y-1">
            <CardTitle className="flex items-center text-base">
              <Tag className="w-5 h-5 mr-2 text-primary" /> Unversioned Entries
            </CardTitle>
            <CardDescription>
              {unversionedActs.length === 0
                ? 'Every changelog entry is assigned to a version.'
                : `${unversionedActs.length} changelog ${unversionedActs.length === 1 ? 'entry has' : 'entries have'} no version yet.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            {unversionedActs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                <CircleCheck className="w-8 h-8 mb-2 text-emerald-500" />
                <p className="text-sm">All entries are versioned.</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {unversionedActs.slice(0, 5).map((act: any) => {
                  const pid = String(act.productId?._id || act.productId);
                  const prodVersions = versionsByProduct[pid] || [];
                  const busy = assigningId === act._id;
                  return (
                    <div key={act._id} className="flex items-center gap-2.5 rounded-lg border border-border bg-card/50 px-3 py-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${TYPE_DOT[act.type] || 'bg-muted-foreground'}`} />
                      <div className="min-w-0 flex-1">
                        <Link
                          to={`/products/${pid}#activity-${act._id}`}
                          className="block text-sm font-medium truncate leading-tight hover:text-primary hover:underline"
                          title="Open in the Activity Timeline"
                        >
                          {act.title}
                        </Link>
                        <p className="text-xs text-muted-foreground truncate">{act.productId?.name || productNameOf(act.productId)}</p>
                      </div>
                      {prodVersions.length === 0 ? (
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs shrink-0" asChild title="This product has no versions yet">
                          <Link to={`/products/${pid}?tab=versions`}>Add version</Link>
                        </Button>
                      ) : (
                        <Select
                          disabled={busy}
                          onValueChange={(versionId) => assignVersion.mutate({ id: act._id, productId: pid, versionId })}
                        >
                          <SelectTrigger className="h-7 w-[136px] text-xs shrink-0" aria-label={`Assign a version to ${act.title}`}>
                            <SelectValue placeholder={busy ? 'Assigning…' : 'Assign version'} />
                          </SelectTrigger>
                          <SelectContent>
                            {prodVersions.map((v) => (
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
                      )}
                    </div>
                  );
                })}
                {unversionedActs.length > 5 && (
                  <Button variant="ghost" size="sm" className="w-full mt-1" asChild>
                    <Link to="/activities?versioned=none">View all {unversionedActs.length} unversioned <ArrowRight className="w-4 h-4 ml-1.5" /></Link>
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Needs Updating — products with no changelog in the configured window */}
        <Card className="flex flex-col">
          <CardHeader className="space-y-1">
            <CardTitle className="flex items-center text-base">
              <Clock className="w-5 h-5 mr-2 text-amber-500" /> Needs Updating
            </CardTitle>
            <CardDescription>
              {isStaleLoading
                ? 'Checking for stale products…'
                : staleProducts.length === 0
                  ? `All products updated within ${staleDays} days.`
                  : `${staleProducts.length} not updated in ${staleDays}+ days.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            {isStaleLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 rounded-lg bg-muted/50 animate-pulse" />)}
              </div>
            ) : staleProducts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                <CircleCheck className="w-8 h-8 mb-2 text-emerald-500" />
                <p className="text-sm">Everything's fresh — no products need attention.</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {staleProducts.slice(0, 5).map((p) => (
                  <Link
                    key={p._id}
                    to={`/products/${p._id}?tab=activities`}
                    className="flex items-center gap-2.5 rounded-lg border border-border bg-card/50 px-3 py-2 transition-colors hover:bg-muted/50"
                    title="Open the changelog to add an update"
                  >
                    {p.icon
                      ? <img src={p.icon} alt="" className="w-7 h-7 rounded-md object-cover bg-muted shrink-0" />
                      : <div className="w-7 h-7 rounded-md bg-muted shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate leading-tight">{p.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {p.lastActivityAt
                          ? `Updated ${formatDistanceToNow(new Date(p.lastActivityAt), { addSuffix: true })}`
                          : 'No changelog yet'}
                      </p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  </Link>
                ))}
                {staleProducts.length > 5 && (
                  <p className="text-xs text-muted-foreground text-center pt-1">+{staleProducts.length - 5} more</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-7 lg:grid-cols-7">

        {/* Left Column (Span 4) */}
        <div className="md:col-span-4 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center"><ActivityIcon className="w-5 h-5 mr-2 text-primary" /> Activity Trend</CardTitle>
              <CardDescription>Activity breakdown over the last 6 months.</CardDescription>
            </CardHeader>
            <CardContent>
              <TrendChart data={trendData || []} />
            </CardContent>
          </Card>

          <Card className="flex flex-col h-full max-h-[480px]">
            <CardHeader>
              <CardTitle className="flex items-center"><ActivityIcon className="w-5 h-5 mr-2 text-primary" /> Recent Activity Feed</CardTitle>
              <CardDescription>The latest updates tracked across all products.</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto pr-4 custom-scrollbar">
              <div className="space-y-4">
                {recentActivities.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">No activities logged yet.</p>
                ) : (
                  recentActivities.map((log: any) => (
                    <Link 
                      key={log._id} 
                      to={getLogLink(log)} 
                      className={`flex items-start gap-4 p-3 rounded-lg border bg-card/50 transition-colors ${log.action !== 'DELETE' ? 'hover:bg-muted/50 cursor-pointer' : 'cursor-default'} block`}
                      onClick={(e) => log.action === 'DELETE' && e.preventDefault()}
                    >
                      <div className="mt-0.5">
                        {log.action === 'CREATE' && <div className="p-2 bg-emerald-500/10 text-emerald-500 rounded-full"><PlusCircle className="w-4 h-4" /></div>}
                        {log.action === 'UPDATE' && <div className="p-2 bg-blue-500/10 text-blue-500 rounded-full"><Wrench className="w-4 h-4" /></div>}
                        {log.action === 'DELETE' && <div className="p-2 bg-red-500/10 text-red-500 rounded-full"><Bug className="w-4 h-4" /></div>}
                      </div>
                      <div className="flex-1 space-y-1">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                          <p className="text-sm font-medium leading-tight">{log.details || `${log.action} ${log.entityType}`}</p>
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                            {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                          </span>
                        </div>
                        <div className="flex items-center text-xs text-muted-foreground pt-1 flex-wrap gap-y-1">
                          <span className="font-medium text-foreground/80">
                            {log.entityName}
                            {getProductNameForLog(log) && <span className="font-normal text-muted-foreground ml-1">({getProductNameForLog(log)})</span>}
                          </span>
                          <span className="mx-2">•</span>
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 border capitalize`}>
                            {log.entityType.toLowerCase()}
                          </Badge>
                          <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ml-2 uppercase ${log.action === 'CREATE' ? 'text-emerald-500' : log.action === 'DELETE' ? 'text-red-500' : 'text-blue-500'}`}>
                            {log.action}
                          </Badge>
                        </div>
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column (Span 3) */}
        <div className="md:col-span-3 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center"><Package className="w-5 h-5 mr-2 text-primary" /> Product Landscape</CardTitle>
              <CardDescription>Overview of your portfolio.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <p className="text-4xl font-bold text-primary">{allProducts.length}</p>
                    <p className="text-sm text-muted-foreground font-medium uppercase tracking-wider">Total Products</p>
                  </div>
                  <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center text-primary border border-primary/20">
                    <Package className="h-7 w-7" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div className="space-y-2 p-3 rounded-lg border bg-card/50">
                    <div className="flex items-center text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <Play className="w-3.5 h-3.5 mr-1.5 text-emerald-500" /> Active
                    </div>
                    <p className="text-2xl font-semibold">{activeProducts.length}</p>
                  </div>
                  <div className="space-y-2 p-3 rounded-lg border bg-card/50">
                    <div className="flex items-center text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <ServerOff className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" /> Inactive
                    </div>
                    <p className="text-2xl font-semibold">{inactiveProducts.length}</p>
                  </div>
                  <div className="space-y-2 p-3 rounded-lg border bg-card/50">
                    <div className="flex items-center text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <Puzzle className="w-3.5 h-3.5 mr-1.5 text-purple-500" /> Plugins
                    </div>
                    <p className="text-2xl font-semibold">{plugins.length}</p>
                  </div>
                  <div className="space-y-2 p-3 rounded-lg border bg-card/50">
                    <div className="flex items-center text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <LayoutGrid className="w-3.5 h-3.5 mr-1.5 text-orange-500" /> Blocks
                    </div>
                    <p className="text-2xl font-semibold">{blocks.length}</p>
                  </div>
                </div>
                
                <Button variant="ghost" className="w-full text-sm mt-2" asChild>
                  <Link to="/products">View All Products <ArrowRight className="w-4 h-4 ml-2" /></Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base font-semibold">Activity Distribution</CardTitle>
              <CardDescription>All-time breakdown of activity types.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-5">
                <div className="flex h-4 w-full rounded-full overflow-hidden border border-border">
                  {totalFeatures > 0 && <div className="bg-emerald-500 h-full" style={{ width: `${featurePct}%` }} title={`Features: ${featurePct}%`} />}
                  {totalImprovements > 0 && <div className="bg-blue-500 h-full" style={{ width: `${improvePct}%` }} title={`Improvements: ${improvePct}%`} />}
                  {totalBugs > 0 && <div className="bg-red-500 h-full" style={{ width: `${bugPct}%` }} title={`Bug Fixes: ${bugPct}%`} />}
                  {grandTotal === 0 && <div className="bg-muted h-full w-full" />}
                </div>
                
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="space-y-1">
                    <div className="flex items-center justify-center text-emerald-500 font-medium">
                      <PlusCircle className="w-3.5 h-3.5 mr-1" /> {featurePct}%
                    </div>
                    <div className="text-muted-foreground">Features</div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-center text-blue-500 font-medium">
                      <Wrench className="w-3.5 h-3.5 mr-1" /> {improvePct}%
                    </div>
                    <div className="text-muted-foreground">Improvements</div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-center text-red-500 font-medium">
                      <Bug className="w-3.5 h-3.5 mr-1" /> {bugPct}%
                    </div>
                    <div className="text-muted-foreground">Bug Fixes</div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <QuickIssueDialog
        open={quickIssueOpen}
        onOpenChange={setQuickIssueOpen}
        products={allProducts}
      />
    </PageTransition>
  );
}
