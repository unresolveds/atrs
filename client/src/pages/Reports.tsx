import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getMonthlyReport, getAnnualReport } from '../services/reports';
import { getProducts } from '../services/products';
import { getUsers } from '../services/users';
import { useAuth } from '../contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DatePicker } from '@/components/ui/DatePicker';
import { Package, PlusCircle, Wrench, Bug, Calendar as CalendarIcon, ChevronDown, Download, Tag, Presentation } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { RichText } from '@/components/ui/RichText';
import { htmlToPlainText } from '@/lib/richText';

import { useLocalStorage } from '../hooks/useLocalStorage';
import { useAllVersions } from '../hooks/useVersions';
import { VersionBadge } from '../components/versions/VersionBadge';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import pptxgen from 'pptxgenjs';
import { toast } from 'sonner';

import { useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import PageTransition from '../components/layout/PageTransition';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ReportsSkeleton } from '@/components/ui/skeletons';
import { MediaCarousel } from '@/components/ui/media-carousel';
import { AuthorAvatar } from '@/components/ui/AuthorAvatar';
import { PresentationMode } from '../components/reports/PresentationMode';
import { ACTIVITY_TYPES } from '../../../consts';

const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// --- Module-scope card components -------------------------------------------
// These live at module scope (not inside the Reports component) so they keep a
// stable identity across parent re-renders. Defining them inside the component
// body remounted them on every keystroke (e.g. typing in the year input),
// wiping their local expand/collapse state.

