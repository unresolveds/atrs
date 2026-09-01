# Git Changelog Generator — Audit & Fix Plan

> [!CAUTION]
> **Superseded — this document is inaccurate.** See
> [`git_changelog_gen_audit_verification.md`](./git_changelog_gen_audit_verification.md) for the
> claim-by-claim verdict and the fix that was actually applied.
>
> In short: `repoAccess.ts` / `assertRepoPathAllowed` / `REPO_BROWSE_ROOT` — quoted below as existing
> code — were **not in the repository**. Of 8 listed bugs, 2 were real (both understated), 4 false or
> vacuous, and 2 describe intended behaviour.
>
> The audit also missed the actual critical defect: an unscoped `Product.findById()` in
> `ChangelogGenController` exposing other users' repo tags, source diffs, and review queues — which
> matters *more* than the audit supposed, since per-user ownership is the tenancy boundary.
>
> Its proposed remedies (§§4–7 — bridge daemon, paste/upload diff, GitHub Compare API, per-user
> Ollama credentials) were **not** implemented: ATRS is meant to run git locally and automatically,
> and the GitHub path cannot read uncommitted changes at all. Kept for the record.

> **Purpose**: Document every specific flaw in the current implementation and propose a correct redesign. No code written in this document.

---

## 1. What the Feature Is Supposed to Do

The Git Changelog Generator should:
1. Analyze git commit history or uncommitted diffs in **a developer's local repo** (on their PC)
2. Send the diff through an Ollama AI model
3. Produce **four outputs**: Developer Changelog · User Release Notes · GitHub Release Notes · QA Checklist
4. Optionally push AI-drafted entries to the **review queue** per product, per tenant

---

## 2. The Core Architectural Flaw — Identical to SVN

The entire feature was built on one wrong assumption:

> **"The product's git repo is on the server machine"**

