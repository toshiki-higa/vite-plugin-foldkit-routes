# vite-plugin-foldkit-routes

A Vite plugin that adds file-based routing to Foldkit.

Uses native Foldkit Schema, Model, Message, and Command. Targets Vite 8, Effect 4.0.0, and Foldkit 0.167.0.

Experimental. Not yet published to npm. Licensed under [MIT](./LICENSE).

## How to use

Run the included example while the package is unpublished:

```sh
git clone https://github.com/toshiki-higa/vite-plugin-foldkit-routes.git
cd vite-plugin-foldkit-routes
nix develop
pnpm install --frozen-lockfile
pnpm exec vp run dev
```

Open the URL printed by Vite. The example has Home (`/`) and About (`/about`) pages with ordinary links and browser history. It is a private workspace package that consumes the plugin's compiled exports through `workspace:*`, not a separate routing implementation. The dev task builds the plugin before starting Vite. No API server is needed.

Follow the complete wiring in [`examples/basic/vite.config.ts`](./examples/basic/vite.config.ts), [`examples/basic/index.html`](./examples/basic/index.html), and [`examples/basic/src/entry.ts`](./examples/basic/src/entry.ts):

- `index.html` provides the `app` container and loads the entry.
- The entry folds generated `App.init` / `App.update`, lifts `App.subscriptions` and Messages, and renders `App.view` inside a Foldkit Document.
- Native Commands handle internal/external links. URL changes, including back/forward, reach `App.Message.ChangedUrl`.
- One `Runtime.makeApplication` / `Runtime.run` owns the app. This example needs no Effect Layers and disables DevTools and the MCP relay; it does not add a custom preservation policy.

Add the routing plugin before the official Foldkit plugin:

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

To try adding a page, create `examples/basic/src/routes/contact/page.ts` using the same pattern and visit `/contact`. Vite generates its local `route.gen.ts`; there is no manual route registry to edit.

Stateful pages and all layouts export `Model`, `Message`, `init`, `update`, and `view`. Layout views use `input.outlet()` to render their child.

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
- Browser checks cover only the client-only minimal example, not production Worker behavior or CSP enforcement.

## Developments

Nix provides Node and pnpm. Vite+ runs from local pnpm dependencies. Requires Node 24.11+ (24.x) or 26+.

```sh
direnv allow

vp run dev       # build the plugin, then start the example
vp run build     # pack the plugin: ESM + declarations
vp run ci        # build, then workspace checks and plugin tests
vp run test      # plugin tests; builds compiled consumer exports once
vp fmt           # apply shared formatting
```

The root is the plugin package, with flat `src/` and `tests/` directories. `examples/basic/` is its private workspace consumer. Shared checks, tasks, Nix, the catalog, and lockfile also live at the root. Only `dist`, README, and LICENSE are package files.

Use `vp run`, not the built-in `vp dev`, for dependency-aware startup. `vp run ci` builds the example's generated types before running `vp check`. Task caching is disabled so cached output restoration cannot bypass generated-file ownership checks. Package builds alone do not generate consumer routes.

Keep `pack.unbundle: true`: fingerprints read neighboring compiler/helper files. Vite alias and peer compatibility settings come from `vp migrate`. TypeScript 7 declaration generation currently reports an experimental warning.
