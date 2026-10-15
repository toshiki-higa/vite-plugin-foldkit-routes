import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'vite-plus/test';
import { build, createServer } from 'vite';
import { foldkitRoutes, generateRoot } from 'vite-plugin-foldkit-routes';
import { linkFixturePackage } from './fixture-package.ts';
import { temporaryDirectory } from './fixtures.ts';

const project = path.resolve(import.meta.dirname, '..');
async function fixture() {
  const root = await temporaryDirectory(path.join(project, '.test-output-package-'));
  await linkFixturePackage(root);
  return root;
}
test('compiled package generates, strictly compiles and executes in a consumer without lib or prototype files', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'src/routes/counter'), { recursive: true });
  await writeFile(
    path.join(root, 'src/routes/counter/page.ts'),
    `
import { Schema } from 'effect';
import { defineMessageUnion } from 'foldkit/message';
import type { Input, View } from './route.gen.ts';
export const Model = Schema.Struct({ count: Schema.Int });
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({ Increment: {} });
export type Message = typeof Message.Type;
export const init = (_input: Input) => ({ model: Model.make({ count: 0 }) });
export const update = (model: Model, _message: Message, _input: Input) => ({ model: { count: model.count + 1 } });
export const view: View = (model, _input, h) => h.p([], [String(model.count)]);
`,
  );
  const first = await generateRoot(root);
  assert.ok(first.written.includes('app.gen.ts'));
  await assert.rejects(access(path.join(root, 'lib')), { code: 'ENOENT' });
  const source = await readFile(path.join(root, 'src/app.gen.ts'), 'utf8');
  assert.match(source, /vite-plugin-foldkit-routes\/runtime/);
  assert.doesNotMatch(source, /\.\.\/lib\//);
  const second = await generateRoot(root);
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.removed, []);
  const check = spawnSync(
    path.join(project, 'node_modules/.bin/tsc'),
    [
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--exactOptionalPropertyTypes',
      '--noUncheckedIndexedAccess',
      '--target',
      'es2023',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--allowImportingTsExtensions',
      '--skipLibCheck',
      '--types',
      'node',
      'src/app.gen.ts',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const execute = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {Option,Schema} from 'effect';
    import {Url} from 'foldkit';
    import * as App from ${JSON.stringify(pathToFileURL(path.join(root, 'src/app.gen.ts')).href)};
    const url=Option.getOrThrow(Url.fromString('https://consumer.invalid/counter'));
    assert.equal(App.parse(url)._tag,'/counter');
    assert.equal(App.href({to:'/counter'}),'/counter');
    const result=App.init(url);
    assert.equal(result.model.page._tag,'/counter');
    assert.deepEqual(App.subscriptions,{});
    Schema.encodeSync(Schema.toCodecJson(App.Model))(result.model);
  `,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(execute.status, 0, execute.stdout + execute.stderr);
});
test('public Vite plugin owns generation without a consumer-provided generate callback', async (t) => {
  const root = await fixture();
  await mkdir(path.join(root, 'src/routes'), { recursive: true });
  await writeFile(path.join(root, 'src/routes/page.ts'), 'export const view=()=>null;');
  const plugin = foldkitRoutes({ root });
  assert.equal(plugin.name, 'vite-plugin-foldkit-routes');
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    cacheDir: path.join(root, '.vite-cache'),
    plugins: [plugin],
    server: { middlewareMode: true, watch: null },
  });
  t.onTestFinished(() => server.close());
  const module = await server.transformRequest('/src/app.gen.ts');
  assert.ok(module?.code, 'Vite must transform the generated consumer module');
  assert.match(
    await readFile(path.join(root, 'src/app.gen.ts'), 'utf8'),
    /vite-plugin-foldkit-routes\/runtime/,
  );
  assert.ok(
    (await readFile(path.join(root, 'src/routes/route.gen.ts'), 'utf8')).startsWith(
      '// @generated vite-plugin-foldkit-routes;',
    ),
  );
});
test('consumer production build generates routes without CLI or a manual generation step', async () => {
  const root = await fixture();
  assert.equal(
    JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).bin,
    undefined,
  );
  await assert.rejects(access(path.join(project, 'dist/cli.js')), { code: 'ENOENT' });
  await mkdir(path.join(root, 'src/routes/hello'), { recursive: true });
  await writeFile(
    path.join(root, 'src/routes/hello/page.ts'),
    "import type {View} from './route.gen.ts'; export const view:View=(_input,h)=>h.h1([],['Hello']);",
  );
  await writeFile(
    path.join(root, 'index.html'),
    '<script type="module" src="/src/entry.ts"></script>',
  );
  await writeFile(
    path.join(root, 'src/entry.ts'),
    "import {href} from './app.gen.ts'; console.log(href({to:'/hello'}));",
  );
  await assert.rejects(access(path.join(root, 'src/app.gen.ts')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, 'src/routes/hello/route.gen.ts')), {
    code: 'ENOENT',
  });
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [foldkitRoutes()],
    build: { write: true, minify: false },
  });
  assert.match(
    await readFile(path.join(root, 'src/app.gen.ts'), 'utf8'),
    /vite-plugin-foldkit-routes\/runtime/,
  );
  await access(path.join(root, 'src/routes/hello/route.gen.ts'));
  await access(path.join(root, 'dist/index.html'));
});
