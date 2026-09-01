# SVN Integration — Revised Possibility Audit
### Constraint-Compliant Edition

> [!CAUTION]
> The previous audit was **architecturally wrong**. It proposed running `svn` CLI commands on the ATRS server — but the SVN working copy lives on each **tenant's local PC**. The server cannot execute commands against a client machine. This document replaces the previous audit entirely.

---

## 1. The Two Constraints That Change Everything

### Constraint A — SVN Working Copy is Client-Side
```
Tenant's PC                         ATRS Server (shared)
────────────────────                ──────────────────────────────
C:\plugins\my-plugin\   ← svn wc   MongoDB (multi-tenant data)
  trunk/                            Products (ownerId scoped)
  tags/                             Versions (ownerId scoped)
  branches/                         Activities (ownerId scoped)
TortoiseSVN GUI                     AuditLogs
svn CLI                             API (JWT auth per user)
```

The server **has no path** to the client's working copy. It cannot call `svn commit`, `svn update`, or `svn status` on behalf of a tenant.

### Constraint B — ATRS is Multi-Tenant
Looking at [`ownership.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/utils/ownership.ts) and [`User.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/models/User.ts):
- Every Product, Activity, Version is scoped by `ownerId`
- Users with role `user` see only their own data
- Admins see all tenants
- `githubToken` is already stored per-user (encrypted) for GitHub integration

So even if we stored SVN credentials, they'd be per-user, per-product — not a shared server credential.

---

## 2. What the Existing Git Pipeline Actually Is (and Why It Doesn't Scale to Multi-Tenant)

The existing `ChangelogGenService` uses `repoPath` — a **server-side filesystem path**:

```ts
// repoAccess.ts — the "jail" for git execution
export function getRepoRoot(): string {
  return path.resolve(process.env.REPO_BROWSE_ROOT || os.homedir());
}
```

This works today because **ATRS is likely deployed as a personal/team tool** where the server and the developer's repos are on the **same machine** (or same LAN). The `REPO_BROWSE_ROOT` env var jails the path to `~` by default.

> [!IMPORTANT]
> For true multi-tenant cloud deployment, even the existing Git Changelog Generator has this same constraint problem — `repoPath` must point to something the **server process** can see. The SVN audit must solve for the same reality.

---

## 3. Valid Integration Patterns (SVN Working Copy on Client PC)

There are three viable approaches. They are not mutually exclusive.

---

### Pattern A — SVN Post-Commit Hook → ATRS Webhook

**How it works**: The developer configures a post-commit hook in their local SVN working copy (or on their SVN server if they self-host). The hook fires on every `svn commit` and sends an HTTP POST to the ATRS API.

```
Developer runs: svn commit -m "Fix: button alignment"
        ↓
SVN triggers: post-commit hook
        ↓
Hook script: curl -X POST https://your-atrs/api/svn/webhook \
               -H "Authorization: Bearer <token>" \
               -d '{ "revision": 142, "author": "suzan", "message": "Fix: button alignment", "productId": "..." }'
        ↓
ATRS Server: creates Activity + Version entry + AuditLog
```

**Touch points in ATRS:**

| Layer | File | Change |
|---|---|---|
| Server route | New `svnRoutes.ts` | `POST /api/svn/webhook` — unauthenticated with per-product token OR JWT |
| Server controller | New `SvnController.ts` | Parse revision, message, author; map to product |
| Server service | Extends `ActivityService.ts` | Auto-create Activity from commit message |
| Server model | [`Version.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/models/Version.ts) | Add `source: 'svn'`, `svnRevision: number` |
| Client UI | [`ProductDetails.tsx`](file:///C:/Users/suzan/Desktop/ATRS/client/src/pages/ProductDetails.tsx) | "SVN Webhook Setup" tab — show token, copy hook script |

**Hook script example** (what ATRS would generate for the user to paste):

```bash
#!/bin/bash
# post-commit hook for my-plugin → ATRS
REPOS="$1"
REV="$2"
AUTHOR=$(svnlook author "$REPOS" -r "$REV")
MESSAGE=$(svnlook log "$REPOS" -r "$REV")
curl -s -X POST "https://your-atrs.example.com/api/svn/webhook" \
  -H "Content-Type: application/json" \
  -H "X-ATRS-Product-Token: <per-product-webhook-token>" \
  -d "{\"revision\": $REV, \"author\": \"$AUTHOR\", \"message\": $(echo "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}"
