# Git Changelog Generator — Audit Verification & Applied Fix

> Companion to [`git_changelog_gen_audit.md`](./git_changelog_gen_audit.md), which is **superseded** by this
> document. Every claim below was checked against the code at `feat/git-changelog-generator`.
> Read this first: the original audit asserts the existence of files and functions that are not in
> the repository.

---

## 1. Intent, as clarified by the project owner

The audit framed the feature as broken-for-multi-tenancy. The actual intent:

- **Purpose.** Automate what is otherwise written by hand — commit messages and changelogs — which is
  slow and comes out inconsistent across a project. The generator reads `git status` / `git diff` /
  `git log` from a **git-tracked working copy** and produces the four outputs.
- **Where git runs.** ATRS runs the git commands itself, automatically, against the chosen working
  directory. No manual paste step, no separate bridge process.
- **Whose path `repoPath` is.** The **developer's own working copy**. ATRS is installed per
  developer, so the machine running the server *is* the developer's machine — the two coincide.
  Describing the field as "a path on the server machine" was the wrong mental model to put in front
  of a user, even though it resolves to the same directory.
- **Tenancy.** Per-user ownership (`ownerId`) **is** the multi-tenancy model. There is no separate
  `Tenant` collection, and one is not required for the isolation guarantees to matter.

Two consequences for the audit:

1. Its **architectural direction was not what was needed.** The remedies in its §§4–7 — a local
   bridge daemon, paste/upload diff, GitHub Compare API as the diff source, per-user Ollama
   credentials — all replace automated local git execution with something more manual or less
   capable. The GitHub Compare path in particular **cannot read uncommitted changes**, which is the
   primary use case.
2. Its **security instinct was right for the wrong reason.** Because per-user ownership is the
   tenancy boundary, the missing ownership checks (§3) were more serious than the audit realised —
   it never looked for them.

---

## 2. Claim-by-claim verdict

| # | Audit claim | Verdict |
|---|---|---|
| Bug 1 | `repoPath` "enforced by `repoAccess.ts`, jails to `REPO_BROWSE_ROOT`" | ❌ **Fabricated, and reality was worse.** `server/src/utils/repoAccess.ts`, `assertRepoPathAllowed`, and `REPO_BROWSE_ROOT` did not exist anywhere in the codebase — the strings appeared *only inside the two audit `.md` files*. The quoted controller snippet was never real code. There was **no jail at all**. |
| Bug 2 | Folder browser exposes the server filesystem, jailed to homedir | ⚠️ **Real, and understated.** `FsController.browseDirs` called `path.resolve(raw)` with zero containment and enumerated drives A:–Z:. Any `requireAuth + requireActive` non-admin could walk the entire host. |
| Bug 3 | `getTags` runs `git` server-side | ✅ **Confirmed as code**, ❌ **wrong impact.** Running git locally is the design. It cannot "return another product's tags"; the actual defect was the missing ownership check beside it. |
| Bug 4 | `eligibleProducts` filter on `repoPath` is wrong gating | ⚠️ **Correct code, wrong diagnosis.** Gating on `repoPath` is right. The real defect was UX: a dead-end empty state with no path to fixing it. |
| Bug 5 | Commented-out `isNoise` duplicated above the live one | ❌ **False.** `ChangelogGenService.ts` had exactly one `isNoise`, live, no commented block. |
| Bug 6 | Ollama config is server-global, not tenant-aware | ➖ **Accurate as fact, not a bug** for a per-developer install. `/api/config` is `requireAdmin`. |
| Bug 7 | The `assertRepoPathAllowed` check "can be bypassed" | ❌ **Vacuous** — describes bypassing a function that did not exist. |
| Bug 8 | One admin cloud key serves all tenants | ➖ **Not the real problem.** The genuine issue is far more urgent — see §7. |

**2 of 8 real, both understated. 4 false or vacuous. 2 describe intended behaviour.**

---

## 3. What the audit missed — the actual critical bug

**Cross-user data exposure (IDOR) in `ChangelogGenController`.** Both handlers looked products up
with an unscoped `Product.findById()`, while *every* other product-scoped service in the codebase
calls `assertOwner` (`GitHubService`, `VersionService`, `IssueService`, `ActivityService`,
`ProductMarketingService`, `ProductService`). The changelog generator was the sole exception — and
since per-user ownership is the tenancy boundary (§1), this punched straight through it.

