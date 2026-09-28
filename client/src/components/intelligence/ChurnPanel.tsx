import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Compass, MessageSquareQuote, Minus, PlugZap,
  RefreshCw, Swords, TrendingDown, TrendingUp, Wrench,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useChurn, useSyncChurn } from '../../hooks/useIntelligence';
import type {
  ChurnBucket, ChurnSummary, ReasonBreakdown, VersionChurn,
} from '../../services/intelligence';

/**
 * Why users leave — framed as what to do about it.
 *
 * A ranked list of reasons only restates the data. What a maintainer needs to
 * know is which departures they can act on, whether it is getting worse, and
 * which release it started with. So the reasons are rolled into response
 * buckets, split by version, and tracked over time.
 *
 * Every figure comes from the server aggregation; this file derives nothing but
 * layout. The recommendations are deterministic templates keyed on those counts,
 * never generated prose — an invented number here would be indistinguishable
 * from a real one.
 */

const BUCKET_META: Record<ChurnBucket, {
  label: string; blurb: string; icon: typeof Wrench; tone: string; ring: string; actionable: boolean;
}> = {
  product: {
    label: 'Product problem',
    blurb: 'It broke, never worked, or they could not work it out',
    icon: AlertTriangle,
    tone: 'text-red-600 dark:text-red-400',
    ring: 'border-red-200 bg-red-50/60 dark:border-red-900/50 dark:bg-red-950/20',
    actionable: true,
  },
  positioning: {
    label: 'Expectation gap',
    blurb: 'It worked, but it was not what the listing promised',
    icon: Compass,
    tone: 'text-amber-600 dark:text-amber-400',
    ring: 'border-amber-200 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20',
    actionable: true,
  },
  competitive: {
    label: 'Lost to a rival',
    blurb: 'They found something they preferred',
    icon: Swords,
    tone: 'text-violet-600 dark:text-violet-400',
    ring: 'border-violet-200 bg-violet-50/60 dark:border-violet-900/50 dark:bg-violet-950/20',
    actionable: true,
  },
  unactionable: {
    label: 'Not about the product',
    blurb: 'No longer needed, temporary, or billing — no verdict on the plugin',
    icon: Minus,
    tone: 'text-slate-500 dark:text-slate-400',
    ring: 'border-border bg-muted/40',
    actionable: false,
  },
};

const pct = (n: number) => `${n}%`;

/** A deterministic next step, derived only from counts the server computed. */
interface Action {
  key: string;
  priority: 'high' | 'medium';
  title: string;
  why: string;
  to?: { label: string; href: string };
}

function buildActions(summary: ChurnSummary, productId: string): Action[] {
  const actions: Action[] = [];
  const by = (b: ChurnBucket) => summary.buckets.find((x) => x.bucket === b);

  const product = by('product');
  if (product && product.count > 0) {
    const worst = summary.byVersion
      .filter((v) => v.productFailures > 0)
      .sort((a, b) => b.productFailures - a.productFailures)[0];
    actions.push({
      key: 'product',
      priority: product.share >= 25 ? 'high' : 'medium',
      title: `Fix what ${product.count} ${product.count === 1 ? 'person' : 'people'} hit`,
      why:
        `${product.count} of ${summary.total} reports (${pct(product.share)}) blamed the product itself — ` +
        `${product.reasons.map((r) => `${r.reason} (${r.count})`).join(', ')}.` +
        (worst ? ` Most came from v${worst.version}.` : '') +
        ' They left instead of filing an issue, so this will not show in the tracker.',
      to: { label: 'Open issues', href: `/products/${productId}?tab=issues` },
    });
  }

  const positioning = by('positioning');
  if (positioning && positioning.count > 0) {
    actions.push({
      key: 'positioning',
      priority: positioning.share >= 25 ? 'high' : 'medium',
      title: 'Close the gap between the listing and the first run',
      why:
        `${positioning.count} of ${summary.total} reports (${pct(positioning.share)}) said it was not what ` +
        'they expected. These users chose to install, so the cost is in the store page or onboarding, ' +
        'not in discovery.',
      to: { label: 'Marketing Hub', href: `/products/${productId}?tab=marketing` },
    });
  }

  const competitive = by('competitive');
  if (competitive && competitive.count > 0) {
    actions.push({
      key: 'competitive',
      priority: 'medium',
      title: `Find out who ${competitive.count === 1 ? 'they' : 'they'} switched to`,
      why:
        `${competitive.count} report${competitive.count === 1 ? '' : 's'} named a better alternative. ` +
        'Where they wrote it down, the name is in their notes below — those are competitors worth tracking.',
    });
  }

  if (summary.withText > 0) {
    actions.push({
      key: 'read',
      priority: 'medium',
      title: `Read the ${summary.withText} written note${summary.withText === 1 ? '' : 's'}`,
      why:
        'Free text is the only place a specific cause appears. A single note naming a format or a ' +
        'conflict is usually worth more than the whole distribution above.',
    });
  }
  return actions;
}

