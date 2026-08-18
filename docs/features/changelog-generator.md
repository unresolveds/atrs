# AI Changelog Generator

**Summary:** An AI-powered pipeline that reads a product repo's git diff over a chosen range and produces four markdown outputs — developer changelog, user release notes, GitHub release notes, and a QA checklist — while optionally drafting `needsReview` changelog entries into the review queue; progress streams live over SSE and stays visible via a docked mini-player. This is distinct from manual [changelog-management](changelog-management.md) and [version-management](version-management.md), though it *feeds* the former by creating draft entries.

## User-facing entry points
- Route `/changelog-generator` — the generator page (`client/src/pages/ChangelogGenerator.tsx`).
- Docked **mini-player** (`client/src/components/jobs/ChangelogGenMiniPlayer.tsx`) — a floating pip shown on every page *except* the generator itself, so a run stays visible when navigating away; offers Stop / Open / Review shortcuts.
- Post-run "Review" link to `/review` appears when draft review entries were created.
- Configuration surface: product select (only products with a `repoPath` are eligible), range type (working / tags / commit / date), optional Ollama model override + suggested-model chips, and a "Send drafts to review queue" checkbox (`createReviewEntries`, default true).

## Client pieces
- **Page:** `client/src/pages/ChangelogGenerator.tsx` — builds `GenerateInput` and calls `start(input, {productName})`; renders the live progress panel (spinner, progress bar keyed to `STEP_LABELS`: git → classify → summarize → report → review, colored log list) and the results panel (stats badges + 4 output tabs + Copy). Includes a module-local `SimpleMarkdown` renderer. It does **not** own streaming state.
- **Context/provider (owns the pipeline):** `client/src/contexts/ChangelogGenContext.tsx` — a root-level provider so generation keeps running and stays visible after navigation. Exposes `{active, running, logs, currentStep, progress, result, error, productName, start, cancel, reset}`. `start` resets state, creates an `AbortController`, and calls `generateChangelog(input, callbacks, signal)`; callbacks append `logs`, set `currentStep`/`progress`, and on complete set `result` + toast (special "sent to review queue" toast when `reviewEntriesCreated > 0`). Holds `sessionIdRef` for server-side cancel. `active` vs `running` separation lets the mini-player linger after completion until `reset`.
- **Service:** `client/src/services/changelogGen.ts` — `generateChangelog(input, handlers, signal)` uses **raw `fetch`** (not axios) so it can POST a body, send the JWT header manually, and read the SSE `ReadableStream`; it splits on `\n\n`, parses `event:`/`data:`, and dispatches `session`/`progress`/`complete`/`error`. Also `getProductTags(productId)` and `getProductModels()` (axios). Types: `RangeType`, `GenerateInput`, `GenerationResult`, `ProgressEvent`.
- **Dual cancellation:** `cancel()` calls `cancelJob(sessionId)` (server-side, via `services/jobStream`) **and** aborts the local controller — needed because streaming jobs may span serverless instances.
- **React Query keys:** `['products']` (filtered to `repoPath`-eligible), `['product-tags', productId]` (`enabled` only when `rangeType==='tags'`), `['ollama-models']`. The pipeline itself is not a react-query mutation — it's driven by the context.
- **Contexts consumed:** `ChangelogGenContext` (page + mini-player), `JobDockContext` (`DockBoard order={2}` for the mini-player).

## Server pieces
Router `server/src/routes/changelogGenRoutes.ts` mounted at `/api/changelog-gen` behind `requireAuth` + `requireActive`.

| Method + Path | Validation | Controller | Notes |
|---|---|---|---|
| `POST /generate` | `generateChangelogSchema` | `generate` | **SSE** via `runStreamJob`; cancellable |
| `GET /tags/:productId` | inline `{params:{productId:objectId}}` | `getTags` | `git tag --sort=-creatordate` (cwd=repoPath, 10s); `[]` on git failure |
| `GET /models` | — | `getModels` | Ollama `/api/tags` names; `[]` on error |