const ReportActivityCard = ({ act, forceExpanded }: { act: any; forceExpanded?: boolean }) => {
  const [isOpenLocal, setIsOpen] = useState(false);
  const isOpen = forceExpanded || isOpenLocal;
  return (
    <Card className="bg-card overflow-hidden">
      <CardHeader
        className="p-4 pb-2 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setIsOpen(!isOpenLocal)}
      >
        <div className="flex justify-between items-start">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base">{act.title}</CardTitle>
              {act.versionId?.label && (
                <Badge variant="outline" className="text-[10px] font-bold tracking-wider uppercase border-indigo-300 text-indigo-700 dark:border-indigo-700 dark:text-indigo-300">
                  {act.versionId.label}
                </Badge>
              )}
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <CalendarIcon className="w-3 h-3" />
                {new Date(act.activityDate).toLocaleDateString()}
              </div>
              {act.versionId?.author && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <AuthorAvatar author={act.versionId.author} className="w-4 h-4" />
                  {act.versionId.author}
                </div>
              )}
            </div>
          </div>
          <Button variant="ghost" size="icon" className="shrink-0 -mr-2 -mt-2" aria-label={isOpen ? 'Collapse' : 'Expand'}>
            <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <AnimatePresence>
        {isOpen && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden">
            <CardContent className="p-4 pt-2 space-y-3">
              {(() => {
                const urls = act.mediaUrls?.length ? act.mediaUrls : (act.mediaUrl ? [act.mediaUrl] : []);
                if (urls.length === 0) return null;
                return (
                  <div className="mb-4">
                    <MediaCarousel urls={urls} title={act.title} />
                  </div>
                );
              })()}
              <RichText html={act.shortDescription} className="text-sm text-muted-foreground" />

              {act.items && act.items.length > 0 && (
                <div className="mt-6 space-y-3 border-t pt-4">
                  <h5 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Included Items</h5>
                  {act.items.map((item: any, idx: number) => (
                    <div key={idx} className="bg-muted/20 border border-border/40 rounded-lg p-3">
                      {(() => {
                        const itemUrls = item.mediaUrls?.length ? item.mediaUrls : (item.mediaUrl ? [item.mediaUrl] : []);
                        if (itemUrls.length === 0) return null;
                        return (
                          <div className="mb-3">
                            <MediaCarousel urls={itemUrls} title={item.title} />
                          </div>
                        );
                      })()}
                      <h6 className="font-medium text-sm text-foreground">{item.title}</h6>
                      <RichText html={item.description} className="text-xs text-muted-foreground leading-relaxed mt-1" />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
};

const ReportActivitySection = ({ type, activities, forceExpanded }: { type: string; activities: any[]; forceExpanded?: boolean }) => {
  const typeActs = activities.filter((a: any) => a.type === type);
  if (typeActs.length === 0) return null;
  const titleColor = type === 'feature' ? 'text-blue-600' : type === 'improvement' ? 'text-purple-600' : 'text-red-600';
  return (
    <div className="space-y-3">
      <h4 className={`font-semibold capitalize flex items-center gap-2 ${titleColor}`}>
        {type.replace('-', ' ')} <Badge variant="secondary" className="ml-1">{typeActs.length}</Badge>
      </h4>
      <div className="grid gap-4 md:grid-cols-2 pl-6 border-l-2 ml-2 border-muted pb-1 mt-3">
        {typeActs.map((act: any) => (
          <ReportActivityCard key={act._id} act={act} forceExpanded={forceExpanded} />
        ))}
      </div>
    </div>
  );
};

const ProductReportCard = ({ pData, forceExpanded }: { pData: any; forceExpanded?: boolean }) => {
  const [expandedLocal, setExpanded] = useState(false);
  const expanded = forceExpanded || expandedLocal;
  const { product, activities, counts } = pData;
  return (
    <Card className="overflow-visible relative">
      <div className="sticky top-0 lg:top-[185px] z-20 p-4 flex items-center justify-between bg-card/95 backdrop-blur-md hover:bg-accent cursor-pointer transition-colors shadow-sm rounded-t-lg border-b" onClick={() => setExpanded(!expandedLocal)}>
        <div className="flex items-center gap-4">
          {product.icon ? <img src={product.icon} className="w-10 h-10 rounded bg-muted" /> : <div className="w-10 h-10 rounded bg-muted flex items-center justify-center text-xs">No Icon</div>}
          <div>
            <h3 className="font-semibold text-lg">{product.name}</h3>
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <Badge variant="outline" className="capitalize">{product.category}</Badge>
              {activities.length} activities
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="hidden sm:flex gap-4 text-sm">
            <div className="flex flex-col items-center"><span className="text-blue-500 font-bold">{counts.features}</span><span className="text-xs text-muted-foreground">Features</span></div>
            <div className="flex flex-col items-center"><span className="text-purple-500 font-bold">{counts.improvements}</span><span className="text-xs text-muted-foreground">Improvements</span></div>
            <div className="flex flex-col items-center"><span className="text-red-500 font-bold">{counts.bugFixes}</span><span className="text-xs text-muted-foreground">Bug Fixes</span></div>
          </div>
          <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden">
            <div className="border-t bg-muted/30 p-4 space-y-6">
              {ACTIVITY_TYPES.map(type => (
                <ReportActivitySection key={type} type={type} activities={activities} forceExpanded={forceExpanded} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
};

export default function Reports() {
  const currentDate = new Date();
  const { isAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState<'monthly' | 'annual'>('monthly');

  // Monthly Report State
  const [month, setMonth] = useLocalStorage<string>('atrs_reports_month', (currentDate.getMonth() + 1).toString());
  const [year, setYear] = useLocalStorage<string>('atrs_reports_year', currentDate.getFullYear().toString());
  const [productId, setProductId] = useLocalStorage<string>('atrs_reports_productId', 'all');
  const [ownerId, setOwnerId] = useLocalStorage<string>('atrs_reports_ownerId', 'all');
  const [startDate, setStartDate] = useLocalStorage<string>('atrs_reports_startDate', '');
  const [endDate, setEndDate] = useLocalStorage<string>('atrs_reports_endDate', '');
  const [useCustomRange, setUseCustomRange] = useState(false);
  const [versionFilter, setVersionFilter] = useState<string>('all');
  // Single source: label→status across all products, so the (cross-product,
  // label-keyed) version filter can badge "Unreleased" options consistently.
  const { labelInfo } = useAllVersions();

  // Annual Report State
  const [annualYear, setAnnualYear] = useState(currentDate.getFullYear().toString());

  const [monthlyQueryArgs, setMonthlyQueryArgs] = useState({
    month: parseInt(month, 10),
    year: parseInt(year, 10),
    productId,
    ownerId,
    startDate: '',
    endDate: ''
  });

  const [annualQueryArgs, setAnnualQueryArgs] = useState({
    year: parseInt(annualYear, 10),
    productId,
    ownerId
  });

  // When true, all report cards render expanded (used while capturing the PDF).
  const [forceExpand, setForceExpand] = useState(false);

  // Presentation (townhall) mode: a full-screen slide deck of the monthly report.
  const [presenting, setPresenting] = useState(false);
  const monthMode = !monthlyQueryArgs.startDate; // month/year (not a custom range)
  const periodLabel = monthMode
    ? `${months[monthlyQueryArgs.month - 1]} ${monthlyQueryArgs.year}`
    : `${monthlyQueryArgs.startDate} – ${monthlyQueryArgs.endDate}`;

  // Don't let the presenter step past the current calendar month (no data there).
  const canNextMonth =
    monthMode &&
    (monthlyQueryArgs.year < currentDate.getFullYear() ||
      (monthlyQueryArgs.year === currentDate.getFullYear() && monthlyQueryArgs.month < currentDate.getMonth() + 1));

  // Shift the presented report by ±1 month (wrapping years). Also syncs the
  // toolbar's month/year so exiting the deck lands on the same period.
  const shiftMonth = (delta: number) => {
    const zeroBased = monthlyQueryArgs.month - 1 + delta;
    const newYear = monthlyQueryArgs.year + Math.floor(zeroBased / 12);
    const newMonth = ((zeroBased % 12) + 12) % 12 + 1;
    setMonth(String(newMonth));
    setYear(String(newYear));
    setUseCustomRange(false);
    setMonthlyQueryArgs((a) => ({ ...a, month: newMonth, year: newYear, startDate: '', endDate: '' }));
  };

  const reportRef = useRef<HTMLDivElement>(null);

  // Deep-link support: the sidebar navigates here with ?tab / ?month / ?year
  // and we auto-generate the matching report.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const tab = searchParams.get('tab');
    const m = searchParams.get('month');
    const y = searchParams.get('year');
    if (tab === 'annual') {
      setActiveTab('annual');
      if (y) {
        setAnnualYear(y);
        setAnnualQueryArgs({ year: parseInt(y, 10), productId, ownerId });
      }
    } else if (tab === 'monthly' || m) {
      setActiveTab('monthly');
      setUseCustomRange(false);
      if (m) setMonth(m);
      if (y) setYear(y);
      setMonthlyQueryArgs({
        month: parseInt(m || month, 10),
        year: parseInt(y || year, 10),
        productId,
        ownerId,
        startDate: '',
        endDate: '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const { data: productsData } = useQuery({ queryKey: ['products'], queryFn: () => getProducts() });
  const products = productsData?.data || [];

  // Admins can scope a report to a specific user's data.
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => getUsers(), enabled: isAdmin });

  const { data: monthlyReport, isLoading: isLoadingMonthly, isFetching: isFetchingMonthly, isError: isMonthlyError } = useQuery({
    queryKey: ['report-monthly', monthlyQueryArgs],
    queryFn: () => getMonthlyReport({
      month: monthlyQueryArgs.startDate ? undefined : monthlyQueryArgs.month,
      year: monthlyQueryArgs.startDate ? undefined : monthlyQueryArgs.year,
      productId: monthlyQueryArgs.productId !== 'all' ? monthlyQueryArgs.productId : undefined,
      ownerId: monthlyQueryArgs.ownerId && monthlyQueryArgs.ownerId !== 'all' ? monthlyQueryArgs.ownerId : undefined,
      startDate: monthlyQueryArgs.startDate || undefined,
      endDate: monthlyQueryArgs.endDate || undefined,
    }),
    // Keep the current report on screen while a new month loads, so switching
    // months inside the presentation deck doesn't blank/unmount it.
    placeholderData: (prev) => prev,
  });

  const { data: annualReport, isLoading: isLoadingAnnual, isError: isAnnualError } = useQuery({
    queryKey: ['report-annual', annualQueryArgs],
    queryFn: () => getAnnualReport({
      year: annualQueryArgs.year,
      productId: annualQueryArgs.productId !== 'all' ? annualQueryArgs.productId : undefined,
      ownerId: annualQueryArgs.ownerId && annualQueryArgs.ownerId !== 'all' ? annualQueryArgs.ownerId : undefined,
    }),
  });

  // Distinct version labels present across the monthly report, used to populate
  // the version filter. Reports span multiple products, so labels are unioned.
  const versionOptions: string[] = Array.from(
    new Set(
      (monthlyReport?.products || [])
        .flatMap((pData: any) => pData.activities || [])
        .map((act: any) => act.versionId?.label)
        .filter(Boolean) as string[]
    )
  ).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const hasUnversioned = (monthlyReport?.products || [])
    .flatMap((pData: any) => pData.activities || [])
    .some((act: any) => !act.versionId?.label);

  // Apply the client-side version filter: keep matching activities, recompute
  // per-product counts and the top-line summary, and drop emptied products.
  const matchesVersion = (act: any) => {
    if (versionFilter === 'all') return true;
    if (versionFilter === '__none__') return !act.versionId?.label;
    return act.versionId?.label === versionFilter;
  };

  const displayedMonthlyReport = (() => {
    if (!monthlyReport) return monthlyReport;
    if (versionFilter === 'all') return monthlyReport;

    // Indexed below with dynamic ACTIVITY_TYPES keys, hence the index signature.
    // NOTE: those keys are singular ('feature') while the tiles read the plural
    // ('features'), so the per-type totals are not currently landing where the UI
    // reads them. Left as-is deliberately — see docs note; fixing it changes
    // reported numbers and needs a decision on how 'enhancement'/'security' roll up.
    const summary: Record<string, number> = { products: 0, features: 0, improvements: 0, bugFixes: 0 };
    const products = (monthlyReport.products || [])
      .map((pData: any) => {
        const activities = (pData.activities || []).filter(matchesVersion);
        const counts = {
          // features: activities.filter((a: any) => a.type === 'feature').length,
          // improvements: activities.filter((a: any) => a.type === 'improvement').length,
          // bugFixes: activities.filter((a: any) => a.type === 'bug-fix').length,
          ...ACTIVITY_TYPES.reduce((acc: any, type) => ({
            ...acc,
            [type]: activities.filter((a: any) => a.type === type).length
          }), {})
        };
        return { ...pData, activities, counts };
      })
      .filter((pData: any) => pData.activities.length > 0);

    products.forEach((pData: any) => {
      summary.products++;
      // summary.features += pData.counts.features;
      // summary.improvements += pData.counts.improvements;
      // summary.bugFixes += pData.counts.bugFixes;
      ACTIVITY_TYPES.forEach(type => {
        summary[type] += pData.counts[type];
      });
    });

    return { ...monthlyReport, summary, products };
  })();

  const handleGenerateMonthly = () => {
    setMonthlyQueryArgs({
      month: parseInt(month, 10),
      year: parseInt(year, 10),
      productId,
      ownerId,
      startDate: useCustomRange ? startDate : '',
      endDate: useCustomRange ? endDate : ''
    });
  };

  const handleGenerateAnnual = () => {
    setAnnualQueryArgs({
      year: parseInt(annualYear, 10),
      productId,
      ownerId
    });
  };

  const exportMonthlyPDF = async () => {
    if (!reportRef.current) return;
    // Expand every card first so the captured DOM contains the full report
    // instead of collapsed headers, then wait a tick for layout to settle.
    setForceExpand(true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    try {
      const canvas = await html2canvas(reportRef.current, { scale: 2 });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'px',
        format: [canvas.width, canvas.height]
      });
      pdf.addImage(imgData, 'PNG', 0, 0, canvas.width, canvas.height);
      pdf.save(`Monthly_Report_${months[monthlyQueryArgs.month - 1]}_${monthlyQueryArgs.year}.pdf`);
    } catch (err) {
      console.error('Failed to export PDF:', err);
      toast.error('Failed to export PDF');
    } finally {
      setForceExpand(false);
    }
  };

  const handleExportJSON = () => {
    const data = activeTab === 'monthly' ? displayedMonthlyReport : annualReport;
    if (!data) {
      toast.error('Nothing to export yet');
      return;
    }
    try {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
      const a = document.createElement('a');
      a.href = dataStr;
      a.download = `${activeTab}_Report.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      console.error('Failed to export JSON:', err);
      toast.error('Failed to export JSON');
    }
  };

  const escapeCsv = (value: any) => {
    const str = value == null ? '' : String(value);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };

  const handleExportCSV = () => {
    if (!displayedMonthlyReport) {
      toast.error('Generate a report first');
      return;
    }
    try {
      const rows: string[] = [];
      rows.push(['Product', 'Category', 'Type', 'Title', 'Version', 'Date', 'Description'].map(escapeCsv).join(','));
      (displayedMonthlyReport.products || []).forEach((pData: any) => {
        (pData.activities || []).forEach((act: any) => {
          rows.push([
            pData.product?.name,
            pData.product?.category,
            (act.type || '').replace('-', ' '),
            act.title,
            act.versionId?.label || '',
            act.activityDate ? new Date(act.activityDate).toLocaleDateString() : '',
            htmlToPlainText(act.shortDescription || ''),
          ].map(escapeCsv).join(','));
        });
      });
      const csv = rows.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Monthly_Report_${months[monthlyQueryArgs.month - 1]}_${monthlyQueryArgs.year}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export CSV:', err);
      toast.error('Failed to export CSV');
    }
  };

  const handleExportPPTX = () => {
    if (!displayedMonthlyReport) {
      toast.error('Generate a report first');
      return;
    }
    try {
      const pres = new pptxgen();
      const periodLabel = monthlyQueryArgs.startDate
        ? `${monthlyQueryArgs.startDate} – ${monthlyQueryArgs.endDate}`
        : `${months[monthlyQueryArgs.month - 1]} ${monthlyQueryArgs.year}`;

      // Title + summary slide
      const title = pres.addSlide();
      title.addText('Monthly Report', { x: 0.5, y: 1.2, w: '90%', h: 1, fontSize: 36, bold: true, align: 'center' });
      title.addText(periodLabel, { x: 0.5, y: 2.4, w: '90%', h: 0.6, fontSize: 20, align: 'center', color: '666666' });
      const s = displayedMonthlyReport.summary || {};
      title.addText(
        [
          // { text: `Products updated: ${s.products ?? 0}`, options: { bullet: true } },
          // { text: `Features: ${s.features ?? 0}`, options: { bullet: true } },
          // { text: `Improvements: ${s.improvements ?? 0}`, options: { bullet: true } },
          // { text: `Bug fixes: ${s.bugFixes ?? 0}`, options: { bullet: true } },
          { text: `Products updated: ${s.products ?? 0}`, options: { bullet: true } },
          ...ACTIVITY_TYPES.map(type => ({
            text: `${type.replace('-', ' ')}: ${s[type] ?? 0}`,
            options: { bullet: true },
          })),
        ],
        { x: 1, y: 3.4, w: '80%', h: 2, fontSize: 16 }
      );

      // One slide per product
      (displayedMonthlyReport.products || []).forEach((pData: any) => {
        const slide = pres.addSlide();
        slide.addText(pData.product?.name || 'Product', { x: 0.5, y: 0.4, w: '90%', h: 0.7, fontSize: 24, bold: true });
        const bullets = (pData.activities || []).slice(0, 12).map((act: any) => ({
          text: `[${(act.type || '').replace('-', ' ')}] ${act.title}${act.versionId?.label ? ` (${act.versionId.label})` : ''}`,
          options: { bullet: true, fontSize: 14 },
        }));
        if (bullets.length === 0) {
          slide.addText('No activities for this period.', { x: 0.5, y: 1.4, w: '90%', fontSize: 14, color: '999999' });
        } else {
          slide.addText(bullets, { x: 0.5, y: 1.4, w: '90%', h: 4.5 });
        }
      });

      pres.writeFile({ fileName: `Monthly_Report_${months[monthlyQueryArgs.month - 1]}_${monthlyQueryArgs.year}.pptx` });
    } catch (err) {
      console.error('Failed to export PPTX:', err);
      toast.error('Failed to export PowerPoint');
    }
  };

  return (
    <PageTransition className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h2 className="text-3xl font-bold tracking-tight">Reports</h2>
      </div>

      <div className="flex space-x-4 border-b">
        <button
          className={`pb-2 text-lg font-bold border-b-2 transition-colors ${activeTab === 'monthly' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => setActiveTab('monthly')}
        >
          Detailed Report
        </button>
        <button
          className={`pb-2 text-lg font-bold border-b-2 transition-colors ${activeTab === 'annual' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => setActiveTab('annual')}
        >
          Annual Summary
        </button>
      </div>

      {activeTab === 'monthly' && (
        <>
          <div className="flex flex-col lg:flex-row gap-4 bg-card p-4 rounded-lg border items-end">
            {!useCustomRange ? (
              <>
                <div className="space-y-1 flex-1">
                  <label className="text-sm font-medium">Month</label>
                  <Select value={month} onValueChange={setMonth}>
                    <SelectTrigger><SelectValue placeholder="Month" /></SelectTrigger>
                    <SelectContent>
                      {months.map((m, i) => <SelectItem key={m} value={(i + 1).toString()}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 flex-1">
                  <label className="text-sm font-medium">Year</label>
                  <Input type="number" value={year} onChange={e => setYear(e.target.value)} min="2000" max="2100" />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1 flex-1">
                  <label className="text-sm font-medium">Start Date</label>
                  <DatePicker
                    value={startDate}
                    onChange={setStartDate}
                    placeholder="Pick start date"
                    max={endDate || undefined}
                    clearable
                  />
                </div>
                <div className="space-y-1 flex-1">
                  <label className="text-sm font-medium">End Date</label>
                  <DatePicker
                    value={endDate}
                    onChange={setEndDate}
                    placeholder="Pick end date"
                    min={startDate || undefined}
                    clearable
                  />
                </div>
              </>
            )}

            {isAdmin && (
              <div className="space-y-1 flex-1">
                <label className="text-sm font-medium">User</label>
                <Select value={ownerId} onValueChange={setOwnerId}>
                  <SelectTrigger><SelectValue placeholder="All Users" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Users</SelectItem>
                    {users.map((u: any) => <SelectItem key={u._id} value={u._id}>{u.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1 flex-1">
              <label className="text-sm font-medium">Product</label>
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger><SelectValue placeholder="All Products" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Products</SelectItem>
                  {products?.map((p: any) => <SelectItem key={p._id} value={p._id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {(versionOptions.length > 0 || hasUnversioned) && (
              <div className="space-y-1 flex-1">
                <label className="text-sm font-medium flex items-center gap-1"><Tag className="w-3.5 h-3.5" /> Version</label>
                <Select value={versionFilter} onValueChange={setVersionFilter}>
                  <SelectTrigger><SelectValue placeholder="All Versions" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Versions</SelectItem>
                    {versionOptions.map((label, i) => (
                      <SelectItem key={label} value={label}>
                        <span className="flex items-center gap-2">
                          {label}
                          {labelInfo.get(label)?.isUnreleased && <VersionBadge kind="unreleased" size="xs" />}
                          {i === 0 && <VersionBadge kind="latest" size="xs" />}
                        </span>
                      </SelectItem>
                    ))}
                    {hasUnversioned && <SelectItem value="__none__">Unversioned</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2 mt-4 lg:mt-0 items-end">
              <Button variant="outline" onClick={() => setUseCustomRange(!useCustomRange)}>
                {useCustomRange ? 'Use Month/Year' : 'Use Custom Range'}
              </Button>
              <Button onClick={handleGenerateMonthly}>Generate Report</Button>
              <Button
                variant="outline"
                onClick={() => setPresenting(true)}
                disabled={!displayedMonthlyReport?.products?.length}
                title="Present this report full-screen"
              >
                <Presentation className="w-4 h-4 mr-2" /> Present
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <Download className="w-4 h-4 mr-2" /> Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={exportMonthlyPDF}>Export as PDF</DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportPPTX}>Export as PowerPoint (.pptx)</DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportCSV}>Export as CSV</DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportJSON}>Export as JSON</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {isLoadingMonthly ? (
            <ReportsSkeleton />
          ) : isMonthlyError ? (
            <div className="text-destructive py-10 text-center">Failed to load the report. Please try again.</div>
          ) : displayedMonthlyReport ? (
            <div ref={reportRef} className="space-y-6">
              <div className="lg:sticky lg:top-4 z-30 bg-background/80 lg:backdrop-blur-md pb-4 pt-2 -mt-2">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 shadow-sm rounded-xl">
                  <Card><CardContent className="p-6 flex flex-col items-center justify-center text-center space-y-2"><Package className="w-8 h-8 text-muted-foreground" /><div className="text-3xl font-bold">{displayedMonthlyReport.summary.products}</div><div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Products Updated</div></CardContent></Card>
                <Card><CardContent className="p-6 flex flex-col items-center justify-center text-center space-y-2"><PlusCircle className="w-8 h-8 text-blue-500 opacity-80" /><div className="text-3xl font-bold">{displayedMonthlyReport.summary.features}</div><div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Features Delivered</div></CardContent></Card>
                <Card><CardContent className="p-6 flex flex-col items-center justify-center text-center space-y-2"><Wrench className="w-8 h-8 text-purple-500 opacity-80" /><div className="text-3xl font-bold">{displayedMonthlyReport.summary.improvements}</div><div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Improvements Made</div></CardContent></Card>
                  <Card><CardContent className="p-6 flex flex-col items-center justify-center text-center space-y-2"><Bug className="w-8 h-8 text-red-500 opacity-80" /><div className="text-3xl font-bold">{displayedMonthlyReport.summary.bugFixes}</div><div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Bug Fixes Resolved</div></CardContent></Card>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-xl font-bold mt-8 mb-4">Product Reports</h3>
                {displayedMonthlyReport.products.length === 0 ? (
                  <div className="text-muted-foreground">
                    {versionFilter === 'all' ? 'No activities found for the selected period.' : 'No activities found for the selected version.'}
                  </div>
                ) : (
                  displayedMonthlyReport.products.map((pData: any) => <ProductReportCard key={pData.product._id} pData={pData} forceExpanded={forceExpand} />)
                )}
              </div>
            </div>
          ) : null}
        </>
      )}

      {activeTab === 'annual' && (
        <>
          <div className="flex gap-4 bg-card p-4 rounded-lg border items-end">
            <div className="space-y-1 flex-1">
              <label className="text-sm font-medium">Year</label>
              <Input type="number" value={annualYear} onChange={e => setAnnualYear(e.target.value)} min="2000" max="2100" />
            </div>
            {isAdmin && (
              <div className="space-y-1 flex-1">
                <label className="text-sm font-medium">User</label>
                <Select value={ownerId} onValueChange={setOwnerId}>
                  <SelectTrigger><SelectValue placeholder="All Users" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Users</SelectItem>
                    {users.map((u: any) => <SelectItem key={u._id} value={u._id}>{u.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1 flex-1">
              <label className="text-sm font-medium">Product</label>
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger><SelectValue placeholder="All Products" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Products</SelectItem>
                  {products?.map((p: any) => <SelectItem key={p._id} value={p._id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleGenerateAnnual}>Generate Summary</Button>
            <Button variant="outline" onClick={handleExportJSON}><Download className="w-4 h-4 mr-2" /> Export JSON</Button>
          </div>

          {isLoadingAnnual ? (
            <ReportsSkeleton />
          ) : isAnnualError ? (
            <div className="text-destructive py-10 text-center">Failed to load the annual summary. Please try again.</div>
          ) : annualReport ? (
            <div className="space-y-6">
              <div className="lg:sticky lg:top-4 z-30 bg-background/80 lg:backdrop-blur-md pb-4 pt-2 -mt-2">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 shadow-sm rounded-xl">
                  <Card><CardContent className="p-6 flex flex-col items-center justify-center text-center space-y-2"><Package className="w-8 h-8 text-muted-foreground" /><div className="text-3xl font-bold">{annualReport.summary.total}</div><div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Total Activities</div></CardContent></Card>
                <Card><CardContent className="p-6 flex flex-col items-center justify-center text-center space-y-2"><PlusCircle className="w-8 h-8 text-blue-500 opacity-80" /><div className="text-3xl font-bold">{annualReport.summary.features}</div><div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Total Features</div></CardContent></Card>
                <Card><CardContent className="p-6 flex flex-col items-center justify-center text-center space-y-2"><Wrench className="w-8 h-8 text-purple-500 opacity-80" /><div className="text-3xl font-bold">{annualReport.summary.improvements}</div><div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Total Improvements</div></CardContent></Card>
                  <Card><CardContent className="p-6 flex flex-col items-center justify-center text-center space-y-2"><Bug className="w-8 h-8 text-red-500 opacity-80" /><div className="text-3xl font-bold">{annualReport.summary.bugFixes}</div><div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Total Bug Fixes</div></CardContent></Card>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-xl font-bold mt-8 mb-4">Monthly Breakdown ({annualReport.year})</h3>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {annualReport.months.map((m: any) => (
                    <Card key={m.month}>
                      <CardHeader className="pb-2">
                        <CardTitle>{m.label}</CardTitle>
                        <CardDescription>{m.total} total activities</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="flex justify-between items-center text-sm">
                          <span className="text-blue-500 flex items-center"><PlusCircle className="w-4 h-4 mr-1" /> {m.features}</span>
                          <span className="text-purple-500 flex items-center"><Wrench className="w-4 h-4 mr-1" /> {m.improvements}</span>
                          <span className="text-red-500 flex items-center"><Bug className="w-4 h-4 mr-1" /> {m.bugFixes}</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}

      {presenting && displayedMonthlyReport ? (
        <PresentationMode
          report={displayedMonthlyReport}
          periodLabel={periodLabel}
          onClose={() => setPresenting(false)}
          monthMode={monthMode}
          isFetching={isFetchingMonthly}
          canPrevMonth={monthMode}
          canNextMonth={canNextMonth}
          onPrevMonth={() => shiftMonth(-1)}
          onNextMonth={() => shiftMonth(1)}
        />
      ) : null}
    </PageTransition>
  );
}