With only another user's product id, any active user could:

1. **Read another user's repo tags** via `GET /tags/:productId`.
2. **Receive another user's source code** — `generate` streams per-file diffs back over SSE.
3. **Write into another user's review queue** — `ownerId` came from the *fetched* product, so drafted
   entries were persisted under the victim's ownership.

Also missed: `repoPath` was never validated on write, so the folder browser was never the real
attack surface. Typing a path into the product form was enough to make the server run `git`
anywhere it could read.

---

## 4. Access control and correctness — implemented

### Added — `server/src/utils/repoAccess.ts`

The jail the audit assumed already existed, now real:

- `getRepoBrowseRoot()` — `REPO_BROWSE_ROOT`, defaulting to the account's home directory.
- `isInsideRoot()` — lexical containment; boundary-aware (rejects `/repos-evil` against `/repos`),
  case-insensitive on Windows, rejects a different drive letter.
- `isContainedIn()` — the same check over **real** paths, so a symlink or NTFS junction planted
  inside the root cannot be followed out of it.
- `assertRepoPathAllowed()` — throws 400 naming the root; returns the resolved path.
- `assertIsGitRepo()` — replaces a raw `"Git diff failed: …"` from deep in the pipeline with a clear
  "not a Git repository".

### Fixed

| File | Change |
|---|---|
| `controllers/ChangelogGenController.ts` | **`assertOwner` on both handlers** — closes the IDOR. Jails `repoPath` at point of use (rows predating the jail stay unusable). Hoists inline `require()` calls to real imports. |
| `controllers/FsController.ts` | Browsing confined to `REPO_BROWSE_ROOT` via `isContainedIn`; drive enumeration removed; response carries `root` so the UI can state the limit. |
| `services/ProductService.ts` | `repoPath` validated and canonicalised on create **and** update — clearing it stays allowed. |
| `services/ChangelogGenService.ts` | `--since="…"` → `--since=…`. `execFile` uses no shell, so those quotes were never stripped; git tolerated them only because approxidate skips characters it cannot parse. **Cleanup, not a behaviour change** — verified identical results across six date formats. |
| `models/Product.ts` | `repoPath` doc comment no longer credits the removed code-activity tracker. |

### UI wording

The field described itself as "Absolute path on the server machine", which is the wrong mental model
(§1). It now reads **"on your machine (where ATRS runs)"** across the product form, the folder
picker, and the generator's empty state — and the dead-end empty state became a callout linking to
Products.

`RepoPathBrowser` was **kept**, not deleted as the audit proposed. It browses the developer's own
machine, which is the point. Deleting it would not have fixed anything either: the vulnerability was
the unvalidated `repoPath`, which the form accepts by typing.

---

## 5. `.atrsignore` — scoping the AI's context

**Requirement:** the model should receive source files only — not build output, bundles, vendored
dependencies, `node_modules`, or tests — configurable via a `.atrsignore` file.

The old `isNoise()` was a hardcoded regex covering lockfiles, `*.map`, `*.min.*`, `node_modules/`
and `.git/`. It missed `dist/`, `build/`, `vendor/`, and tests, and could not be tuned per repo.

**Added — `server/src/utils/atrsIgnore.ts`.** Full reference: [`atrsignore.md`](./atrsignore.md).

- `DEFAULT_ATRSIGNORE_PATTERNS` — dependencies, build/release output, bundles and minified assets,
  lockfiles across five ecosystems, tests, VCS internals.
- `loadAtrsIgnore(repoPath)` — defaults first, then the repo's own `.atrsignore` layered on top.
  Gitignore semantics via the `ignore` package (now an explicit server dependency rather than the
  transitive one that happened to be present), so **last match wins** and a repo can re-include
  anything a default dropped with `!`.
- Path normalisation for Windows separators and a leading `./`.
- The pipeline emits the filter result in its progress log, naming whether a `.atrsignore` was used
  and how many rules it contributed — so a missing file in the output is diagnosable.

