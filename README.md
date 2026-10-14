# vite-plugin-foldkit-routes

A Vite plugin that adds file-based routing to Foldkit.

Uses native Foldkit Schema, Model, Message, and Command. Targets Vite 8, Effect 4.0.0, and Foldkit 0.167.0.

Experimental. Not yet published to npm. Licensed under [MIT](./LICENSE).

## How to use

Add it before the official Foldkit plugin:

```ts
import { defineConfig } from 'vite';
import { foldkit } from '@foldkit/vite-plugin';
import foldkitRoutes from 'vite-plugin-foldkit-routes';

export default defineConfig({
  plugins: [foldkitRoutes(), foldkit({ devToolsMcpPort: false })],
});
```

Create pages and layouts under your app's `src/routes`:

```text
src/routes/
  page.ts                      # /
  about/page.ts                # /about
  people/[id]/page.ts           # /people/:id
  files/[...path]/page.ts       # non-empty rest path
  (public)/help/page.ts         # /help
  desk/layout.ts               # wraps pages under desk
  desk/page.ts                  # /desk
```

A stateless page exports `view`:

```ts
// src/routes/about/page.ts
import type { View } from './route.gen.ts';

export const view: View = ({ href }, h) =>
  h.section([], [h.h1([], ['About']), h.a([h.Href(href({ to: '/' }))], ['Home'])]);
```

Stateful pages and layouts export `Model`, `Message`, `init`, `update`, and `view`. Layout views use `input.outlet()` to render their child.

Use `route.params` for parameter codecs and `route.search` for a search Struct Schema. Undeclared path parameters are strings. Provide required Effect Layers in your app's entry.

The plugin generates local `route.gen.ts` / `layout.gen.ts` types and shared `routes.gen.ts`, `navigation.gen.ts`, and `app.gen.ts`. Generation runs during development and before app builds. Failed generation blocks the build. No CLI or manual generation step is needed.

For type checks outside Vite, generate first:

```ts
import { generateRoot } from 'vite-plugin-foldkit-routes';
await generateRoot(projectRoot);
```

Options: `root` defaults to Vite's root; `reloadOnStructure` defaults to `true` and reloads after route creation, deletion, or renaming.

## Limitations

- Full reload does **not** guarantee a Model reset. Preservation, DevTools, MCP, and tracing remain the app's responsibility. Generated owner `restore` hooks are not connected to HMR automatically.
- Stale completions are rejected, but external side effects are not undone. Durable write recovery and safe browser snapshot handoff are not provided.
- No layout search, duplicate inherited parameter codecs, arbitrary import aliases/loaders, dynamic subscription discovery, route-owned ManagedResource, Flags, SSR, or code splitting.
- Only marker-owned generated files are updated or removed. Handwritten pages/layouts are not overwritten. Unmarked collisions and symlink traversal fail; writes are atomic per file, not across the whole output.
- Browser, production Worker, and CSP behavior have not been verified for this package.

## Developments

Nix provides Node and pnpm. Vite+ runs from local pnpm dependencies. Requires Node 24.11+ (24.x) or 26+.

```sh
direnv allow

pnpm build       # vp pack: ESM + declarations
pnpm check       # format + type-aware lint + type checking
pnpm test        # Vitest; builds the package once for consumer tests
pnpm exec vp fmt # apply formatting
```

Implementation lives in `src/`; tests live in `test/`. Lockfiles pin tools and dependencies. Package builds do not generate routes for consumer apps.

Keep `pack.unbundle: true`: fingerprints read neighboring compiler/helper files. Vite alias and peer compatibility settings come from `vp migrate`. TypeScript 7 declaration generation currently reports an experimental warning.