This is encoded in the `repoPath` field on [`Product.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/models/Product.ts#L14) and enforced by [`repoAccess.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/utils/repoAccess.ts) which jails paths to `REPO_BROWSE_ROOT` (defaulting to the server's `os.homedir()`).

In a **multi-tenant deployment**, each tenant's repo lives on **their own PC** — not on the server. This is the same constraint as the SVN working copy.

---

## 3. Bug Inventory — Every Specific Problem

### Bug 1 — `repoPath` is a server-local filesystem path (Critical)

**Where**: [`Product.ts#L14`](file:///C:/Users/suzan/Desktop/ATRS/server/src/models/Product.ts#L14), [`ChangelogGenController.ts#L24-L35`](file:///C:/Users/suzan/Desktop/ATRS/server/src/controllers/ChangelogGenController.ts#L24-L35)

```ts
// ChangelogGenController.ts — runs git on the SERVER
const product = await Product.findById(productId).select('name repoPath ownerId').lean();
assertRepoPathAllowed(product!.repoPath);  // jails to server's homedir
// ...
repoPath: product.repoPath!,  // this path is on the SERVER, not the tenant's PC
```

**Impact**: For multi-tenant ATRS deployed in the cloud (or even a shared LAN server), Tenant A's `repoPath` is a path on the server machine. Tenant A can't even set it correctly because their repo is on their local `C:\plugins\...`, not on the server's filesystem.

**Correct model**: The server should never run `git` against a path it fetched from the database. The git commands must run on the client's machine or the diff must be pushed to the server.

---

### Bug 2 — The Folder Browser Exposes the SERVER Filesystem (Security + UX)

**Where**: [`RepoPathBrowser.tsx`](file:///C:/Users/suzan/Desktop/ATRS/client/src/components/products/RepoPathBrowser.tsx), [`ProductForm.tsx#L208-L210`](file:///C:/Users/suzan/Desktop/ATRS/client/src/components/products/ProductForm.tsx#L208-L210)

```tsx
// ProductForm.tsx — the hint text tells the truth accidentally
<p className="text-xs text-muted-foreground">
  Absolute path on the server machine. Used by the Git Changelog Generator to read this
  product's repository. Click Browse to pick a folder.
</p>
```

The "Browse" button opens [`RepoPathBrowser`](file:///C:/Users/suzan/Desktop/ATRS/client/src/components/products/RepoPathBrowser.tsx) which calls `browseDirs()` — an API that **walks the server's filesystem** and returns directory listings. The dialog title even says `"Browse folders on the server machine"`.

**Impact (multi-tenant)**:
- Any authenticated user (not just admin) can browse the entire server filesystem up to `REPO_BROWSE_ROOT`
- They see directories that belong to other tenants or system paths
- The `REPO_BROWSE_ROOT` env var has no default narrower than `os.homedir()` — a large surface area
- The folders shown are **meaningless** to a tenant — they don't correspond to anything on the tenant's own machine

**This component must be removed entirely from the multi-tenant path.**

---

### Bug 3 — `getTags` Also Runs git on the Server (Same Root Cause)

**Where**: [`ChangelogGenController.ts#L64-L82`](file:///C:/Users/suzan/Desktop/ATRS/server/src/controllers/ChangelogGenController.ts#L64-L82)

```ts
// Runs: git tag --sort=-creatordate in the server-side repoPath
const { stdout } = await execFileP('git', ['tag', '--sort=-creatordate'], {
  cwd: product!.repoPath,
  timeout: 10_000,
});
```

The tag dropdown in [`ChangelogGenerator.tsx#L85-L88`](file:///C:/Users/suzan/Desktop/ATRS/client/src/pages/ChangelogGenerator.tsx#L85-L88) fetches tags from a server-executed `git tag` command. In multi-tenant, this either:
- Returns empty (no repo at the server path), or
- Returns tags from a completely different product's repo if paths happen to overlap

---

### Bug 4 — `eligibleProducts` Filters to Products with `repoPath` Set (Wrong Gating)

**Where**: [`ChangelogGenerator.tsx#L83`](file:///C:/Users/suzan/Desktop/ATRS/client/src/pages/ChangelogGenerator.tsx#L83)

```ts
const eligibleProducts = products.filter((p: any) => p.repoPath);
```

This means a product is only "eligible" for the generator if it has a **server-local path** set. In a multi-tenant world, most products will correctly have `repoPath: ''` (no server path), so the generator appears to show **no eligible products** — even though the tenant has perfectly valid local repos. The feature appears broken even when it "works."

---

### Bug 5 — Dead Code / Comment Debris in `isNoise()` (Code Quality)

**Where**: [`ChangelogGenService.ts#L39-L78`](file:///C:/Users/suzan/Desktop/ATRS/server/src/services/ChangelogGenService.ts#L39-L60)

```ts
// function isNoise(filePath: string): boolean {  ← ENTIRE FUNCTION COMMENTED OUT
//   const lower = filePath.toLowerCase();
//   return (
//     ...
//   );
// }
function isNoise(filePath: string): boolean {   ← THEN DUPLICATED LIVE BELOW
```

The old commented-out `isNoise` block sits immediately above the live one. It's dead code that creates confusion about which noise filter is active.

---

### Bug 6 — Ollama Config is Server-Global, Not Tenant-Aware

**Where**: [`ChangelogGenController.ts#L94-L108`](file:///C:/Users/suzan/Desktop/ATRS/server/src/controllers/ChangelogGenController.ts#L94-L108), [`utils/ollama.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/utils/ollama.ts)

The Ollama model and endpoint are read from `app.config.json` (a server-global file, admin-controlled). In a multi-tenant deployment:
- Tenant A might want `llama3:latest`, Tenant B wants `gemma3:latest`
- One admin controls the model for all tenants
- The `model` override in `GenerateInput` partially mitigates this, but Ollama **URL + auth key** are still global

**Impact**: If ATRS is deployed as a true SaaS, different tenants cannot connect to their own Ollama instances.

---

### Bug 7 — `generateChangelogSchema` Accepts `repoPath` from Any Authenticated User

**Where**: [`changelogGen.schema.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/schemas/changelogGen.schema.ts)

The schema validates only `productId`, `rangeType`, `from`, `to`, `model` — and `repoPath` is pulled from the product record server-side. But the `assertRepoPathAllowed` check in the controller can be bypassed if someone sets their product's `repoPath` to a path they guessed. There's no per-tenant path validation — only the global `REPO_BROWSE_ROOT` jail.

---

### Bug 8 — Olamma URL for Cloud Mode Exposes Private API Keys Globally

**Where**: [`ConfigController.ts#L37-L45`](file:///C:/Users/suzan/Desktop/ATRS/server/src/controllers/ConfigController.ts#L37-L45)

```ts
// Admin sets one cloud Ollama key for ALL tenants
data.changelogGen = {
  ...data.changelogGen,
  ollamaCloudUrl: data.changelogGen.ollamaCloudUrl || process.env.OLLAMA_CLOUD_URL || '',
  ollamaCloudKey: '',          // scrubbed from response
  ollamaCloudKeySet: hasKey,   // but all tenants use this same key
}
```

One admin's cloud API key is used for ALL tenants' AI generation. Cost attribution and per-tenant rate limiting are impossible.

---

## 4. What Needs to Change — The Correct Architecture

The fix follows the same push-model logic established in the SVN audit. The server's job is:
- **Receive** git data pushed from the client
- **Run AI** against that data (Ollama is server-side, fine)
- **Store** results (review queue entries, per-tenant, per-product)

The client's job is:
- **Run `git diff` / `git log` / `git tag`** locally (the repo is on their PC)
- **Send the output** to the ATRS API

```
Current (broken)                      Correct
──────────────────────────            ──────────────────────────────────────
Tenant sets repoPath on server   →    Tenant runs git locally
Server runs: git diff               Server receives: diff text via API
Server runs: git tag                Client runs: git tag → sends list to UI
Server browsers: server dirs         RepoPathBrowser → REMOVED
"No eligible products"               Any product is eligible (GitHub URL = enough)
```

---

## 5. The Three Viable Input Methods (Client-Side Git)

### Method A — Browser-Side `git` via a Local Bridge (Full Automation)

A background process running on the developer's PC runs `git diff`, `git log`, `git tag` and streams the raw output to the ATRS API.

```
Dev's PC:                                ATRS Server:
atrs-bridge (node script)
├── runs: git diff HEAD                  POST /api/changelog-gen/generate-from-diff
├── runs: git log --format=... -20       body: { diff, commitMessages[], productId, rangeType }
└── streams diff → ──────────────────→  Server runs Ollama on the received diff
                                         Server writes review queue entries
```

**Touch points**:
- New `POST /api/changelog-gen/generate-from-diff` endpoint — accepts raw diff text instead of a server-side `repoPath`
- [`ChangelogGenService.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/services/ChangelogGenService.ts): extract `gitAnalyze()` behind an interface so it can accept pre-parsed `ChangedFile[]` instead of a `repoPath`
- Remove `repoPath` from `GenerateInput`; replace with `{ files: ChangedFile[], commitMessages: string[] }`
- Keep Stages 2–5 entirely unchanged (classify, summarize, report, persist)

---

### Method B — Paste / Upload Diff (Manual, Zero Infrastructure)

User runs `git diff HEAD > changes.patch` or `git log -p > history.patch` locally, then pastes or uploads the file into ATRS.

```
ATRS ChangelogGenerator page:
  ├── Tab 1: "Paste Diff" — textarea for git diff output
  ├── Tab 2: "Upload Patch" — file input for .patch file
  └── Tab 3: (future) "From Bridge" — connected bridge
```

**Touch points**:
- New `diffText` field in the API request alongside `rangeType` (no `repoPath` needed)
- Client-side diff parser: split unified diff by `diff --git` headers → array of `ChangedFile`
- Server receives parsed files, runs existing Stages 2–5 unchanged

---

### Method C — GitHub API as the Diff Source (Already Works!)

ATRS already has a GitHub token per user in [`User.ts#L29`](file:///C:/Users/suzan/Desktop/ATRS/server/src/models/User.ts#L29). For products with a `githubUrl`, the server can:
- Call GitHub's Comparison API: `GET /repos/{owner}/{repo}/compare/{from}...{to}`
- Receive the diff without needing the local repo
- Feed it through the existing pipeline

**Touch points**:
- [`GitHubService.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/services/GitHubService.ts): add `getCompareDiff(owner, repo, from, to, token)` method
- [`ChangelogGenController.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/controllers/ChangelogGenController.ts): if product has `githubUrl` and no local diff, use GitHub API
- [`ChangelogGenerator.tsx`](file:///C:/Users/suzan/Desktop/ATRS/client/src/pages/ChangelogGenerator.tsx): show GitHub-sourced diff option for products with `githubUrl`

**Best for**: commit ranges and tag-to-tag diffs. **Cannot do**: working-tree (uncommitted) changes.

---

## 6. Complete Touch-Point Map for the Fix

### Remove / Retire

| File | What to Remove | Reason |
|---|---|---|
| [`RepoPathBrowser.tsx`](file:///C:/Users/suzan/Desktop/ATRS/client/src/components/products/RepoPathBrowser.tsx) | Entire component | Browses server filesystem — wrong in multi-tenant |
| [`ProductForm.tsx#L189-L221`](file:///C:/Users/suzan/Desktop/ATRS/client/src/components/products/ProductForm.tsx#L189) | `repoPath` field + browser | Replace with `githubUrl` note |
| [`Product.ts#L14,41`](file:///C:/Users/suzan/Desktop/ATRS/server/src/models/Product.ts#L14) | `repoPath` field | Or keep for backwards-compat, but stop using it as git CWD |
| [`repoAccess.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/utils/repoAccess.ts) | `assertRepoPathAllowed` | No longer executing git server-side |
| [`ChangelogGenController.ts#L9,29,35`](file:///C:/Users/suzan/Desktop/ATRS/server/src/controllers/ChangelogGenController.ts#L9) | `assertRepoPathAllowed` calls | |
| [`ChangelogGenController.ts#L64-L82`](file:///C:/Users/suzan/Desktop/ATRS/server/src/controllers/ChangelogGenController.ts#L64) | `getTags` endpoint (server git) | Replace with GitHub API tags or client-supplied list |
| [`ChangelogGenService.ts#L39-L60`](file:///C:/Users/suzan/Desktop/ATRS/server/src/services/ChangelogGenService.ts#L39) | Commented-out `isNoise` block | Dead code cleanup |

### Modify

| File | Change |
|---|---|
| [`ChangelogGenService.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/services/ChangelogGenService.ts) | Split `gitAnalyze()` out; `runPipeline()` accepts pre-parsed `{ files, commitMessages }` instead of `repoPath` |
| [`changelogGen.schema.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/schemas/changelogGen.schema.ts) | Add `diffText?: string` and `commitMessages?: string[]` to body; remove `repoPath` dependency |
| [`ChangelogGenController.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/controllers/ChangelogGenController.ts) | Route `generate`: accept diff text; route `getTags`: proxy to GitHub API if product has `githubUrl` |
| [`ChangelogGenerator.tsx`](file:///C:/Users/suzan/Desktop/ATRS/client/src/pages/ChangelogGenerator.tsx) | Replace product eligibility filter; add diff input methods (paste/upload/GitHub) |
| [`GenerateInput` type](file:///C:/Users/suzan/Desktop/ATRS/server/src/services/ChangelogGenService.ts#L85) | Replace `repoPath: string` with `diffText?: string` + `files?: ChangedFile[]` + `commitMessages?: string[]` |

### Add

| File | What |
|---|---|
| New `POST /api/changelog-gen/generate-from-diff` | Accepts raw diff + commit messages; parses → runs pipeline Stages 2–5 |
| [`GitHubService.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/services/GitHubService.ts) | `getCompareDiff(owner, repo, base, head, token)` using GitHub Compare API |
| New `GET /api/changelog-gen/github-tags/:productId` | Uses GitHub API (user's stored token) to list tags — replaces server-side `git tag` |

---

## 7. The Ollama Multi-Tenancy Fix (Secondary)

Per-tenant Ollama configuration should be stored on the **User** model, not in the global `app.config.json`:

```diff
// User.ts — add optional per-user Ollama override
+ ollamaUrl?: string;       // e.g. http://localhost:11434 or cloud endpoint
+ ollamaApiKey?: string;    // encrypted at rest (same pattern as githubToken)
+ ollamaModel?: string;     // default model for this user
```

Resolution order:
1. **Request-level**: `model` override in the API body (already exists ✅)
2. **User-level**: `user.ollamaModel` / `user.ollamaUrl` (new)
3. **Global**: `app.config.json` `changelogGen.*` (existing fallback)

---

## 8. What Stays Unchanged (Already Correct)

| Component | Status |
|---|---|
| Stages 2–5 of the pipeline (classify, summarize, report, review queue) | ✅ Correct — pure data processing |
| Ollama HTTP calls (`summarizeChunk`, `generateReport`) | ✅ Correct — server→Ollama is right |
| `persistReviewEntries` (MongoDB upsert with `ownerId` scope) | ✅ Correct — properly tenant-isolated |
| SSE streaming infrastructure (`sseStream.ts`, `ChangelogGenContext`) | ✅ Correct — keep as-is |
| `ChangelogGenMiniPlayer` (background progress) | ✅ Correct |
| Review queue → [`Review.tsx`](file:///C:/Users/suzan/Desktop/ATRS/client/src/pages/Review.tsx) flow | ✅ Correct |

---

## 9. Migration Path (What Breaks for Existing Users)

> [!WARNING]
> Existing products with `repoPath` set will lose that field's functionality. If ATRS is currently used in single-developer mode (one user, server = dev machine), the current code technically works. The rewrite is needed only when deploying multi-tenant.

**Migration options**:
- Keep `repoPath` on the model but mark it `@deprecated` — show a UI warning "This path is only valid if ATRS runs on the same machine as your repo"
- For the GitHub-backed option: auto-detect products with `githubUrl` and offer that as a drop-in replacement
- Provide the bridge script for users who want to keep local-first operation

---

## 10. Priority Order for Fixing

```
P0 — Remove the security issue
  └── Remove or gate RepoPathBrowser (stop exposing server filesystem)
      Files: RepoPathBrowser.tsx, ProductForm.tsx, FsController.ts

P1 — Make the feature work for multi-tenant (GitHub API path — zero new infra)
  ├── GitHubService.getCompareDiff()
  ├── New generate-from-diff endpoint (accepts diff text, no repoPath)
  ├── ChangelogGenService: decouple gitAnalyze from repoPath
  └── ChangelogGenerator.tsx: add GitHub source option

P2 — Paste/upload diff (Method B — simplest for any tenant)
  ├── Add diffText field to schema + controller
  └── UI: textarea + file upload in ChangelogGenerator.tsx

P3 — Clean up dead code
  └── Remove commented-out isNoise block in ChangelogGenService.ts

P4 — Per-tenant Ollama (nice-to-have for SaaS mode)
  └── ollamaUrl + ollamaModel on User model
```