`isNoise()` is gone; `gitAnalyze` filters through the matcher.

### Why it matters, measured

Run against the real `offcanvas-block` plugin: **275 tracked files, 214 dropped (78%)** — almost
entirely the vendored Freemius SDK under `vendor/`, plus `package-lock.json`. Without the `vendor/`
rule, a release touching a handful of source files would have the model reading and summarising
third-party SDK code as the plugin's own work.

Note that `git diff --name-status` only reports **tracked** files, so a repo that gitignores its
build output sees little effect. The rules earn their keep on repos that *commit* build artefacts or
vendored code for distribution — the norm for WordPress plugins.

---

## 6. Per-user independence — verified

The generator must be independent per user: each user points a product at a working copy on their own
machine, and generating reads *that* repo through *that* repo's `.atrsignore`. Verified end to end by
[`ChangelogGenController.isolation.test.ts`](../server/src/controllers/ChangelogGenController.isolation.test.ts),
which builds **two real git repos** owned by two different users and checks the boundary from both
directions.

| Layer | Scoped per user? | Evidence |
|---|---|---|
| `repoPath` | ✅ | Field on `Product`; products carry `ownerId` |
| Reading tags | ✅ | Alice's product returns `v1.0.0`, Bob's returns `v9.9.9` |
| Cross-user read | ✅ blocked | Alice requesting Bob's product → 404, and the message contains neither Bob's tag nor his path |
| Cross-user generate | ✅ blocked | Rejected before the SSE stream opens (`headersSent === false`), so no diff can escape |
| Unauthenticated | ✅ blocked | 404 |
| `.atrsignore` | ✅ | Same relative path, opposite verdicts: Alice's repo drops `dist/bundle.js` by default while Bob's `!dist/` re-includes it; Bob's `notes/` rule drops `notes/todo.md` while Alice keeps it |
| AI + outputs | ✅ | Driven entirely by the files that survive the per-repo filter |
| Review queue | ✅ | `persistReviewEntries` upserts under the product's `ownerId` |
| Path validation | ✅ | Out-of-root → 400; not-a-git-repo → 400; empty → 400 |

Admins deliberately pass the ownership check, matching `assertOwner` everywhere else in the codebase.
If ATRS ever becomes a hosted product where operators must *not* read tenant source, that convention
is the thing to revisit — it is a codebase-wide decision, not specific to this feature.

### One gap: the browse root is instance-wide, not per-user

`REPO_BROWSE_ROOT` is a single value for the whole install, so a shared instance serving developers
with separate home directories forces a choice. Measured:

```text
REPO_BROWSE_ROOT = alice's home        REPO_BROWSE_ROOT = the parent of both homes
  alice repo : ALLOWED                   alice repo : ALLOWED
  bob repo   : BLOCKED                   bob repo   : ALLOWED
```

Narrow, and only one developer can use the feature. Wide, and each can list the other's folder
*names* through the picker (never file contents, and never another user's repo *data* — that stays
blocked by the ownership check above).

**This does not affect the per-developer install**, where each person runs their own ATRS and the
root is their own home directory — the intended shape, and the case the tests model.

**If one shared instance ever needs to serve several developers**, the fix is a per-user root:
`repoRoot?: string` on `User` (admin-settable, falling back to `REPO_BROWSE_ROOT`), threaded through
`assertRepoPathAllowed(path, user)` and `browseDirs`. Both call sites already have `req.user`, so the
change is contained — it needs a User field plus a small admin UI, which is why it is flagged rather
than assumed.

---

## 7. Credential hygiene — the committed API key, now remediated

Found incidentally: `app.config.json` is **git-tracked and not gitignored**, and carries
`changelogGen.ollamaCloudKey` in cleartext.

- The key committed at `HEAD` is real. Earlier values are in history (`2a4fadc`, `689eb6a`).
- The working tree currently holds a **second, different** key — so at least two live credentials
  have existed in this file.
- A commit named `chor: vercel deploy` suggests the repo has been pushed to a remote.

Contrast `githubToken`, which is encrypted at rest on the `User` model and `select: false`. The
Ollama key gets none of that treatment.

### Done

