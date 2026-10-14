import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { discover, type DiscoveryDiagnostic } from '../src/discover.ts';
async function fixture(t: { onTestFinished: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.resolve(import.meta.dirname, '..', '.test-output-discover-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    async page(route: string, source = 'export const view = () => null;') {
      const file = path.join(root, 'src/routes', route, 'page.ts');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
      return file;
    },
  };
}
test('AST discovers without execution, groups and deterministic precedence', async (t) => {
  const f = await fixture(t);
  await f.page('[...rest]');
  await f.page('[id]');
  await f.page(
    '(public)/home',
    'throw new Error("must not execute"); export const view=()=>null; export const domain=42;',
  );
  await f.page('');
  const m = await discover(f.root);
  assert.deepEqual(
    m.pages.map((p) => p.pattern),
    ['/', '/home', '/[id]', '/[...rest]'],
  );
  assert.deepEqual(m.pages[1]!.exports, ['domain', 'view']);
  assert.match(m.pages[1]!.id, /^[A-Za-z_$][\w$]*$/);
  assert.deepEqual(await discover(f.root), m);
});
test('add, rename and delete update manifests', async (t) => {
  const f = await fixture(t);
  assert.equal((await discover(f.root)).pages.length, 0);
  const file = await f.page('a');
  const first = (await discover(f.root)).pages[0]!;
  await rename(path.dirname(file), path.join(f.root, 'src/routes/b'));
  const next = (await discover(f.root)).pages[0]!;
  assert.equal(next.pattern, '/b');
  assert.notEqual(first.id, next.id);
  await rm(path.dirname(next.file), { recursive: true });
  assert.equal((await discover(f.root)).pages.length, 0);
});
test('rejects ambiguous and malformed routes', async (t) => {
  for (const route of ['[bad-name]', '[...x]/child', '[x]/[x]', '(bad', '[]']) {
    const f = await fixture(t);
    await f.page(route);
    await assert.rejects(discover(f.root), /malformed|terminal|duplicate parameter/);
  }
  const f = await fixture(t);
  await f.page('(one)/[a]');
  await f.page('(two)/[b]');
  await assert.rejects(discover(f.root), /duplicate URL shape/);
});
test('validates state contracts and unsupported declarations using AST', async (t) => {
  const invalid = [
    'export const Model = {}; export const view=()=>null;',
    'export const view=()=>null; export const provide={};',
    'export const view=()=>null; export type ChildContext = {};',
    'export * from "x";',
    'export default ()=>null;',
    'export const view=;',
    'export const view=()=>null; export const inform=()=>null;',
    'export const view=()=>null; export const route={stateKey:()=>null};',
    'export const view=()=>null; export const route={...unknown};',
  ];
  for (const source of invalid) {
    const f = await fixture(t);
    await f.page('', source);
    await assert.rejects(discover(f.root));
  }
  const f = await fixture(t);
  await f.page(
    '',
    'export const Model={}, Message={}, init=()=>null, update=()=>null, view=()=>null; export type Model=unknown; export type Message=unknown; export const route={};',
  );
  assert.equal((await discover(f.root)).pages.length, 1);
  await writeFile(path.join(f.root, 'src/routes/layout.ts'), '');
  await assert.rejects(discover(f.root), /requires runtime exports/);
});
test('unsupported child/resource/flags exports and stateless OutMessage fail closed', async (t) => {
  for (const name of ['ChildOutMessage', 'onChildOutMessage', 'managedResources', 'Flags']) {
    for (const declaration of [
      `export type ${name}=unknown;`,
      `const local={}; export {local as ${name}};`,
    ]) {
      const f = await fixture(t);
      await f.page('', `export const view=()=>null; ${declaration}`);
      await assert.rejects(discover(f.root), new RegExp(`unsupported export ${name}`));
    }
  }
  for (const declaration of ['export type OutMessage=never;', 'export const OutMessage={};']) {
    const f = await fixture(t);
    await f.page('', `export const view=()=>null; ${declaration}`);
    await assert.rejects(discover(f.root), /OutMessage requires a stateful page lifecycle/);
  }
});
test('fingerprint excludes direct view body but retains contract and same-file helpers', async (t) => {
  const f = await fixture(t);
  const file = await f.page('', 'export const helper=1; export const view=(x:number)=>x+1;');
  const token = async () => (await discover(f.root)).pages[0]!.fingerprint;
  const first = await token();
  await writeFile(file, 'export const helper=1; export const view=(x:number)=>x+12345;');
  assert.equal(await token(), first);
  await writeFile(file, 'export const helper=2; export const view=(x:number)=>x+12345;');
  assert.notEqual(await token(), first);
  await writeFile(file, 'export const helper=1; export const view=(x:string)=>x+1;');
  assert.notEqual(await token(), first);
});
test('recursive runtime dependency edits reset only dependent pages, not type-only edges', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'lib'), { recursive: true });
  const leaf = path.join(f.root, 'lib/leaf.ts'),
    barrel = path.join(f.root, 'lib/barrel.ts'),
    types = path.join(f.root, 'lib/types.ts');
  await writeFile(leaf, 'export const helper=()=>1; export type T=number;');
  await writeFile(
    barrel,
    'export { helper } from "./leaf.js"; export type { T } from "./types.ts";',
  );
  await writeFile(types, 'export type T=number;');
  const dependent = await f.page(
    'a',
    'import { helper } from "../../../lib/barrel"; import {type T} from "../../../lib/types.ts"; export const view=()=>helper();',
  );
  await f.page(
    'b',
    'import type {T} from "../../../lib/types.ts"; import {type T as Other} from "../../../lib/leaf.ts"; export const view=()=>null;',
  );
  const stamps = async () => (await discover(f.root)).pages.map((p) => p.fingerprint);
  const before = await stamps();
  await writeFile(leaf, 'export const helper=()=>2; export type T=number;');
  const changed = await stamps();
  assert.notEqual(changed[0], before[0]);
  assert.equal(changed[1], before[1]);
  await writeFile(types, 'export type T=string;');
  assert.deepEqual(await stamps(), changed);
  await writeFile(
    dependent,
    'import { helper } from "../../../lib/barrel"; import {type T} from "../../../lib/types.ts"; export const view=()=>helper()+123;',
  );
  assert.deepEqual(await stamps(), changed, 'direct view-body-only edit remains compatible');
  await f.page('inactive');
  assert.deepEqual(
    (await stamps()).slice(0, 2),
    changed,
    'inactive page addition leaves existing stamps unchanged',
  );
});
test('dependency cycles terminate and generated edges are excluded', async (t) => {
  const f = await fixture(t);
  await f.page('', 'import {a} from "./a.ts"; import "./route.gen.ts"; export const view=()=>a;');
  await writeFile(
    path.join(f.root, 'src/routes/a.ts'),
    'import {b} from "./b.ts"; export const a=b;',
  );
  const b = path.join(f.root, 'src/routes/b.ts');
  await writeFile(b, 'import {a} from "./a.ts"; export const b=1;');
  const before = (await discover(f.root)).pages[0]!.fingerprint;
  await writeFile(path.join(f.root, 'src/routes/route.gen.ts'), 'invalid generated source ignored');
  assert.equal((await discover(f.root)).pages[0]!.fingerprint, before);
  await writeFile(b, 'import {a} from "./a.ts"; export const b=2;');
  assert.notEqual((await discover(f.root)).pages[0]!.fingerprint, before);
});
test('fresh discoveries reload repaired source and retain dependency parse diagnostics', async (t) => {
  const f = await fixture(t);
  const file = await f.page('', 'import "./helper.ts"; export const view=()=>null;');
  const helper = path.join(path.dirname(file), 'helper.ts');
  await writeFile(helper, 'export const helper=1;');
  const before = (await discover(f.root)).pages[0]!;
  await writeFile(helper, 'export const helper=;');
  await assert.rejects(discover(f.root), (error: unknown) => {
    const diagnostic = error as DiscoveryDiagnostic;
    assert.equal(diagnostic.code, 'DISCOVERY_INVALID_CONTRACT');
    assert.equal(diagnostic.file, helper);
    assert.deepEqual(diagnostic.missingExports, []);
    return true;
  });
  await writeFile(helper, 'throw new Error("never execute"); export const helper=2;');
  const repaired = (await discover(f.root)).pages[0]!;
  assert.equal(repaired.id, before.id);
  assert.notEqual(repaired.fingerprint, before.fingerprint);
  await writeFile(file, 'export const view=;');
  await assert.rejects(discover(f.root), (error: unknown) => {
    const diagnostic = error as DiscoveryDiagnostic;
    assert.equal(diagnostic.code, 'DISCOVERY_PARSE_ERROR');
    assert.equal(diagnostic.file, file);
    assert.deepEqual(diagnostic.missingExports, []);
    return true;
  });
  await writeFile(file, 'import "./helper.ts"; export const view=()=>123;');
  assert.deepEqual((await discover(f.root)).pages[0], repaired);
});
test('unresolved runtime edges and computed dynamic imports fail closed', async (t) => {
  for (const source of [
    'import "./missing.ts"; export const view=()=>null;',
    'export const view=()=>import("./missing.ts");',
    'export const view=()=>import(somePath);',
  ]) {
    const f = await fixture(t);
    await f.page('', source);
    await assert.rejects(
      discover(f.root),
      /unresolved local runtime import|computed dynamic import/,
    );
  }
  const f = await fixture(t);
  await f.page('', 'import type {T} from "./missing.ts"; export const view=()=>null;');
  assert.equal(
    (await discover(f.root)).pages.length,
    1,
    'unresolved type-only edges are not runtime dependencies',
  );
});
