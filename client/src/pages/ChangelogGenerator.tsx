import { useState, useRef, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import PageTransition, { staggerContainer, staggerItem } from '../components/layout/PageTransition';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  GitBranch, Play, Square, Copy, Check, Tag, Calendar, Hash,
  FileCode2, Layers, ClipboardList, GitPullRequest, Users, Loader2,
  AlertCircle, Info,
} from 'lucide-react';
import { getProducts } from '../services/products';
import {
  getProductTags,
  getProductModels,
  type GenerateInput,
  type GenerationResult,
  type RangeType,
} from '../services/changelogGen';
import { useChangelogGen } from '../contexts/ChangelogGenContext';
import { toast } from 'sonner';


// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const RANGE_OPTIONS: { value: RangeType; label: string; icon: any; desc: string }[] = [
  { value: 'working', label: 'Working Tree', icon: FileCode2, desc: 'Uncommitted changes vs HEAD' },
  { value: 'tags', label: 'Between Tags', icon: Tag, desc: 'From one tag to another' },
  { value: 'commit', label: 'Commit Range', icon: Hash, desc: 'Between two commit hashes' },
  { value: 'date', label: 'Date Range', icon: Calendar, desc: 'Changes within a time period' },
];

const OUTPUT_TABS: { key: keyof GenerationResult['outputs']; label: string; icon: any }[] = [
  { key: 'developerChangelog', label: 'Developer', icon: FileCode2 },
  { key: 'userReleaseNotes', label: 'Release Notes', icon: Users },
  { key: 'githubReleaseNotes', label: 'GitHub', icon: GitPullRequest },
  { key: 'qaChecklist', label: 'QA Checklist', icon: ClipboardList },
];

const STEP_LABELS: Record<string, string> = {
  git: 'Git Analysis',
  classify: 'Code Classification',
  summarize: 'AI Summarization',
  report: 'Report Generation',
  review: 'Review Queue',
};

// ────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────

