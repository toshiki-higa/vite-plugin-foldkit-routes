import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { onTestFinished, test } from 'vite-plus/test';
import { createServer } from 'vite';
import { Schema } from 'effect';
import { writeGenerated } from '../src/files.ts';
import { fileRoutesPlugin } from '../src/vite.ts';

const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for public structural reload');
};
test('reset-only structural option reloads unimported create/delete after publication, not ordinary updates', async () => {
  const root = await mkdtemp(path.resolve(import.meta.dirname, '..', '.test-output-structure-'));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let socket: WebSocket | undefined;
  onTestFinished(async () => {
    socket?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  const routes = path.join(root, 'src/routes');
  await mkdir(routes, { recursive: true });
  let patterns: string[] = [];
  let generating = false;
  const plugin = fileRoutesPlugin({
    root,
    reloadOnStructure: true,
    async generate(manifest) {
      generating = true;
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        patterns = manifest.pages.map((page) => page.pattern);
        return await writeGenerated(path.join(root, 'src'), [
          {
            path: 'app.gen.ts',
            content: `export const routes=${JSON.stringify(patterns)}; if(import.meta.hot) import.meta.hot.accept();`,
          },
        ]);
      } finally {
        generating = false;
      }
    },
  });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: path.join(root, '.vite-cache'),
    logLevel: 'silent',
    plugins: [plugin],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
  const url = `http://127.0.0.1:${address.port}`;
  const initial = await fetch(`${url}/src/app.gen.ts`);
  assert.equal(initial.status, 200);
  assert.match(await initial.text(), /routes = \[\]/);
  const reloads: { generating: boolean; patterns: readonly string[] }[] = [];
  socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/?token=${server.config.webSocketToken}`,
    'vite-hmr',
  );
  socket.addEventListener('message', (event) => {
    // Parse only the system-boundary frame tag, never application payloads.
    const frame = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
    )(String(event.data));
    if (frame.type === 'full-reload') {
      reloads.push({ generating, patterns: [...patterns] });
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket!.addEventListener('open', () => resolve(), { once: true });
    socket!.addEventListener('error', () => reject(new Error('Socket failed')), { once: true });
  });
  // The initial generated-file watcher event can follow the initial HTTP load.
  // It is not the authored structural event under test.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const directory = path.join(routes, 'unimported');
  await mkdir(directory);
  const file = path.join(directory, 'page.ts');
  await writeFile(file, 'export const view=()=>null;');
  await until(() => reloads.some((frame) => frame.patterns.includes('/unimported')));
  assert.deepEqual(
    reloads.find((frame) => frame.patterns.includes('/unimported')),
    { generating: false, patterns: ['/unimported'] },
  );
  const created = await fetch(`${url}/src/app.gen.ts`);
  assert.match(await created.text(), /unimported/);
  // Drain separate generated-output events, beyond the same-file watcher throttle.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const before = reloads.length;
  await writeFile(file, 'export const view=()=>"only a view edit";');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(
    reloads.length,
    before,
    'ordinary view edits must not be compiler-dispatched cold reloads',
  );
  await rm(file);
  await until(() => reloads.length > before);
  assert.deepEqual(reloads.at(-1), { generating: false, patterns: [] });
  const deleted = await fetch(`${url}/src/app.gen.ts`);
  assert.equal(deleted.status, 200);
  assert.doesNotMatch(await deleted.text(), /unimported/);
});
