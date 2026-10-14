import { onTestFinished, test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { build, createServer, type HotUpdateOptions, type Plugin, type ViteDevServer } from 'vite';
import { fileRoutesPlugin } from '../src/vite.ts';
import { foldkit } from '@foldkit/vite-plugin';
import { writeGenerated, type WriteResult } from '../src/files.ts';
function hotUpdate(plugin: Plugin, server: ViteDevServer) {
  const hook = plugin.hotUpdate;
  if (!hook) throw new Error('Expected native HMR hook');
  const handler = typeof hook === 'function' ? hook : hook.handler;
  return handler.bind(server.environments.client.pluginContainer.minimalContext);
}
function hotContext(
  server: ViteDevServer,
  file: string,
  type: HotUpdateOptions['type'] = 'update',
  modules: HotUpdateOptions['modules'] = [],
): HotUpdateOptions {
  return { server, file, type, modules, timestamp: Date.now(), read: () => readFile(file, 'utf8') };
}
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out');
};
test('dev generation is serialized and reacts to add/delete/rename/errors', async () => {
  const root = await mkdtemp(path.resolve(import.meta.dirname, '..', '.test-output-vite-'));
  let closeServer = async () => {};
  onTestFinished(async () => {
    await closeServer();
    await rm(root, { recursive: true, force: true });
  });
  const routes = path.join(root, 'src/routes');
  await mkdir(routes, { recursive: true });
  let active = 0,
    maxActive = 0;
  const patterns: string[][] = [];
  const plugin = fileRoutesPlugin({
    root,
    async generate(manifest) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      patterns.push(manifest.pages.map((p) => p.pattern));
      active--;
    },
  });
  const server = await createServer({
    root,
    cacheDir: path.join(root, '.vite-cache'),
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin],
    server: { middlewareMode: true, watch: null },
  });
  closeServer = () => server.close();
  await waitFor(() => patterns.length > 0);
  const page = path.join(routes, 'page.ts');
  await writeFile(page, 'export const view=()=>null;');
  server.watcher.emit('add', page);
  await waitFor(() => patterns.some((p) => p.includes('/')));
  // Drain native create dispatch (including environment initialization) before
  // measuring the generated-only event filter independently.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const before = patterns.length;
  for (const name of ['route.gen.ts', 'page.gen.ts', 'route.gen.ts.uuid.tmp', 'page.ts.uuid.tmp']) {
    const file = path.join(routes, name);
    for (const event of ['add', 'change', 'unlink'] as const) server.watcher.emit(event, file);
    assert.equal(await hotUpdate(plugin, server)(hotContext(server, file)), undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(patterns.length, before, 'generated and temporary output events must not compile');
  await writeFile(page, 'export const view=;');
  server.watcher.emit('change', page);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(patterns.length, before);
  await writeFile(page, 'export const view=()=>null;');
  server.watcher.emit('change', page);
  await waitFor(() => patterns.length > before);
  const sub = path.join(routes, 'new');
  await mkdir(sub);
  const moved = path.join(sub, 'page.ts');
  await rename(page, moved);
  server.watcher.emit('unlink', page);
  server.watcher.emit('add', moved);
  await waitFor(() => patterns.at(-1)?.includes('/new') === true);
  await rm(sub, { recursive: true });
  server.watcher.emit('unlink', moved);
  await waitFor(() => patterns.at(-1)?.length === 0);
  assert.equal(maxActive, 1);
});
test('generation finishes before HMR completion without suppressing modules or sending reloads', async () => {
  const root = await mkdtemp(path.resolve(import.meta.dirname, '..', '.test-output-vite-'));
  let closeServer = async () => {};
  onTestFinished(async () => {
    await closeServer();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'src/routes'), { recursive: true });
  await mkdir(path.join(root, 'lib'));
  const lib = path.join(root, 'lib/helper.ts'),
    src = path.join(root, 'src/helper.ts');
  await writeFile(lib, 'export {helper} from "../src/helper.ts";');
  await writeFile(src, 'export const helper=1;');
  const page = path.join(root, 'src/routes/page.ts');
  await writeFile(
    page,
    'import {helper} from "../../lib/helper.ts"; export const view=()=>helper;',
  );
  let stamp = '';
  const plugin = fileRoutesPlugin({
    root,
    async generate(m) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      stamp = m.pages[0]!.fingerprint;
    },
  });
  const server = await createServer({
    root,
    cacheDir: path.join(root, '.vite-cache'),
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin],
    server: { middlewareMode: true, watch: null },
  });
  closeServer = () => server.close();
  await waitFor(() => stamp !== '');
  const reloadStamps: string[] = [];
  const originalSend = server.ws.send.bind(server.ws);
  server.ws.send = ((payload: unknown, ...rest: unknown[]) => {
    if (
      payload &&
      typeof payload === 'object' &&
      (payload as { type?: string }).type === 'full-reload'
    )
      reloadStamps.push(stamp);
    return Reflect.apply(originalSend, server.ws, [payload, ...rest]);
  }) as typeof server.ws.send;
  const initial = stamp;
  await writeFile(src, 'export const helper=2;');
  server.watcher.emit('change', src);
  await waitFor(() => stamp !== initial);
  assert.deepEqual(reloadStamps, [], 'watcher generation must not dispatch a premature reload');
  const next = stamp;
  await writeFile(lib, 'export {helper} from "../src/helper.ts"; export const extra=1;');
  const hook = hotUpdate(plugin, server);
  const modules = [
    await server.environments.client.moduleGraph.ensureEntryFromUrl('/lib/helper.ts'),
  ];
  const context = hotContext(server, lib, 'update', modules);
  assert.equal(await hook(context), undefined);
  assert.equal(
    context.modules,
    modules,
    'module list must propagate unchanged to official Foldkit',
  );
  assert.equal(modules.length, 1);
  assert.notEqual(
    stamp,
    next,
    'HMR must await helper fingerprint update even without a watcher event',
  );
  const compatible = stamp;
  await writeFile(
    page,
    'import {helper} from "../../lib/helper.ts"; export const view=()=>helper+123;',
  );
  const pageModules = [
    await server.environments.client.moduleGraph.ensureEntryFromUrl('/src/routes/page.ts'),
  ];
  const pageContext = hotContext(server, page, 'update', pageModules);
  assert.equal(await hook(pageContext), undefined);
  assert.equal(stamp, compatible, 'view-body-only edit must retain compatibility token');
  assert.equal(pageContext.modules, pageModules);
  assert.equal(pageModules.length, 1);
  assert.deepEqual(
    reloadStamps,
    [],
    'compiler watcher/HMR hooks must leave reload ownership to official Foldkit',
  );
});
test('recovery reloads once even with unchanged generated output, ordinary success never reloads', async () => {
  const root = await mkdtemp(path.resolve(import.meta.dirname, '..', '.test-output-vite-'));
  let closeServer = async () => {};
  onTestFinished(async () => {
    await closeServer();
    await rm(root, { recursive: true, force: true });
  });
  const routes = path.join(root, 'src/routes');
  await mkdir(routes, { recursive: true });
  const page = path.join(routes, 'page.ts');
  await writeFile(page, 'export const view=()=>null;');
  let generating = false;
  const results: WriteResult[] = [];
  const plugin = fileRoutesPlugin({
    root,
    async generate(manifest) {
      generating = true;
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        results.push(
          await writeGenerated(path.join(root, 'src'), [
            {
              path: 'app.gen.ts',
              content: JSON.stringify(manifest.pages.map((p) => p.fingerprint)),
            },
          ]),
        );
      } finally {
        generating = false;
      }
    },
  });
  const server = await createServer({
    root,
    cacheDir: path.join(root, '.vite-cache'),
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin],
    server: { middlewareMode: true, watch: null },
  });
  closeServer = () => server.close();
  await waitFor(() => results.length > 0 && !generating);
  const messages: string[] = [];
  const originalSend = server.ws.send.bind(server.ws);
  server.ws.send = ((payload: unknown, ...rest: unknown[]) => {
    if (payload && typeof payload === 'object') messages.push((payload as { type: string }).type);
    return Reflect.apply(originalSend, server.ws, [payload, ...rest]);
  }) as typeof server.ws.send;
  let invalidations = 0;
  const graph = server.environments.client.moduleGraph,
    invalidate = graph.invalidateAll.bind(graph);
  graph.invalidateAll = () => {
    assert.equal(generating, false, 'recovery must wait for generation');
    invalidations++;
    invalidate();
  };
  const invalid = path.join(routes, 'invalid');
  await mkdir(invalid);
  const invalidPage = path.join(invalid, 'page.ts');
  await writeFile(invalidPage, 'export const view=;');
  server.watcher.emit('add', invalidPage);
  await waitFor(() => messages.includes('error'));
  assert.equal(invalidations, 0);
  assert.equal(messages.filter((m) => m === 'full-reload').length, 0);
  const before = results.length;
  await rm(invalid, { recursive: true });
  server.watcher.emit('unlink', invalidPage);
  server.watcher.emit('unlinkDir', invalid);
  await waitFor(() => messages.includes('full-reload'));
  assert.ok(results.length > before);
  assert.deepEqual(results.at(-1), { written: [], unchanged: ['app.gen.ts'], removed: [] });
  assert.ok(invalidations >= 1);
  assert.equal(messages.filter((m) => m === 'full-reload').length, 1);
  const recoveredInvalidations = invalidations;
  const recovered = results.length;
  await writeFile(page, 'export const view=()=>123;');
  server.watcher.emit('change', page);
  await waitFor(() => results.length > recovered && !generating);
  const modules = [
    await server.environments.client.moduleGraph.ensureEntryFromUrl('/src/routes/page.ts'),
  ];
  assert.equal(
    await hotUpdate(plugin, server)(hotContext(server, page, 'update', modules)),
    undefined,
  );
  assert.equal(invalidations, recoveredInvalidations);
  assert.equal(
    messages.filter((m) => m === 'full-reload').length,
    1,
    'normal success must not reload',
  );
});
test('real Vite create/delete barrier serves fresh generated HTTP modules without stale page imports', async () => {
  const root = await mkdtemp(path.resolve(import.meta.dirname, '..', '.test-output-vite-http-'));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  onTestFinished(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  const routes = path.join(root, 'src/routes/people');
  await mkdir(path.join(routes, '[id]'), { recursive: true });
  await mkdir(path.join(routes, 'alice'));
  await writeFile(path.join(routes, '[id]/page.ts'), 'export const view=()=>"dynamic";');
  const alice = path.join(routes, 'alice/page.ts');
  await writeFile(alice, 'export const view=()=>"alice";');
  const structural: Array<{ type: string; file: string; modules: number }> = [];
  const officialUpdates: string[] = [];
  const officialModuleCounts = new Map<string, number>();
  const observer: Plugin = {
    name: 'public-hmr-observer',
    hotUpdate: {
      order: 'post',
      handler(ctx) {
        if (this.environment.name === 'client' && ctx.type !== 'update')
          structural.push({ type: ctx.type, file: ctx.file, modules: ctx.modules.length });
      },
    },
  };
  // Public legacy-hook observer checks the path used by official Foldkit. It
  // does not emulate preservation and does not send its own reloads.
  const legacyObserver: Plugin = {
    name: 'public-legacy-hmr-observer',
    handleHotUpdate(ctx) {
      officialUpdates.push(ctx.file);
      officialModuleCounts.set(ctx.file, ctx.modules.length);
    },
  };
  const plugin = fileRoutesPlugin({
    root,
    async generate(m) {
      const imports = m.pages
        .map(
          (p, i) =>
            `import * as page${i} from ${JSON.stringify('./' + p.relativeFile.slice('src/'.length))};`,
        )
        .join('\n');
      const content =
        imports +
        '\nexport const views=[' +
        m.pages.map((_, i) => `page${i}.view`).join(',') +
        '];\n';
      await writeGenerated(path.join(root, 'src'), [{ path: 'app.gen.ts', content }]);
    },
  });
  server = await createServer({
    root,
    cacheDir: path.join(root, '.vite-cache'),
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin, legacyObserver, observer],
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: { usePolling: true, interval: 20, binaryInterval: 20 },
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Expected listening server');
  const base = `http://127.0.0.1:${address.port}`;
  async function moduleText(url: string) {
    const response = await fetch(base + url);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return text;
  }
  const app = path.join(root, 'src/app.gen.ts');
  await waitFor(() => structural.some((e) => e.type === 'create' && e.file === app));
  assert.match(await moduleText('/src/app.gen.ts'), /alice\/page\.ts/);
  await moduleText('/src/routes/people/alice/page.ts');
  await moduleText('/src/routes/people/[id]/page.ts');
  const messages: Array<{ type?: string; triggeredBy?: string }> = [];
  const originalSend = server.ws.send.bind(server.ws);
  server.ws.send = ((payload: unknown, ...rest: unknown[]) => {
    if (payload && typeof payload === 'object')
      messages.push(payload as { type?: string; triggeredBy?: string });
    return Reflect.apply(originalSend, server!.ws, [payload, ...rest]);
  }) as typeof server.ws.send;
  const deleteUpdatesBefore = officialUpdates.length;
  await rm(alice);
  await waitFor(
    () =>
      structural.some((e) => e.type === 'delete' && e.file === alice) &&
      officialUpdates.slice(deleteUpdatesBefore).includes(app),
  );
  assert.equal(
    structural.find((e) => e.type === 'delete' && e.file === alice)?.modules,
    0,
    'only premature structural propagation is suppressed',
  );
  assert.ok(
    (officialModuleCounts.get(app) ?? 0) > 0,
    'generated registry modules must reach the official-style legacy hook',
  );
  assert.doesNotMatch(await moduleText('/src/app.gen.ts'), /alice\/page\.ts/);
  assert.equal(
    messages.some((m) => m.type === 'full-reload' && m.triggeredBy === alice),
    false,
    'deleted page must not trigger Vite default reload',
  );
  const before = officialUpdates.length;
  // Chokidar throttles rapid repeated change events for the same atomic target;
  // keep distinct human-paced structural operations outside that window.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(alice, 'export const view=()=>"alice restored";');
  await waitFor(
    () =>
      structural.some((e) => e.type === 'create' && e.file === alice) &&
      officialUpdates.slice(before).includes(app),
  ).catch(async (error) => {
    throw new Error(
      `${String(error)}; structural=${JSON.stringify(structural)}; updates=${JSON.stringify(officialUpdates)}; messages=${JSON.stringify(messages)}; output=${await readFile(app, 'utf8')}`,
    );
  });
  assert.match(await moduleText('/src/app.gen.ts'), /alice\/page\.ts/);
  assert.match(await moduleText('/src/routes/people/alice/page.ts'), /alice restored/);
  const updateBefore = officialUpdates.length;
  await writeFile(alice, 'export const view=()=>"alice edited";');
  await waitFor(() => officialUpdates.slice(updateBefore).includes(alice));
  assert.ok(
    (officialModuleCounts.get(alice) ?? 0) > 0,
    'ordinary page edits must retain actual HMR modules',
  );
  assert.match(await moduleText('/src/routes/people/alice/page.ts'), /alice edited/);
});
test('authored semantic HMR serves the new generated schema even before its separate output watcher event', async () => {
  const root = await mkdtemp(
    path.resolve(import.meta.dirname, '..', '.test-output-vite-schema-cache-'),
  );
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  onTestFinished(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  const routes = path.join(root, 'src/routes');
  await mkdir(routes, { recursive: true });
  const layout = path.join(routes, 'layout.ts');
  const source = (revision: number) =>
    `export const Model={}; export const Message={}; export const init=()=>({revision:${revision}}); export const update=(model)=>({model}); export const view=()=>null;`;
  await writeFile(layout, source(0));
  await writeFile(path.join(routes, 'page.ts'), 'export const view=()=>null;');
  let stamp = '';
  const plugin = fileRoutesPlugin({
    root,
    async generate(manifest) {
      stamp = manifest.layouts[0]!.fingerprint;
      return writeGenerated(path.join(root, 'src'), [
        {
          path: 'app.gen.ts',
          content: `import * as owner from './routes/layout.ts'; export const definition=${JSON.stringify(stamp)}; export const init=owner.init;`,
        },
        { path: 'unrelated.gen.ts', content: 'export const stable=true;' },
      ]);
    },
  });
  // Disable filesystem notifications to deterministically hold the generated
  // file's separate watcher event past the authored hook + reload request.
  // This models delayed/coalesced output notifications, not browser timing.
  server = await createServer({
    root,
    cacheDir: path.join(root, '.vite-cache'),
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin],
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  await server.listen();
  await waitFor(() => stamp !== '');
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Expected listening server');
  const base = `http://127.0.0.1:${address.port}`;
  const request = async () => {
    const response = await fetch(base + '/src/app.gen.ts');
    assert.equal(response.status, 200);
    return response.text();
  };
  assert.ok((await request()).includes(stamp));
  const firstStamp = stamp;
  // Exercise the public native hook with the real client environment while
  // keeping separate output notifications disabled.
  const inactive = path.join(routes, 'inactive');
  await mkdir(inactive);
  const inactiveLayout = path.join(inactive, 'layout.ts');
  await writeFile(inactiveLayout, source(0));
  const hot = hotUpdate(plugin, server);
  const environment = server.environments.client;
  await hot(hotContext(server, inactiveLayout, 'create'));
  await request();
  await rm(inactive, { recursive: true });
  await hot(hotContext(server, inactiveLayout, 'delete'));
  assert.ok(
    (await request()).includes(firstStamp),
    'prime generated-module transform cache after structural barrier',
  );
  await fetch(base + '/src/routes/layout.ts');
  await mkdir(path.join(root, 'lib'));
  await writeFile(path.join(root, 'lib/unrelated.gen.ts'), 'export const stable=true;');
  await writeFile(path.join(root, 'src/unrelated.ts'), 'export const stable=true;');
  await fetch(base + '/lib/unrelated.gen.ts');
  await fetch(base + '/src/unrelated.ts');
  await fetch(base + '/src/unrelated.gen.ts');
  const appModule = environment.moduleGraph
    .getModulesByFile(path.join(root, 'src/app.gen.ts'))
    ?.values()
    .next().value;
  const unchangedGeneratedModule = environment.moduleGraph
    .getModulesByFile(path.join(root, 'src/unrelated.gen.ts'))
    ?.values()
    .next().value;
  assert.ok(appModule?.transformResult);
  assert.ok(unchangedGeneratedModule?.transformResult);
  const appTransform = appModule.transformResult,
    unchangedGeneratedTransform = unchangedGeneratedModule.transformResult;
  const unrelatedModule = environment.moduleGraph
    .getModulesByFile(path.join(root, 'lib/unrelated.gen.ts'))
    ?.values()
    .next().value;
  const authoredModule = environment.moduleGraph
    .getModulesByFile(path.join(root, 'src/unrelated.ts'))
    ?.values()
    .next().value;
  assert.ok(unrelatedModule?.transformResult);
  assert.ok(authoredModule?.transformResult);
  const unrelatedTransform = unrelatedModule.transformResult,
    authoredTransform = authoredModule.transformResult;
  await writeFile(layout, source(0).replace('view=()=>null', 'view=()=>"new view"'));
  assert.equal(await hot(hotContext(server, layout)), undefined);
  assert.equal(stamp, firstStamp, 'view-body-only edit preserves semantic literal');
  assert.equal(
    appModule.transformResult,
    appTransform,
    'unchanged output is not invalidated by view-only generation',
  );
  assert.ok(
    (await request()).includes(firstStamp),
    'view-only generation retains the compatible schema',
  );
  await writeFile(layout, source(7));
  const modules = [...(environment.moduleGraph.getModulesByFile(layout) ?? [])];
  assert.ok(modules.length > 0);
  const context = hotContext(server, layout, 'update', modules);
  assert.equal(await hot(context), undefined, 'ordinary modules must reach official HMR unchanged');
  assert.equal(context.modules, modules);
  assert.notEqual(stamp, firstStamp, 'semantic owner edit changes generated literal');
  assert.ok((await readFile(path.join(root, 'src/app.gen.ts'), 'utf8')).includes(stamp));
  assert.ok(
    (await request()).includes(stamp),
    'reload request must not restore against cached old generated literal before output watcher notification',
  );
  assert.equal(
    unchangedGeneratedModule.transformResult,
    unchangedGeneratedTransform,
    'unchanged generated outputs remain cached',
  );
  assert.equal(
    unrelatedModule.transformResult,
    unrelatedTransform,
    'generated modules outside root/src are not invalidated',
  );
  assert.equal(
    authoredModule.transformResult,
    authoredTransform,
    'unrelated ordinary source modules are not invalidated',
  );
});

test('precise publication invalidation retains real official Foldkit reload/preserve/restore transport', async () => {
  const root = await mkdtemp(
    path.resolve(import.meta.dirname, '..', '.test-output-vite-official-'),
  );
  let server: Awaited<ReturnType<typeof createServer>> | undefined, socket: WebSocket | undefined;
  onTestFinished(async () => {
    socket?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  const routes = path.join(root, 'src/routes');
  await mkdir(routes, { recursive: true });
  await writeFile(path.join(routes, 'page.ts'), 'export const view=()=>null;');
  const app = path.join(root, 'src/app.gen.ts');
  const plugin = fileRoutesPlugin({
    root,
    async generate(manifest) {
      return writeGenerated(path.join(root, 'src'), [
        {
          path: 'app.gen.ts',
          content: `export const registered=${JSON.stringify({ pages: manifest.pages.map((page) => page.pattern), layouts: manifest.layouts.map((layout) => layout.relativeFile) })};`,
        },
      ]);
    },
  });
  const officialInputs: Array<{ file: string; modules: number }> = [];
  const observer: Plugin = {
    name: 'observe-before-real-foldkit',
    handleHotUpdate(context) {
      officialInputs.push({ file: context.file, modules: context.modules.length });
    },
  };
  server = await createServer({
    root,
    cacheDir: path.join(root, '.vite-cache'),
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin, observer, foldkit({ devToolsMcpPort: false })],
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: { usePolling: true, interval: 20, binaryInterval: 20 },
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Expected listening server');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base + '/src/app.gen.ts')).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 150));
  socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/?token=${server.config.webSocketToken}`,
    'vite-hmr',
  );
  let connected = false,
    armed = false;
  const restored: unknown[] = [];
  const expected = { count: 1, open: true };
  const send = (event: string, data: unknown) =>
    socket!.send(JSON.stringify({ type: 'custom', event, data }));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      type: string;
      event?: string;
      data?: { model?: unknown };
    };
    if (message.type === 'connected') connected = true;
    if (armed && message.type === 'full-reload') {
      // Exercise the public browser -> plugin reload-flush protocol. No custom
      // preservation logic, private Foldkit state, or Command replay is used.
      send('foldkit:preserve-model', {
        id: 'official-regression',
        model: expected,
        isReloadFlush: true,
      });
      send('foldkit:request-model', { id: 'official-regression' });
    }
    if (message.type === 'custom' && message.event === 'foldkit:restore-model')
      restored.push(message.data?.model);
  });
  await waitFor(() => connected);
  send('foldkit:preserve-model', {
    id: 'official-regression',
    model: expected,
    isReloadFlush: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  armed = true;
  const inactive = path.join(routes, 'inactive');
  await mkdir(inactive);
  const inactiveLayout = path.join(inactive, 'layout.ts');
  await writeFile(
    inactiveLayout,
    'export const Model={}; export const Message={}; export const init=()=>({model:{}}); export const update=(model)=>({model}); export const view=()=>null;',
  );
  await waitFor(() => restored.length > 0);
  assert.deepEqual(restored.at(-1), expected);
  assert.ok(
    officialInputs.some((input) => input.file === app && input.modules > 0),
    'generated changed module must reach the actual official plugin with loaded modules',
  );
  const response = await fetch(base + '/src/app.gen.ts');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /inactive/);
  const before = restored.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(inactive, { recursive: true });
  await waitFor(() => restored.length > before);
  assert.deepEqual(restored.at(-1), expected);
  const deleted = await fetch(base + '/src/app.gen.ts');
  assert.equal(deleted.status, 200);
  assert.doesNotMatch(await deleted.text(), /inactive/);
});

test('pending requests wait for the final coalesced save, with no last-good success', async () => {
  const root = await mkdtemp(path.resolve(import.meta.dirname, '..', '.test-output-vite-pending-'));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  onTestFinished(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  const routes = path.join(root, 'src/routes');
  await mkdir(routes, { recursive: true });
  const page = path.join(routes, 'page.ts');
  await writeFile(page, 'export const view=()=>null;');
  let runs = 0,
    block = false,
    entered = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const plugin = fileRoutesPlugin({
    root,
    async generate() {
      runs++;
      if (block) {
        entered = true;
        await gate;
      }
      await writeGenerated(path.join(root, 'src'), [
        { path: 'app.gen.ts', content: 'export const ready=true;' },
      ]);
    },
  });
  server = await createServer({
    root,
    cacheDir: path.join(root, '.vite-cache'),
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin],
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  await server.listen();
  await waitFor(() => runs > 0);
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Expected listening server');
  const url = `http://127.0.0.1:${address.port}/src/app.gen.ts`;
  assert.equal((await fetch(url)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 150)); // drain native initial output/environment dispatch
  const initialRuns = runs;
  block = true;
  // A same-turn save burst coalesces before reading. A later save during a
  // suspended callback needs exactly one final pass, even if repeated.
  for (let i = 0; i < 20; i++) server.watcher.emit('change', page);
  await waitFor(() => entered);
  assert.equal(runs, initialRuns + 1);
  let completed = false;
  const request = fetch(url).then(async (response) => {
    const text = await response.text();
    completed = true;
    return { response, text };
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(completed, false);
  await writeFile(page, 'export const Model=1; export const view=()=>null;');
  for (let i = 0; i < 20; i++) server.watcher.emit('change', page);
  block = false;
  release();
  const failed = await request;
  assert.equal(failed.response.status, 500);
  assert.match(failed.text, /Message.*init.*update/);
  assert.equal(runs, initialRuns + 1, 'invalid final contents must never reach generate');
  assert.match(
    await readFile(path.join(root, 'src/app.gen.ts'), 'utf8'),
    /ready=true/,
    'last-good bytes retained for repair',
  );
  await writeFile(page, 'export const view=()=>null;');
  server.watcher.emit('change', page);
  assert.equal((await fetch(url)).status, 200);
  assert.ok(
    runs >= initialRuns + 2,
    'repair must compile before serving success; native HMR may request another settled pass',
  );
});

test('real HTTP failure/recovery preserves last-good disk but blocks stale success and forwards actionable diagnostics', async () => {
  const root = await mkdtemp(
    path.resolve(import.meta.dirname, '..', '.test-output-vite-error-http-'),
  );
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  onTestFinished(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  const routes = path.join(root, 'src/routes');
  await mkdir(routes, { recursive: true });
  const page = path.join(routes, 'page.ts');
  await writeFile(page, 'export const view=()=>null;');
  let outputReady = false,
    publicationFailure = false;
  const plugin = fileRoutesPlugin({
    root,
    async generate() {
      if (publicationFailure)
        throw new Error('GENERATION_IO: Fix output permissions before retrying.');
      await writeGenerated(path.join(root, 'src'), [
        { path: 'app.gen.ts', content: 'export const ready=true;' },
      ]);
      outputReady = true;
    },
  });
  server = await createServer({
    root,
    cacheDir: path.join(root, '.vite-cache'),
    configFile: false,
    logLevel: 'silent',
    plugins: [plugin],
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: { usePolling: true, interval: 20, binaryInterval: 20 },
    },
  });
  await server.listen();
  await waitFor(() => outputReady);
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Expected listening server');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base + '/src/app.gen.ts')).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 150)); // finish native initial generated-module dispatch
  const good = await readFile(path.join(root, 'src/app.gen.ts'), 'utf8');
  const messages: Array<{
    type?: string;
    err?: { message: string; code?: string; id?: string; missingExports?: readonly string[] };
  }> = [];
  const originalSend = server.ws.send.bind(server.ws);
  server.ws.send = ((payload: unknown, ...rest: unknown[]) => {
    if (payload && typeof payload === 'object') messages.push(payload as (typeof messages)[number]);
    return Reflect.apply(originalSend, server!.ws, [payload, ...rest]);
  }) as typeof server.ws.send;
  async function checkFailure(pattern: RegExp) {
    for (const url of ['/src/app.gen.ts', '/src/routes/page.ts', '/@vite/client', '/']) {
      const response = await fetch(base + url),
        body = await response.text();
      assert.equal(response.status, 500, body);
      assert.match(body, pattern);
    }
    assert.equal(await readFile(path.join(root, 'src/app.gen.ts'), 'utf8'), good);
  }
  await writeFile(page, 'export const Model=1; export const view=()=>null;');
  await waitFor(() => messages.some((m) => m.err?.code === 'DISCOVERY_MISSING_EXPORTS'));
  const missing = messages.find((m) => m.err?.code === 'DISCOVERY_MISSING_EXPORTS')!.err!;
  assert.deepEqual(missing.missingExports, ['Message', 'init', 'update']);
  assert.match(missing.id ?? '', /page\.ts$/);
  assert.match(missing.message, /runtime exports/);
  await checkFailure(/Message.*init.*update/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(page, 'export const view=;');
  await waitFor(() => messages.some((m) => m.err?.code === 'DISCOVERY_PARSE_ERROR'));
  await checkFailure(/page\.ts/);
  assert.equal(messages.filter((m) => m.type === 'full-reload').length, 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(page, 'export const view=()=>null;');
  await waitFor(() => messages.some((m) => m.type === 'full-reload'));
  assert.equal((await fetch(base + '/src/app.gen.ts')).status, 200);
  assert.equal(
    messages.filter((m) => m.type === 'full-reload').length,
    1,
    'unchanged output still clears failure overlay once',
  );
  publicationFailure = true;
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(page, 'export const view=()=>123;');
  await waitFor(() => messages.some((m) => m.err?.message.includes('GENERATION_IO')));
  const publicationDiagnostic = messages.find((m) =>
    m.err?.message.includes('GENERATION_IO'),
  )!.err!;
  for (const property of ['code', 'id', 'missingExports'])
    assert.equal(
      Object.hasOwn(publicationDiagnostic, property),
      false,
      'absent diagnostic properties must be omitted, not undefined',
    );
  await checkFailure(/Fix output permissions/);
  publicationFailure = false;
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(page, 'export const view=()=>456;');
  await waitFor(() => messages.filter((m) => m.type === 'full-reload').length === 2);
  assert.equal((await fetch(base + '/src/app.gen.ts')).status, 200);
});

test('buildStart awaits callback and rejects discovery errors', async () => {
  const root = await mkdtemp(path.resolve(import.meta.dirname, '..', '.test-output-build-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  const entry = path.join(root, 'src/entry.ts');
  await writeFile(entry, 'export const ready=true;');
  let done = false;
  const plugin = fileRoutesPlugin({
    root,
    async generate() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done = true;
    },
  });
  const config = {
    root,
    configFile: false as const,
    logLevel: 'silent' as const,
    plugins: [plugin],
    build: { write: false, rolldownOptions: { input: entry } },
  };
  await build(config);
  assert.equal(done, true);
  await mkdir(path.join(root, 'src/routes'), { recursive: true });
  await writeFile(path.join(root, 'src/routes/page.ts'), 'export const init=()=>null;');
  await assert.rejects(() => build(config), /view/);
});