export default function ChangelogGenerator() {
  // Pipeline state lives in a root provider so generation keeps running (and
  // stays visible via the docked mini-player) when navigating away.
  const { running, logs, currentStep, progress, result, error, start, cancel } = useChangelogGen();

  // ── Product + range form state ──
  const [productId, setProductId] = useState('');
  const [rangeType, setRangeType] = useState<RangeType>('working');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [modelOverride, setModelOverride] = useState('');
  const [createReviewEntries, setCreateReviewEntries] = useState(true);

  // ── Output tab state ──
  const [activeTab, setActiveTab] = useState<keyof GenerationResult['outputs']>('developerChangelog');
  const [copied, setCopied] = useState(false);

  const logEndRef = useRef<HTMLDivElement>(null);

  // ── Data queries ──
  const { data: productsData } = useQuery({
    queryKey: ['products'],
    queryFn: () => getProducts(),
  });
  const products = productsData?.data || [];

  const eligibleProducts = products.filter((p: any) => p.repoPath);

  const { data: tags = [], isLoading: tagsLoading } = useQuery({
    queryKey: ['product-tags', productId],
    queryFn: () => getProductTags(productId),
    enabled: !!productId && rangeType === 'tags',
  });

  const { data: models = [] } = useQuery({
    queryKey: ['ollama-models'],
    queryFn: getProductModels,
  });

  // Auto-scroll the log panel
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const selectedProduct = products.find((p: any) => p._id === productId);

  // ── Handlers ──

  const handleGenerate = useCallback(() => {
    if (!productId) {
      toast.error('Select a product first');
      return;
    }
    if (rangeType !== 'working' && !from) {
      toast.error('Provide a "from" value');
      return;
    }

    const input: GenerateInput = {
      productId,
      rangeType,
      from: from || undefined,
      to: to || undefined,
      model: modelOverride.trim() || undefined,
      createReviewEntries,
    };

    start(input, { productName: selectedProduct?.name || 'product' });
  }, [productId, rangeType, from, to, modelOverride, createReviewEntries, selectedProduct, start]);

  const handleCancel = useCallback(() => { cancel(); }, [cancel]);

  const handleCopy = useCallback(() => {
    if (!result) return;
    const text = result.outputs[activeTab];
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [result, activeTab]);

  // ────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────

  return (
    <PageTransition>
      <motion.div variants={staggerContainer} initial="hidden" animate="show">
        {/* Header */}
        <motion.div variants={staggerItem} className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <GitBranch className="w-8 h-8 text-primary" />
            Git Changelog Generator
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            Analyze git changes and generate developer changelogs, user-facing release notes,
            GitHub release notes, and QA checklists — powered by your Ollama model (local or cloud,
            configurable in Settings).
          </p>
        </motion.div>

        {/* Configuration Card */}
        <motion.div variants={staggerItem} className="bg-card rounded-xl border shadow-sm p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Layers className="w-5 h-5 text-muted-foreground" />
            Configuration
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            {/* Product selector */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Product</label>
              <Select value={productId} onValueChange={(v) => { setProductId(v); setFrom(''); setTo(''); }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a product with a repo path…" />
                </SelectTrigger>
                <SelectContent>
                  {eligibleProducts.length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      No products have a repository path configured
                    </div>
                  )}
                  {eligibleProducts.map((p: any) => (
                    <SelectItem key={p._id} value={p._id}>
                      <span className="flex items-center gap-2">
                        {p.icon
                          ? <img src={p.icon} alt="" className="w-4 h-4 rounded object-cover" />
                          : <span className="w-4 h-4 rounded bg-primary/15 text-primary text-[8px] font-bold flex items-center justify-center">{p.name?.[0]}</span>
                        }
                        {p.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedProduct && (
                <>
                  <p className="text-xs text-muted-foreground truncate" title={selectedProduct.repoPath}>
                    📂 {selectedProduct.repoPath}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Build output, vendored code and tests are kept out of the AI's context.
                    Add a <span className="font-mono">.atrsignore</span> in the repo root to adjust.
                  </p>
                </>
              )}
            </div>

            {/* Range type */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Range</label>
              <Select value={rangeType} onValueChange={(v) => { setRangeType(v as RangeType); setFrom(''); setTo(''); }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RANGE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      <span className="flex items-center gap-2">
                        <r.icon className="w-4 h-4 text-muted-foreground" />
                        {r.label}
                        <span className="text-xs text-muted-foreground hidden sm:inline">— {r.desc}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Model selector override */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Ollama Model <span className="text-muted-foreground font-normal text-xs">(optional override)</span></label>
              <Input
                value={modelOverride}
                onChange={(e) => setModelOverride(e.target.value)}
                placeholder="e.g. gemma3:latest, llama3:latest"
              />
              {models.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5 max-h-16 overflow-y-auto">
                  {models.map((m: string) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setModelOverride(m)}
                      className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
                        modelOverride === m
                          ? 'bg-primary text-primary-foreground font-medium'
                          : 'bg-muted hover:bg-accent text-muted-foreground'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Conditional range inputs */}
          <AnimatePresence mode="wait">
            {rangeType !== 'working' && (
              <motion.div
                key={rangeType}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4"
              >
                {rangeType === 'tags' ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">From Tag</label>
                      <Select value={from} onValueChange={setFrom}>
                        <SelectTrigger>
                          <SelectValue placeholder={tagsLoading ? 'Loading tags…' : 'Select start tag'} />
                        </SelectTrigger>
                        <SelectContent>
                          {tags.map((t: string) => (
                            <SelectItem key={t} value={t}>{t}</SelectItem>
                          ))}
                          {tags.length === 0 && !tagsLoading && (
                            <div className="px-3 py-2 text-sm text-muted-foreground">No tags found</div>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">To Tag <span className="text-muted-foreground font-normal">(defaults to HEAD)</span></label>
                      <Select value={to} onValueChange={setTo}>
                        <SelectTrigger>
                          <SelectValue placeholder="HEAD (latest)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="HEAD">HEAD (latest)</SelectItem>
                          {tags.map((t: string) => (
                            <SelectItem key={t} value={t}>{t}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                ) : rangeType === 'commit' ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">From Commit</label>
                      <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="e.g. abc1234 or HEAD~10" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">To Commit <span className="text-muted-foreground font-normal">(defaults to HEAD)</span></label>
                      <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="HEAD" />
                    </div>
                  </>
                ) : rangeType === 'date' ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">From Date</label>
                      <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">To Date <span className="text-muted-foreground font-normal">(defaults to now)</span></label>
                      <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                    </div>
                  </>
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Review-queue toggle */}
          <label className="flex items-start gap-2.5 mb-4 cursor-pointer select-none rounded-lg border bg-muted/30 px-3 py-2.5">
            <input
              type="checkbox"
              checked={createReviewEntries}
              onChange={(e) => setCreateReviewEntries(e.target.checked)}
              disabled={running}
              className="mt-0.5 h-4 w-4 rounded border-input accent-primary shrink-0"
            />
            <span className="text-sm">
              <span className="font-medium flex items-center gap-1.5">
                <ClipboardList className="w-3.5 h-3.5" /> Send drafts to the review queue
              </span>
              <span className="text-xs text-muted-foreground">
                Creates one draft entry per commit (or grouped logical entries for the working tree),
                flagged for review before they enter the changelog. Uncheck to only preview the reports.
              </span>
            </span>
          </label>

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            {!running ? (
              <Button
                onClick={handleGenerate}
                disabled={!productId || (rangeType !== 'working' && !from)}
                className="gap-2"
              >
                <Play className="w-4 h-4" /> Generate
              </Button>
            ) : (
              <Button variant="destructive" onClick={handleCancel} className="gap-2">
                <Square className="w-4 h-4" /> Cancel
              </Button>
            )}
            {!running && eligibleProducts.length === 0 && (
              <p className="text-sm text-amber-500 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" />
                No products have a repository path — configure one in product settings first.
              </p>
            )}
          </div>
        </motion.div>

        {/* Progress Panel */}
        <AnimatePresence>
          {(running || logs.length > 0) && !result && (
            <motion.div
              variants={staggerItem}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="bg-card rounded-xl border shadow-sm p-6 mb-6"
            >
              <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                {running && <Loader2 className="w-5 h-5 animate-spin text-primary" />}
                {running ? 'Generating…' : 'Pipeline Log'}
              </h2>

              {/* Progress bar */}
              {progress && running && (
                <div className="mb-4">
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>{STEP_LABELS[currentStep] || currentStep}</span>
                    <span>{progress.current}/{progress.total}</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <motion.div
                      className="h-full bg-primary rounded-full"
                      initial={{ width: 0 }}
                      animate={{ width: `${(progress.current / progress.total) * 100}%` }}
                      transition={{ duration: 0.3, ease: 'easeOut' }}
                    />
                  </div>
                </div>
              )}

              {/* Log entries */}
              <div className="max-h-64 overflow-y-auto bg-muted/40 rounded-lg p-3 font-mono text-xs space-y-1">
                {logs.map((log, i) => (
                  <div key={i} className={`flex items-start gap-2 ${
                    log.type === 'error' ? 'text-red-500' :
                    log.type === 'warn' ? 'text-amber-500' :
                    log.type === 'success' ? 'text-emerald-500' :
                    'text-muted-foreground'
                  }`}>
                    <span className="shrink-0 mt-0.5">
                      {log.type === 'error' ? '✗' : log.type === 'success' ? '✓' : log.type === 'warn' ? '⚠' : '›'}
                    </span>
                    <span>
                      <span className="text-foreground/60">[{STEP_LABELS[log.step] || log.step}]</span>{' '}
                      {log.message}
                    </span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>

              {error && (
                <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  {error}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Results Panel */}
        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-4"
            >
              {/* Stats bar */}
              <div className="flex items-center gap-4 flex-wrap text-sm">
                <Badge variant="outline" className="gap-1.5">
                  <FileCode2 className="w-3.5 h-3.5" />
                  {result.stats.filesAnalyzed} files
                </Badge>
                <Badge variant="outline" className="gap-1.5">
                  <Layers className="w-3.5 h-3.5" />
                  {result.stats.chunksProcessed} chunks
                </Badge>
                <Badge variant="outline" className="gap-1.5">
                  <Hash className="w-3.5 h-3.5" />
                  {result.stats.commits} commits
                </Badge>
                <Badge variant="outline" className="gap-1.5">
                  <Info className="w-3.5 h-3.5" />
                  Model: {result.stats.model}
                </Badge>
                {result.stats.reviewEntriesCreated > 0 && (
                  <Link to="/review">
                    <Badge className="gap-1.5 cursor-pointer bg-primary/10 text-primary hover:bg-primary/20 border-primary/20">
                      <ClipboardList className="w-3.5 h-3.5" />
                      {result.stats.reviewEntriesCreated} in review queue
                    </Badge>
                  </Link>
                )}
              </div>

              {/* Tab bar */}
              <div className="bg-card rounded-xl border shadow-sm overflow-hidden">
                <div className="flex border-b overflow-x-auto">
                  {OUTPUT_TABS.map((tab) => (
                    <button
                      key={tab.key}
                      onClick={() => { setActiveTab(tab.key); setCopied(false); }}
                      className={`flex items-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${
                        activeTab === tab.key
                          ? 'border-primary text-primary bg-primary/5'
                          : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/40'
                      }`}
                    >
                      <tab.icon className="w-4 h-4" />
                      {tab.label}
                    </button>
                  ))}

                  {/* Copy button (right-aligned) */}
                  <div className="ml-auto flex items-center px-3">
                    <Button variant="ghost" size="sm" onClick={handleCopy} className="gap-1.5 text-xs">
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? 'Copied!' : 'Copy'}
                    </Button>
                  </div>
                </div>

                {/* Markdown output */}
                <div className="p-6 prose prose-sm dark:prose-invert max-w-none overflow-x-auto">
                  <SimpleMarkdown content={result.outputs[activeTab]} />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </PageTransition>
  );
}

function SimpleMarkdown({ content }: { content: string }) {
  if (!content) return null;

  const lines = content.split('\n');

  return (
    <div className="space-y-2 text-sm text-foreground leading-relaxed">
      {lines.map((line, idx) => {
        const trimmed = line.trim();

        // Headers
        if (trimmed.startsWith('# ')) {
          return <h1 key={idx} className="text-2xl font-bold mt-6 mb-3 border-b pb-1">{trimmed.slice(2)}</h1>;
        }
        if (trimmed.startsWith('## ')) {
          return <h2 key={idx} className="text-xl font-semibold mt-5 mb-2">{trimmed.slice(3)}</h2>;
        }
        if (trimmed.startsWith('### ')) {
          return <h3 key={idx} className="text-lg font-semibold mt-4 mb-2">{trimmed.slice(4)}</h3>;
        }
        if (trimmed.startsWith('#### ')) {
          return <h4 key={idx} className="text-base font-semibold mt-3 mb-1">{trimmed.slice(5)}</h4>;
        }

        // Horizontal rule
        if (trimmed === '---') {
          return <hr key={idx} className="my-4 border-t" />;
        }

        // Checklist items: - [ ] or - [x]
        if (trimmed.startsWith('- [ ] ') || trimmed.startsWith('- [x] ') || trimmed.startsWith('* [ ] ') || trimmed.startsWith('* [x] ')) {
          const checked = trimmed.includes('[x]');
          const text = trimmed.slice(6);
          return (
            <div key={idx} className="flex items-start gap-2 pl-4 py-0.5">
              <input type="checkbox" checked={checked} readOnly className="mt-1 rounded border bg-background" />
              <span>{parseInline(text)}</span>
            </div>
          );
        }

        // Unordered lists
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          const text = trimmed.slice(2);
          return (
            <div key={idx} className="flex items-start gap-2 pl-4 py-0.5">
              <span className="text-primary font-bold mt-0.5">•</span>
              <span>{parseInline(text)}</span>
            </div>
          );
        }

        // Quote blocks
        if (trimmed.startsWith('> ')) {
          return (
            <blockquote key={idx} className="border-l-4 border-primary/30 pl-4 py-1 my-2 bg-muted/30 rounded-r italic text-muted-foreground">
              {parseInline(trimmed.slice(2))}
            </blockquote>
          );
        }

        // Empty lines
        if (!trimmed) {
          return <div key={idx} className="h-2" />;
        }

        // Regular paragraphs
        return <p key={idx} className="my-1">{parseInline(line)}</p>;
      })}
    </div>
  );
}

function parseInline(text: string) {
  // Parse simple bold (**text**)
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    }
    // Parse simple inline code (`code`)
    const codeParts = part.split(/(`.*?`)/g);
    return codeParts.map((subPart, j) => {
      if (subPart.startsWith('`') && subPart.endsWith('`')) {
        return <code key={j} className="px-1.5 py-0.5 rounded bg-muted font-mono text-xs border">{subPart.slice(1, -1)}</code>;
      }
      return subPart;
    });
  });
}