| Change | Detail |
|---|---|
| **Untracked** | `git rm --cached app.config.json` and added to `.gitignore`. The working file is untouched — the live config, including branding and the key, still loads. |
| **Example committed** | `app.config.example.json` with neutral defaults (`ollamaMode: local`, no key, no branding). README's setup step now mirrors the existing `cp .env.example .env` convention. |
| **Env var** | `OLLAMA_CLOUD_KEY` takes precedence over the config file; `OLLAMA_CLOUD_URL` likewise for the endpoint. Verified: env value wins, and a pasted `…/api/generate` suffix is still normalised away. |
| **Scrubbed from the API** | `getConfig` and `updateConfig` both return `ollamaCloudKeySet` / `ollamaCloudKeyFromEnv` booleans instead of the key. It previously round-tripped in cleartext to the admin browser, where `Settings.tsx` loaded it into a form field. |
| **Write-only semantics** | An absent or empty key on write keeps the stored value, so saving any other setting no longer wipes the credential; the literal string `null` clears it deliberately. |
| **UI** | The Settings field shows "Stored — leave blank to keep it", and goes read-only with "Set by OLLAMA_CLOUD_KEY" when the env var is present. |

Verified against the live config: `GET` no longer carries the key, saving an unrelated setting
preserves it, `null` clears it, and the file was restored byte-identical afterwards.

### Still yours to do

1. **Revoke both keys at ollama.com.** This is the one that matters and code cannot do it — the keys
   are in git history, so rotating without revoking leaves the old one valid.
2. **If the repo was ever pushed** (the `chor: vercel deploy` commit suggests it was), scrub history
   with `git filter-repo` and force-push, or treat both keys as permanently public.

Untracking prevents *future* commits; it does not remove what is already in history.

---

## 8. Incidental fix — control bytes embedded in sanitisation code

`ConfigController.ts` contained a **literal NUL byte** (offset 6612), which is why `grep` reported it
as binary and refused to search it. The branding validator's character class had been written with
raw control bytes instead of escapes:

```text
v.replace(/[<NUL>-<US><DEL>]/g, '')     // what the file actually contained
```

It behaved correctly, but the sanitisation was one careless editor save away from silently widening
or emptying that class — in code whose job is stripping control characters out of values that get
written into `.env`. Replaced with a `stripControlChars()` helper in `utils/sanitize.ts`, alongside
the existing `hasControlChars()`, with tests asserting the two agree across the whole low range. The
file is now plain text and greppable.

---

## 9. Deliberately not done

- **Local bridge daemon, paste/upload diff, GitHub Compare API diff source** — all replace automated
  local git execution with something more manual or less capable, and the GitHub path cannot see
  uncommitted changes at all (§1).
- **Per-user Ollama URL/key on `User`** — the real credential problem is §6, which per-user storage
  would not solve.
- **Removing `repoPath` from `Product`** — it is the feature's mechanism, not a legacy field.

---

## 10. Verification performed

- **`server`: 95 tests pass (10 files), 53 new** — 16 for the path jail, 8 for the browse endpoint,
  13 for `.atrsignore`, 10 for per-user isolation, 6 for control-character stripping. Covers traversal, root-prefix siblings, cross-drive paths, Windows
  case-insensitivity, system directories, a real NTFS junction escape (junction creation confirmed
  working on the test machine, so that case genuinely runs rather than skipping), default rule
  categories, `.atrsignore` layering, and negation re-inclusion.
- **`tsc --noEmit` clean on both workspaces.**
- **Integration-checked against two real repos** — ATRS itself (82 changed files over 8 commits:
  drops `package-lock.json` and a `.test.ts`) and `offcanvas-block` (§5).
- **Module load smoke-tested** — no import cycles from the new utils.
- **`eslint`** on the touched client files: 33 problems before → 32 after. No new violations; the
  remainder is the repo-wide pre-existing `no-explicit-any` baseline (399 across the client).

### Operator note

`REPO_BROWSE_ROOT` defaults to the account's home directory, which is right for a per-developer
install and covers repos under `~`. If ATRS is ever run somewhere shared, narrow it to the directory
that actually holds the repos — the default still lets any active user list folder *names* beneath
that home directory.
