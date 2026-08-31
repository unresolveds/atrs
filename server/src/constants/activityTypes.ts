/**
 * The canonical activity/changelog type list, shared by the server's zod
 * schemas and the client's forms and filters.
 *
 * This lives inside `server/src` on purpose. It used to sit in a root-level
 * `consts/` folder, which was outside the server's tsconfig `rootDir` — so
 * building the server both failed with TS6059 *and* emitted a CommonJS
 * `consts/index.js` right next to the source. Vite resolves `.js` before `.ts`,
 * so that artifact shadowed the real module, arrived without a named export,
 * and made `ACTIVITY_TYPES` undefined in the browser. Anything reading it at
 * module scope (`z.enum(ACTIVITY_TYPES)`) then threw during import and took its
 * whole page down.
 *
 * Kept here, tsc emits to `server/dist/` instead, so no sibling `.js` can ever
 * shadow this file again.
 */
export const ACTIVITY_TYPES = [
  'all',
  'feature',
  'improvement',
  'enhancement',
  'bug-fix',
  'security',
  'performance',
  'refactor',
  'ui',
  'accessibility',
  'localization',
  'documentation',
  'dependency',
  'breaking-change',
  'deprecation',
  'removal',
  'maintenance',
  'other',
] as const;