```

**Feasibility**: ✅ High  
**Multi-tenant compliant**: ✅ Yes — each tenant has their own per-product webhook token  
**Server runs svn**: ❌ No — never touches client machine  
**Works with TortoiseSVN**: ✅ Yes — TortoiseSVN supports hook scripts  
**Works with self-hosted SVN**: ✅ Yes (VisualSVN, SVNServe, Apache mod_dav_svn)  
**Works with WP.org SVN**: ⚠️ Partial — WP.org only allows `post-commit` hooks if they host it  

---

### Pattern B — Client-Side ATRS Local Bridge (Background Process on Dev PC)

**How it works**: A small background process (Node.js script or Electron shell) runs on the developer's PC. It watches the SVN working copy for changes, runs `svn status` / `svn log` locally, and pushes structured data to the ATRS API.

```
Developer's PC                          ATRS Server
──────────────────────────────          ─────────────────────
atrs-bridge (background daemon)
  ├── watches C:\plugins\my-plugin\
  ├── on change: runs svn status
  ├── on commit detection: runs svn log -r HEAD
  └── POST /api/svn/push → ─────────────────────→ stores Activity/Version
```

**Feasibility**: ✅ Medium  
**Multi-tenant compliant**: ✅ Yes — bridge authenticates with each user's JWT  
**Server runs svn**: ❌ No  
**Complexity**: Higher — requires distributing and running a separate process per developer  
**Upside**: Rich data — can capture `svn diff` locally and send to ATRS for AI processing  

---

### Pattern C — Manual SVN Log Import (Paste / Upload)

**How it works**: Developer runs `svn log --xml -l 50 > recent.xml` locally and pastes or uploads the XML into ATRS. ATRS parses it and creates Activities/Versions.

```
Developer: svn log --xml --verbose -l 20 > svn-export.xml
              ↓  uploads to ATRS
ATRS UI: parses XML → shows preview → user confirms → creates entries
```

**Touch points:**

| Layer | File | Change |
|---|---|---|
| Client page | New tab in [`Activities.tsx`](file:///C:/Users/suzan/Desktop/ATRS/client/src/pages/Activities.tsx) or [`ProductDetails.tsx`](file:///C:/Users/suzan/Desktop/ATRS/client/src/pages/ProductDetails.tsx) | "Import from SVN log" — XML paste/upload + preview |
| Server route | Extends `activityRoutes.ts` | `POST /api/activities/import-svn-log` |
| Server service | Extends `ActivityService.ts` | Parse `svn log --xml` format, de-duplicate by revision |
| Server model | [`Version.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/models/Version.ts) | `source: 'svn'` + `svnRevision` |

**Feasibility**: ✅ Very High — simplest server change  
**Multi-tenant compliant**: ✅ Yes — purely REST API, JWT-scoped per user  
**Server runs svn**: ❌ Never  
**UX friction**: Higher — manual step, but familiar to WP plugin developers  
**Bonus**: Works even with WP.org SVN because anyone can run `svn log` locally  

---

## 4. Feature Matrix Under Correct Architecture

| SVN Feature | Pattern A (Hook) | Pattern B (Bridge) | Pattern C (Manual) | Notes |
|---|---|---|---|---|
| **svn commit** detection | ✅ Hook fires on commit | ✅ Bridge detects | ✅ Import after commit | A is most automatic |
| **svn log** history | ⚠️ Only new commits | ✅ Reads full history | ✅ Full history import | C captures backfill |
| **svn status** (working tree) | ❌ Not applicable | ✅ Bridge reads live | ❌ Not applicable | Only B is live |
| **svn diff** → AI changelog | ❌ | ✅ Bridge sends diff | ✅ Paste diff manually | B can feed existing AI pipeline |
| **svn update** detection | ⚠️ No hook for update | ✅ Bridge detects | ❌ | |
| **svn checkout** | ❌ Server can't do it | ❌ User does it locally | ❌ User does it locally | ATRS just records it |
| **svn revert** | ❌ | ⚠️ Could detect | ❌ | Rarely worth tracking |
| **WP.org tag detection** | ✅ Already works (WebDAV) | ✅ Already works | ✅ Already works | Existing code untouched |