Flow: `ChangelogGenController` (`server/src/controllers/ChangelogGenController.ts`) → `ChangelogGenService.runPipeline` (`server/src/services/ChangelogGenService.ts`), which calls the local `git` binary (`execFile`) and the Ollama server (`/api/generate`). AI-assist prompts for other forms share the sibling `AiService` (`server/src/services/ai/AiService.ts`) + `prompts.ts`, but the generator has its own `REPORT_PROMPTS`.

**Auth + security guards (enforced before any git/subprocess access):**
- Mount-level `requireAuth` + `requireActive`.
- `generate`/`getTags` load the product, `assertOwner(product, req.user)`, require `repoPath` (else 400), and `assertRepoPathAllowed(repoPath)` — the **repo-path jail** (`server/src/utils/repoAccess.ts`) confines access to `REPO_BROWSE_ROOT` (default OS home), rejecting `..` climbs and cross-drive/absolute escapes.
- **git argument-injection hardening:** the `gitRef` Zod refinement (`changelogGen.schema.ts`) rejects refs starting with `-` and containing control chars (while still allowing dates like "2 weeks ago"); `.refine` requires `from` for every `rangeType` except `working`. `gitAnalyze` additionally passes `--end-of-options` so revision args are never parsed as flags.
- Post-stream errors can't use the JSON error path — the controller checks `res.headersSent`.

**Pipeline (`runPipeline`) — 5 stages, each emitting SSE progress via `ctx.emit`, cancellation-checked via `ctx.isCancelled()`:**
1. **git** — `gitAnalyze` builds diff/log args per `rangeType` (`working`/`tags`/`commit`/`date`; `date` resolves bounding commits first), parses A/M/D/R/C statuses, drops non-source files via `utils/atrsIgnore.ts` (built-in defaults for dependencies, build output, bundles, lockfiles and tests, plus an optional per-repo `.atrsignore` — see [../configuration/atrsignore.md](../configuration/atrsignore.md)), and fetches per-file diffs. The count skipped is emitted as a `git` progress event. No files → empty result with "No changes found" outputs.

   > **`working` reads tracked changes only.** `git diff --name-status HEAD` does not list untracked files, so a brand-new file shows in `git status` but is not summarised until it is staged or committed.
2. **classify** — `buildChunks` splits large diffs on `@@` hunk headers, packing under `MAX_CHUNK_CHARS` (3500).
3. **summarize** — `summarizeAll` runs one Ollama JSON call per chunk (`format:'json'`, `stream:false`, deterministic options, `num_predict 200`) → `{title,type,summary,impact,breakingChange}`, normalized/clamped. Per-chunk errors are tolerated; zero total summaries aborts the run.
4. **report** — `generateAllReports` runs 4 sequential Ollama calls, one per format, each with a format-specific system prompt (`num_predict 2000`); a per-format failure degrades to a `> ⚠️ Generation failed:` placeholder rather than failing the run.
5. **review** — only if `createReviewEntries !== false` AND `productId` AND `ownerId`. Commit-based ranges → `summarizeCommits` (one entry per commit, `git show`); working tree (or if commits yield none) → `synthesizeLogicalEntries` (single clustering pass). `persistReviewEntries` upserts drafts into `Activity` via `importSourceKey = ai-gen|<productId>|<entry.key>`, `needsReview:true`, tags `['unreleased','ai-generated']`, `reviewReason:'ai-generated'`.

All Ollama calls use `stream:false` — SSE progress is **item-level (per chunk/commit/format), not token-level**.

**Note on readme parsing:** `server/src/utils/readmeChangelog.ts` (algorithm: [../algorithms/readme-changelog-parsing.md](../algorithms/readme-changelog-parsing.md)) is the *other* changelog-drafting path — it parses `== Changelog ==` from a WP.org readme into typed items with a high/medium/low confidence model that also feeds `needsReview`. It is part of WP.org import, distinct from this AI generator, but both converge on `needsReview` `Activity` drafts.

