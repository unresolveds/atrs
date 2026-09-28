import { useState } from 'react';
import {
  AlertTriangle, Compass, MessageSquareQuote, PlugZap, RefreshCw, Swords, UserMinus,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useChurn, useSyncChurn } from '../../hooks/useIntelligence';
import type { ChurnSummary, ReasonBreakdown } from '../../services/intelligence';

/**
 * Why users left, in their own words.
 *
 * Every number here is counted server-side from stored Freemius reports — the
 * component derives nothing, so what it shows and what the churn detectors act
 * on cannot disagree. Free text is printed verbatim and never summarised.
 *
 * The bars are one hue on purpose: they compare magnitude of a single measure
 * (how many people chose each reason), so the reason's identity is already
 * carried by its label. Giving each bar its own colour would imply a categorical
 * encoding that doesn't exist and would bury the ranking, which is the point.
 */

/** Freemius reason ids grouped by what a team would do about them. Mirrors detectors/churn.ts. */
const GROUPS: Record<string, { ids: number[]; label: string; icon: typeof AlertTriangle; tone: string }> = {
  broken: {
    ids: [4, 5, 8, 12],
    label: 'It failed',
    icon: AlertTriangle,
    tone: 'text-red-600 dark:text-red-400',
  },
  expectation: {
    ids: [13, 14],
    label: 'Not what they expected',
    icon: Compass,
    tone: 'text-amber-600 dark:text-amber-400',
  },
  alternative: {
    ids: [2],
    label: 'Switched away',
    icon: Swords,
    tone: 'text-violet-600 dark:text-violet-400',
  },
  confusion: {
    ids: [10],
    label: "Couldn't work it out",
    icon: Compass,
    tone: 'text-sky-600 dark:text-sky-400',
  },
};

const groupOf = (reasonId: number) =>
  Object.entries(GROUPS).find(([, g]) => g.ids.includes(reasonId))?.[0] ?? null;

const pct = (n: number) => `${n}%`;

/** A headline number. No plot, so no hover layer — the figure is the content. */
function StatTile({
  label, value, hint, icon: Icon, tone,
}: { label: string; value: string; hint?: string; icon: typeof UserMinus; tone?: string }) {
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
 * One reason. The bar is <=24px thick with a 4px rounded data-end, square at the
 * baseline, and adjacent rows are separated by surface gap rather than a border.
 * The count is direct-labelled at the tip, so no axis or gridline is needed.
 */
function ReasonRow({ row, max }: { row: ReasonBreakdown; max: number }) {
  const group = groupOf(row.reasonId);
  const meta = group ? GROUPS[group] : null;
  // Scaled against the largest reason so the ranking is readable; the label
  // carries the true share, so the bar never has to be read as an absolute.
  const width = max > 0 ? Math.max((row.count / max) * 100, 2) : 0;

  return (
    <div
      className="group py-2"
      title={`${row.reason}: ${row.count} of the reports in this window (${pct(row.share)})${
        row.withText > 0 ? `, ${row.withText} with written detail` : ''
      }`}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {meta && <meta.icon className={cn('h-3.5 w-3.5 shrink-0', meta.tone)} aria-hidden />}
          <span className="truncate text-sm font-medium text-foreground">{row.reason}</span>
          {meta && (
            // Group identity as text, not colour alone.
            <span className="hidden shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:inline">
              {meta.label}
            </span>
          )}
        </div>
        <div className="shrink-0 text-sm tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">{row.count}</span>
          <span className="ml-1.5">{pct(row.share)}</span>
        </div>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-sm bg-muted/60">
        <div
          className="h-full rounded-r-[4px] bg-primary/80 transition-all group-hover:bg-primary"
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
          In their own words
        </CardTitle>
        <CardDescription>
          Written by users as they uninstalled, shown exactly as they typed it — {summary.withText} of{' '}
          {summary.total} reports included a note.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {shown.map((q, i) => {
          const meta = groupOf(q.reasonId) ? GROUPS[groupOf(q.reasonId)!] : null;
          return (
            <figure key={`${q.uninstalledAt}-${i}`} className="rounded-lg border bg-muted/30 p-3">
              <blockquote className="text-sm leading-relaxed text-foreground">“{q.text}”</blockquote>
              <figcaption className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {meta && <meta.icon className={cn('h-3 w-3', meta.tone)} aria-hidden />}
                <span className="font-medium">{q.reason}</span>
                <span aria-hidden>·</span>
                <time dateTime={q.uninstalledAt}>{new Date(q.uninstalledAt).toLocaleDateString()}</time>
                {q.version && (
                  <>
                    <span aria-hidden>·</span>
                    <span>v{q.version}</span>
                  </>
                )}
              </figcaption>
            </figure>
          );
        })}
        {summary.quotes.length > 6 && (
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show fewer' : `Show all ${summary.quotes.length}`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Shown when the product has no Freemius credentials resolved. */
function NotConnected() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <PlugZap className="h-8 w-8 text-muted-foreground" />
        <div>
          <h3 className="font-semibold text-foreground">Not connected to Freemius</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Uninstall reasons come from this product's Freemius account. Set its{' '}
            <span className="font-mono">Freemius product ID</span> in the product settings, and supply the
            API keys through the <span className="font-mono">FREEMIUS_*</span> environment variables.
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

  const failure = data.breakdown
    .filter((b) => GROUPS.broken.ids.includes(b.reasonId))
    .reduce((s, b) => s + b.count, 0);
  const failureShare = data.total > 0 ? Math.round((failure / data.total) * 100) : 0;
  const max = data.breakdown[0]?.count ?? 0;

  return (
    <div className="space-y-4">
      {/* Controls sit in one row above the data, not inside it. */}
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Reasons given" value={String(data.total)} icon={UserMinus}
          hint={`in the last ${data.windowDays} days`}
        />
        <StatTile
          label="Because it failed" value={data.total > 0 ? pct(failureShare) : '—'}
          icon={AlertTriangle} tone={GROUPS.broken.tone}
          hint={data.total > 0 ? `${failure} of ${data.total} reports` : 'no reports in window'}
        />
        <StatTile
          label="Wrote a note" value={String(data.withText)} icon={MessageSquareQuote}
          hint={data.total > 0 ? `${Math.round((data.withText / data.total) * 100)}% of reports` : undefined}
        />
        <StatTile
          label="Stored all time" value={String(data.totalAllTime)} icon={PlugZap}
          hint="only new uninstalls are collected"
        />
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
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Reasons, most common first</CardTitle>
            <CardDescription>
              Share is of the {data.total} report{data.total === 1 ? '' : 's'} in this window. Roughly half of
              uninstalls leave no reason at all, so this is not a count of everyone who left.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y divide-border/60">
            {data.breakdown.map((row) => <ReasonRow key={row.reasonId} row={row} max={max} />)}
          </CardContent>
        </Card>
      )}

      <Quotes summary={data} />
    </div>
  );
}