---

## 5. The Existing WP.org SVN Code — Already Correct

The existing SVN code in [`ProductService.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/services/ProductService.ts#L241-L362) is **already architecturally correct**:

```
ATRS Server → HTTP PROPFIND → plugins.svn.wordpress.org (public, read-only)
```

This is a **server-to-remote** HTTP call against WordPress.org's public WebDAV API. It does not touch the tenant's local machine. **Keep it exactly as-is.**

What it can **never** do: interact with a tenant's private local working copy. That's Pattern A/B/C territory.

---

## 6. What Needs to Change in the Data Model

### [`Version.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/models/Version.ts)

```diff
- source?: 'manual' | 'github';
+ source?: 'manual' | 'github' | 'svn';
+ svnRevision?: number;        // SVN revision number that created this version
+ svnPath?: string;            // e.g. /tags/1.2.0 within the repo
```

### [`Product.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/models/Product.ts)

```diff
+ svnRepoUrl?: string;         // canonical SVN URL (may differ from wpOrgSlug for private repos)
+ svnWebhookToken?: string;    // per-product secret for Pattern A webhook receiver
```

### [`Activity.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/models/Activity.ts)

```diff
+ svnRevision?: number;        // link back to the SVN commit that generated this
```

### [`User.ts`](file:///C:/Users/suzan/Desktop/ATRS/server/src/models/User.ts)
*(mirrors the existing `githubToken` pattern)*

```diff
+ svnUsername?: string;        // WP.org or private SVN username (display only)
// NOTE: SVN passwords should NOT be stored — webhook tokens replace them
```

---

## 7. Multi-Tenancy Compliance Check

| Requirement | Pattern A | Pattern B | Pattern C | Existing WP.org SVN |
|---|---|---|---|---|
| Each tenant's data is isolated (`ownerId`) | ✅ | ✅ | ✅ | ✅ |
| Server never executes code on client machine | ✅ | ✅ | ✅ | ✅ |
| Credentials scoped per-user (not shared) | ✅ webhook token per product | ✅ user's JWT | ✅ user's JWT | N/A — public API |
| Admin can see all tenants' SVN activity | ✅ | ✅ | ✅ | ✅ |
| Rate-limited API (existing `express-rate-limit`) | ✅ apply to webhook endpoint | ✅ | ✅ | ✅ already applied |

---

## 8. Recommended Build Order

```
Phase 1 — No new server infrastructure needed
  ├── Add svnRevision + source:'svn' to Version model
  ├── Add svn log XML parser to ActivityService (Pattern C)
  └── Add "Import SVN log" UI in ProductDetails → Activities tab

Phase 2 — Webhook receiver (Pattern A, most value for WP.org authors)
  ├── Add svnWebhookToken to Product model (generate on demand)
  ├── POST /api/svn/webhook route + controller
  ├── Auto-create Activity + Version on webhook hit
  └── ProductDetails SVN tab: show token + copy hook script

Phase 3 — AI Changelog for SVN (optional, bridges existing pipeline)
  ├── "Import SVN diff" in ChangelogGenerator page
  ├── User pastes svn diff output (or uploads file)
  └── Feeds existing Ollama summarization — zero AI code changes
```

---

## 9. The Previous Audit's Errors — Specifically

| Previous claim | Why it was wrong | Correct approach |
|---|---|---|
| `SvnService.checkout()` on server | Server can't access client's filesystem | User does checkout locally with TortoiseSVN |
| `SvnService.commit()` on server | Credentials on server, path inaccessible | Pattern A: hook calls ATRS after client commits |
| `SvnService.status()` on server | Client working copy isn't on server | Pattern B bridge, or not tracked |
| `svnWorkingCopyPath` stored in DB | Meaningless — path is on client PC | `svnRepoUrl` (remote URL) stored instead |
| "Same pattern as Git repoPath" | `repoPath` is a server-local path, only works in single-dev/self-hosted mode | SVN must use webhook/push model |