function StatTile({
  label, value, hint, icon: Icon, tone,
}: { label: string; value: string; hint?: string; icon: typeof Wrench; tone?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className={cn('h-3.5 w-3.5', tone)} />
        {label}
      </div>
      <div className="mt-2 text-3xl font-bold tabular-nums text-foreground">{value}</div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The addressable split. Two segments of one bar, separated by a 2px surface
 * gap rather than a border, each direct-labelled — so the ratio is readable
 * without a legend.
 */
function AddressableBar({ summary }: { summary: ChurnSummary }) {
  const actionable = summary.buckets
    .filter((b) => BUCKET_META[b.bucket].actionable)
    .reduce((s, b) => s + b.count, 0);
  const share = summary.total > 0 ? Math.round((actionable / summary.total) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {share > 0
            ? `${pct(share)} of these departures are something you can act on`
            : 'None of these departures point at the product'}
        </CardTitle>
        <CardDescription>
          {actionable} of {summary.total} reports blamed the product, the listing, or a rival. The rest
          left for reasons that carry no verdict on it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-sm">
          {summary.buckets.map((b) => {
            const meta = BUCKET_META[b.bucket];
            return (
              <div
                key={b.bucket}
                title={`${meta.label}: ${b.count} (${pct(b.share)})`}
                style={{ width: `${Math.max(b.share, 1)}%` }}
                className={cn(
                  'h-full first:rounded-l-sm last:rounded-r-sm',
                  meta.actionable ? 'bg-primary/80' : 'bg-muted-foreground/25',
                )}
              />
            );
          })}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {summary.buckets.map((b) => {
            const meta = BUCKET_META[b.bucket];
            return (
              <div key={b.bucket} className={cn('rounded-lg border p-3', meta.ring)}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <meta.icon className={cn('h-4 w-4 shrink-0', meta.tone)} aria-hidden />
                    <span className="truncate text-sm font-semibold text-foreground">{meta.label}</span>
                  </div>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                    <span className="font-semibold text-foreground">{b.count}</span> · {pct(b.share)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{meta.blurb}</p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/** Which release users were on when they left. Failures are the emphasised part. */
function ByVersion({ rows, total }: { rows: VersionChurn[]; total: number }) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.count));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Which version they were on</CardTitle>
        <CardDescription>
          A release carrying more failures than its neighbours is where to look first. Bars show all
          reports; the darker part is the share that blamed the product.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {rows.map((r) => {
          const width = max > 0 ? Math.max((r.count / max) * 100, 2) : 0;
          const failShare = r.count > 0 ? (r.productFailures / r.count) * 100 : 0;
          return (
            <div
              key={r.version}
              title={`v${r.version}: ${r.count} report(s), ${r.productFailures} blamed the product`}
            >
              <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                <span className="font-mono text-foreground">v{r.version}</span>
                <span className="tabular-nums text-muted-foreground">
                  <span className="font-semibold text-foreground">{r.count}</span>
                  {r.productFailures > 0 && (
                    <span className="ml-2 text-red-600 dark:text-red-400">{r.productFailures} failed</span>
                  )}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-sm bg-muted/60">
                <div className="flex h-full gap-[2px] rounded-r-[4px]" style={{ width: `${width}%` }}>
                  <div className="h-full bg-red-500/80" style={{ width: `${failShare}%` }} />
                  <div className="h-full flex-1 bg-primary/40" />
                </div>
              </div>
            </div>
          );
        })}
        <p className="pt-1 text-xs text-muted-foreground">
          Based on {total} report{total === 1 ? '' : 's'}; reports with no recorded version are omitted.
        </p>
      </CardContent>
    </Card>
  );
}

/** Monthly columns. Few points, so columns rather than a line — no false continuity. */
function Trend({ points }: { points: ChurnSummary['trend'] }) {
  if (points.length < 2) return null;
  const max = Math.max(...points.map((p) => p.total));
  const first = points[0];
  const last = points[points.length - 1];
  const direction = last.total === first.total ? 'flat' : last.total > first.total ? 'up' : 'down';
  const Icon = direction === 'up' ? TrendingUp : direction === 'down' ? TrendingDown : Minus;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon
            className={cn('h-4 w-4', direction === 'up'
              ? 'text-red-600 dark:text-red-400'
              : direction === 'down' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}
            aria-hidden
          />
          Reports per month
        </CardTitle>
        <CardDescription>
          {direction === 'flat'
            ? 'Flat across the window.'
            : `${direction === 'up' ? 'Rising' : 'Falling'} — ${first.total} in ${first.month}, ${last.total} in ${last.month}.`}{' '}
          The darker part of each column blamed the product.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex h-28 items-end gap-1.5">
          {points.map((p) => {
            const h = max > 0 ? Math.max((p.total / max) * 100, 4) : 0;
            const failH = p.total > 0 ? (p.productFailures / p.total) * 100 : 0;
            return (
              <div key={p.month} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[10px] tabular-nums text-muted-foreground">{p.total}</span>
                <div
                  className="flex w-full flex-col justify-end overflow-hidden rounded-t-[4px] bg-primary/30"
                  style={{ height: `${h}%` }}
                  title={`${p.month}: ${p.total} report(s), ${p.productFailures} blamed the product`}
                >
                  <div className="w-full bg-red-500/80" style={{ height: `${failH}%` }} />
                </div>
                <span className="text-[10px] text-muted-foreground">{p.month.slice(5)}</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ReasonRow({ row, max }: { row: ReasonBreakdown; max: number }) {
  const width = max > 0 ? Math.max((row.count / max) * 100, 2) : 0;
  return (
    <div className="group py-2" title={`${row.reason}: ${row.count} (${pct(row.share)})`}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="truncate text-sm text-foreground">{row.reason}</span>
        <div className="shrink-0 text-sm tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">{row.count}</span>
          <span className="ml-1.5">{pct(row.share)}</span>
        </div>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-sm bg-muted/60">
        <div
          className="h-full rounded-r-[4px] bg-primary/70 transition-all group-hover:bg-primary"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function Quotes({ summary }: { summary: ChurnSummary }) {
  const [expanded, setExpanded] = useState(false);
  if (summary.quotes.length === 0) return null;
  const shown = expanded ? summary.quotes : summary.quotes.slice(0, 6);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquareQuote className="h-4 w-4 text-muted-foreground" />
          What they wrote
        </CardTitle>
        <CardDescription>
          The only place a specific cause appears — {summary.withText} of {summary.total} reports included
          a note. Shown exactly as typed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {shown.map((q, i) => (
          <figure key={`${q.uninstalledAt}-${i}`} className="rounded-lg border bg-muted/30 p-3">
            <blockquote className="text-sm leading-relaxed text-foreground">“{q.text}”</blockquote>
            <figcaption className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="font-medium">{q.reason}</span>
              <span aria-hidden>·</span>
              <time dateTime={q.uninstalledAt}>{new Date(q.uninstalledAt).toLocaleDateString()}</time>
              {q.version && (<><span aria-hidden>·</span><span className="font-mono">v{q.version}</span></>)}
            </figcaption>
          </figure>
        ))}
        {summary.quotes.length > 6 && (
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show fewer' : `Show all ${summary.quotes.length}`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function NotConnected() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <PlugZap className="h-8 w-8 text-muted-foreground" />
        <div>
          <h3 className="font-semibold text-foreground">Not connected to Freemius</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Set this product's <span className="font-mono">Freemius product ID</span> in its settings, and
            supply the API keys through the <span className="font-mono">FREEMIUS_*</span> environment
            variables.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function ChurnPanel({ productId }: { productId: string }) {
  const [windowDays, setWindowDays] = useState(90);
  const { data, isLoading } = useChurn(productId, windowDays);
  const sync = useSyncChurn(productId);

  const runSync = () => {
    sync.mutate(undefined, {
      onSuccess: (r) => {
        if (r.errors.length) toast.error(r.errors[0]);
        else if (r.stored > 0) toast.success(`Pulled ${r.stored} new uninstall reason${r.stored === 1 ? '' : 's'}.`);
        else toast.info(`No new reasons — ${r.examined} uninstall(s) checked, ${r.withoutFeedback} gave none.`);
      },
      onError: (e: unknown) => {
        const message = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
        toast.error(message || 'Could not reach Freemius.');
      },
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl border bg-muted/40" />)}
        </div>
        <div className="h-64 animate-pulse rounded-xl border bg-muted/40" />
      </div>
    );
  }
  if (!data) return null;
  if (!data.connected && data.totalAllTime === 0) return <NotConnected />;

  const productBucket = data.buckets.find((b) => b.bucket === 'product');
  const failureShare = productBucket?.share ?? 0;
  const max = data.breakdown[0]?.count ?? 0;
  const actions = buildActions(data, productId);
  // Under this, one person's opinion would read as a pattern.
  const thin = data.total > 0 && data.total < 8;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Why users leave</h2>
          <p className="text-sm text-muted-foreground">
            Reasons given to Freemius when uninstalling.{' '}
            {data.lastReportAt
              ? `Most recent ${new Date(data.lastReportAt).toLocaleDateString()}.`
              : 'No reports stored yet.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(windowDays)} onValueChange={(v) => setWindowDays(Number(v))}>
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
              <SelectItem value="180">Last 6 months</SelectItem>
              <SelectItem value="365">Last year</SelectItem>
            </SelectContent>
          </Select>
          {data.connected && (
            <Button variant="outline" size="sm" onClick={runSync} disabled={sync.isPending} className="gap-1.5">
              <RefreshCw className={cn('h-4 w-4', sync.isPending && 'animate-spin')} />
              {sync.isPending ? 'Pulling…' : 'Pull latest'}
            </Button>
          )}
        </div>
      </div>

      {thin && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-muted-foreground">
            Only {data.total} report{data.total === 1 ? '' : 's'} in this window — too few to read a share
            as a pattern. Only new uninstalls are collected, so history needs a backfill; try a longer
            window meanwhile.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Reasons given" value={String(data.total)} icon={MessageSquareQuote}
          hint={`in the last ${data.windowDays} days`} />
        <StatTile label="Blamed the product" value={data.total > 0 ? pct(failureShare) : '—'}
          icon={AlertTriangle} tone={BUCKET_META.product.tone}
          hint={data.total > 0 ? `${productBucket?.count ?? 0} of ${data.total} reports` : 'no reports in window'} />
        <StatTile label="Wrote a note" value={String(data.withText)} icon={MessageSquareQuote}
          hint={data.total > 0 ? `${Math.round((data.withText / data.total) * 100)}% of reports` : undefined} />
        <StatTile label="Stored all time" value={String(data.totalAllTime)} icon={PlugZap}
          hint="only new uninstalls are collected" />
      </div>

      {data.total === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No uninstall reasons recorded in the last {data.windowDays} days.
            {data.totalAllTime > 0 && ' Try a longer window.'}
            {data.connected && ' New reports arrive on the six-hourly sync, or use “Pull latest”.'}
          </CardContent>
        </Card>
      ) : (
        <>
          <AddressableBar summary={data} />

          {actions.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wrench className="h-4 w-4 text-muted-foreground" />
                  What to do about it
                </CardTitle>
                <CardDescription>
                  Derived from the counts above — each line states the number it rests on.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {actions.map((a) => (
                  <div key={a.key} className="rounded-lg border bg-muted/20 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <h4 className="text-sm font-semibold text-foreground">{a.title}</h4>
                      <span className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                        a.priority === 'high'
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                          : 'bg-muted text-muted-foreground',
                      )}>
                        {a.priority}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{a.why}</p>
                    {a.to && (
                      <Link
                        to={a.to.href}
                        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        {a.to.label} <ArrowRight className="h-3 w-3" />
                      </Link>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <ByVersion rows={data.byVersion} total={data.total} />
            <Trend points={data.trend} />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Every reason, most common first</CardTitle>
              <CardDescription>
                Share is of the {data.total} report{data.total === 1 ? '' : 's'} in this window. Roughly half
                of uninstalls leave no reason at all, so this is not a count of everyone who left.
              </CardDescription>
            </CardHeader>
            <CardContent className="divide-y divide-border/60">
              {data.breakdown.map((row) => <ReasonRow key={row.reasonId} row={row} max={max} />)}
            </CardContent>
          </Card>
        </>
      )}

      <Quotes summary={data} />
    </div>
  );
}