## Data model
- **Reads:** `Product` (`name`, `repoPath`, `ownerId`) to authorize and locate the repo; the git repository on disk (via `git` CLI); the Ollama server.
- **Writes:** `Activity` model (collection `activities`) draft entries only, via `Activity.findOneAndUpdate({importSourceKey, needsReview:true}, ..., {upsert:true})`. Fields set on insert: `type`, `title`, `shortDescription` (summary + Impact + breaking-change note), `tags:['unreleased','ai-generated']`, `reviewReason:'ai-generated'`, `needsReview:true`, `importSourceKey`. User-confirmed entries (`needsReview:false`) are never overwritten — re-runs only refresh still-pending drafts. The `{productId, importSourceKey}` unique partial index dedups. (Full `Activity` schema in [changelog-management.md](changelog-management.md).)
- The four generated markdown **outputs are returned in the SSE `complete` payload**, not persisted server-side; they live only in client `result.outputs`.

## Notable behaviors & edge cases
- **Persistence across navigation:** pipeline state lives in the root `ChangelogGenProvider`; the page and mini-player are just views over it. Closing the mini-player requires the run to be finished (`!running`).
- **Requires `git` on PATH and a valid repo at `repoPath`; requires a reachable Ollama server.** `getModels`/`getTags` degrade to `[]` on any failure; `getModels` reads `getOllamaUrl()/api/tags`.
- **Truncation everywhere:** `execFile` maxBuffer caps, `MAX_CHUNK_CHARS 3500`, `MAX_COMMITS 100`, `MAX_COMMIT_DIFF_CHARS 6000` — large diffs are truncated, not rejected.
- **Fault tolerance by design:** `summarizeCommit` swallows Ollama/parse errors and falls back to the commit subject so an entry still appears; per-chunk and per-format failures don't abort the whole run.
- **Cancellation** halts at the next item boundary (`ctx.isCancelled()`); already-produced summaries/reports are not rolled back. Client cancel is dual (server `jobs/cancel` + local abort).
- **Model resolution:** `input.model?.trim()` else server `getModel()` default.
- **`createReviewEntries=false`** produces the four outputs but writes nothing to the review queue.

## Related docs
- Client: [../files/client/pages/ChangelogGenerator.md](../files/client/pages/ChangelogGenerator.md), [../files/client/components/jobs/ChangelogGenMiniPlayer.md](../files/client/components/jobs/ChangelogGenMiniPlayer.md), [../files/client/contexts/ChangelogGenContext.md](../files/client/contexts/ChangelogGenContext.md), [../files/client/services/changelogGen.md](../files/client/services/changelogGen.md)
- Server: [../files/server/routes/changelogGenRoutes.md](../files/server/routes/changelogGenRoutes.md), [../files/server/controllers/ChangelogGenController.md](../files/server/controllers/ChangelogGenController.md), [../files/server/services/ChangelogGenService.md](../files/server/services/ChangelogGenService.md), [../files/server/schemas/changelogGen.schema.md](../files/server/schemas/changelogGen.schema.md), [../files/server/services/ai/AiService.md](../files/server/services/ai/AiService.md), [../files/server/services/ai/prompts.md](../files/server/services/ai/prompts.md), [../files/server/utils/repoAccess.md](../files/server/utils/repoAccess.md), [../files/server/utils/readmeChangelog.md](../files/server/utils/readmeChangelog.md)
- Algorithms: [../algorithms/readme-changelog-parsing.md](../algorithms/readme-changelog-parsing.md)
- API: [../api/server-api-endpoints.md](../api/server-api-endpoints.md) (§12), [../api/client-endpoint-map.md](../api/client-endpoint-map.md)
- Related features: [changelog-management.md](changelog-management.md), [version-management.md](version-management.md)
