# `.atrsignore` — controlling what the AI sees

The Git Changelog Generator runs `git` against a product's working copy and sends the changed files'
diffs to the model. Not every changed file is worth sending: build output, vendored dependencies,
bundles and lockfiles inflate the prompt and make the model describe generated churn as if it were
your work.

`.atrsignore` decides which changed files reach the model. It does **not** affect what git tracks,
what gets committed, or anything outside the generator.

---

## Where it goes

One file at the **root of the working copy** — the same directory as `.git`:

```text
my-plugin/
├── .git/
├── .atrsignore      ← here
├── src/
└── build/
```

It is optional. With no `.atrsignore`, the built-in defaults below apply on their own.

## Syntax

Identical to `.gitignore`:

| Form | Meaning |
|---|---|
| `dist/` | a directory, at any depth |
| `*.min.js` | a glob on the file name |
| `docs/api/**` | a deep match |
| `!keep-this.js` | **negation** — re-include something an earlier rule dropped |
| `# comment` | ignored, as are blank lines |

**Last matching rule wins.** The defaults are applied first, so your file can override any of them
with a negation.

## Built-in defaults

Applied to every repo, and to repos that have their own `.atrsignore` as the base layer:

```gitignore
# Dependencies
node_modules/
vendor/
bower_components/

# Build / release output
dist/
build/
out/
release/
.next/
.nuxt/
.svelte-kit/
coverage/

# Bundled, minified and generated assets
*.min.js
*.min.css
*.bundle.js
*.bundle.css
*.map

# Lockfiles — huge diffs, no reviewable intent
package-lock.json
yarn.lock
pnpm-lock.yaml
shrinkwrap.json
composer.lock
Gemfile.lock
poetry.lock

# Tests
test/
tests/
__tests__/
__mocks__/
*.test.*
*.spec.*

# VCS internals
.git/
```

Defined in [`server/src/utils/atrsIgnore.ts`](../../server/src/utils/atrsIgnore.ts) as
`DEFAULT_ATRSIGNORE_PATTERNS`.

## Examples

**Include tests in the changelog** — the defaults exclude them; put them back:

```gitignore
!test/
!tests/
!*.test.*
!*.spec.*
```

**A WordPress plugin that commits its build for distribution** — already covered by the `build/`
and `vendor/` defaults, but be explicit about anything unusual:

```gitignore
languages/*.mo
languages/*.po
assets/screenshot-*.png
*.pot
```

**A monorepo where one package's generated client is worth summarising:**

```gitignore
# generated API clients are noise, except the public SDK
packages/*/generated/
!packages/public-sdk/generated/
```

## Why this matters — a real case

The `offcanvas-block` plugin tracks 275 files. **214 of them are the vendored Freemius SDK**
under `vendor/`. Without the `vendor/` rule, a release that touched a few source files would have
the model reading and summarising third-party SDK code as the plugin's own changes.

## Verifying it

The generator reports the filter in its progress log on every run:

```text
Skipped 214 non-source file(s) — .atrsignore (6 rules) plus defaults
```

…or, with no file present:

```text
Skipped 12 non-source file(s) — default ignore rules (add .atrsignore to customise)
```

If a file you expected to be summarised is missing from the output, that line is where to look
first — then check whether one of the defaults matched it, and negate it with `!`.
