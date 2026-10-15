import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { discover, type DiscoveryDiagnostic } from '../src/discover.ts';
const native = 'export const Model={}, Message={}, init=()=>null, update=()=>null, view=()=>null;';
async function fixture(t: { onTestFinished: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.resolve(import.meta.dirname, '..', '.test-output-contracts-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const put = async (file: string, source: string) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
    return target;
  };
  await put(
    'src/domain.ts',
    'throw new Error("never execute"); export const Request=Schema.TaggedStruct("Request",{}); export const Other=Schema.TaggedStruct("Request",{}); export const Id=Schema.String.pipe(Schema.brand("Id"));',
  );
  return { root, put };
}
test('source aliases/reexports establish declaration identity and pathless file ancestry', async (t) => {
  const f = await fixture(t);
  await f.put('src/barrel.ts', 'export {Request as PublicRequest} from "./domain.js";');
  await f.put(
    'src/routes/layout.ts',
    `${native} import {PublicRequest as Alias} from '../barrel.ts'; const shared=Alias; export {shared as ChildOutMessage}; export const onChildOutMessage=()=>null;`,
  );
  await f.put('src/routes/(private)/layout.ts', native);
  await f.put(
    'src/routes/(private)/people/page.ts',
    `${native} import {Request as Local} from '../../../domain.ts'; const shared=Local; export {shared as OutMessage};`,
  );
  const m = await discover(f.root),
    page = m.pages[0]!;
  assert.deepEqual(page.outContract, { file: 'src/domain.ts', exportName: 'Request' });
  assert.deepEqual(
    page.layouts,
    m.layouts.map((l) => l.id),
  );
  assert.deepEqual(m.layouts[1]!.layouts, [m.layouts[0]!.id]);
  assert.equal(page.receiver, m.layouts[0]!.id);
  assert.equal(page.pattern, '/people');
});
test('fresh discoveries reload shared contract aliases and recover from identity diagnostics', async (t) => {
  const f = await fixture(t);
  await f.put('src/barrel.ts', 'export {Request as Shared} from "./domain.ts";');
  await f.put(
    'src/routes/layout.ts',
    `${native} import {Shared} from '../barrel.ts'; export const ChildOutMessage=Shared; export const onChildOutMessage=()=>null;`,
  );
  await f.put(
    'src/routes/page.ts',
    `${native} import {Shared} from '../barrel.ts'; export const OutMessage=Shared;`,
  );
  const before = await discover(f.root);
  assert.equal(before.pages[0]!.outContract?.exportName, 'Request');
  await f.put('src/barrel.ts', 'export {Other as Shared} from "./domain.ts";');
  const changed = await discover(f.root);
  assert.deepEqual(changed.pages[0]!.outContract, {
    file: 'src/domain.ts',
    exportName: 'Other',
  });
  assert.deepEqual(changed.layouts[0]!.childContract, changed.pages[0]!.outContract);
  assert.equal(changed.pages[0]!.id, before.pages[0]!.id);
  assert.notEqual(changed.pages[0]!.fingerprint, before.pages[0]!.fingerprint);
  const domain = await f.put('src/domain.ts', 'export const Other=42;');
  await assert.rejects(discover(f.root), (error: unknown) => {
    const diagnostic = error as DiscoveryDiagnostic;
    assert.equal(diagnostic.code, 'DISCOVERY_CONTRACT_IDENTITY');
    assert.equal(diagnostic.file, domain);
    assert.deepEqual(diagnostic.missingExports, []);
    return true;
  });
  await f.put(
    'src/domain.ts',
    'throw new Error("never execute"); export const Other=Schema.TaggedStruct("Other",{});',
  );
  assert.deepEqual((await discover(f.root)).pages[0]!.outContract, changed.pages[0]!.outContract);
});
test('missing/incompatible nearest receiver and same shape different declaration fail closed', async (t) => {
  const f = await fixture(t);
  await f.put(
    'src/routes/x/page.ts',
    `${native} import {Request} from '../../domain.ts'; export const OutMessage=Request;`,
  );
  await assert.rejects(discover(f.root), /no ancestor/);
  await f.put(
    'src/routes/layout.ts',
    `${native} import {Request} from '../domain.ts'; export const ChildOutMessage=Request;`,
  );
  await assert.rejects(discover(f.root), /missing receiver contract or handler/);
  await f.put(
    'src/routes/layout.ts',
    `${native} import {Request} from '../domain.ts'; export const ChildOutMessage=Request; export const onChildOutMessage=()=>null;`,
  );
  await f.put(
    'src/routes/x/layout.ts',
    `${native} import {Other} from '../../domain.ts'; export const ChildOutMessage=Other; export const onChildOutMessage=()=>null;`,
  );
  await assert.rejects(discover(f.root), /incompatible nearest.*x\/layout/);
});
test('contract alias cycles and unsupported expressions diagnose, without execution', async (t) => {
  for (const domain of [
    'export {Request} from "./cycle.ts";',
    'const a=b; const b=a; export {a as Request};',
  ]) {
    const f = await fixture(t);
    await f.put('src/domain.ts', domain);
    await f.put('src/cycle.ts', 'export {Request} from "./domain.ts";');
    await f.put(
      'src/routes/layout.ts',
      `${native} import {Request} from '../domain.ts'; export const ChildOutMessage=Request; export const onChildOutMessage=()=>null;`,
    );
    await assert.rejects(discover(f.root), /cyclic contract alias/);
  }
  const f = await fixture(t);
  await f.put(
    'src/routes/layout.ts',
    `${native} export const ChildOutMessage=Schema.Struct({}); export const onChildOutMessage=()=>null;`,
  );
  await assert.rejects(discover(f.root), /reuse a shared schema identifier/);
});
test('layout output targets its own ancestor and provider contracts pair', async (t) => {
  const f = await fixture(t);
  await f.put(
    'src/routes/layout.ts',
    `${native} import {Request} from '../domain.ts'; export const ChildOutMessage=Request; export const onChildOutMessage=()=>null;`,
  );
  await f.put(
    'src/routes/(group)/layout.ts',
    `${native} import {Request} from '../../domain.ts'; export const OutMessage=Request; export const ChildContext={}; export const provide=()=>null;`,
  );
  const m = await discover(f.root);
  assert.equal(m.layouts[1]!.receiver, m.layouts[0]!.id);
  await f.put('src/routes/(group)/layout.ts', `${native} export const provide=()=>null;`);
  await assert.rejects(discover(f.root), /ChildContext and provide/);
});
test('inherited branded params stay owned by ancestor, search defaults stay page-owned', async (t) => {
  const f = await fixture(t);
  const layout = await f.put(
    'src/routes/[id]/layout.ts',
    `${native} import {Id} from '../../domain.ts'; export const route={params:{id:Id}};`,
  );
  await f.put(
    'src/routes/[id]/page.ts',
    `${native} export const route={search:Schema.Struct({tab:searchDefault(Schema.String,'profile')})};`,
  );
  const first = await discover(f.root);
  assert.deepEqual(first.pages[0]!.layouts, [first.layouts[0]!.id]);
  assert.deepEqual(first.layouts[0]!.segments, [{ kind: 'param', name: 'id' }]);
  assert.ok(first.pages[0]!.exports.includes('route'));
  await f.put('src/domain.ts', 'export const Id=Schema.String.pipe(Schema.brand("NewId"));');
  const changed = await discover(f.root);
  assert.notEqual(
    changed.layouts[0]!.fingerprint,
    first.layouts[0]!.fingerprint,
    'inherited brand schema dependency participates in its owner fingerprint',
  );
  assert.equal(
    changed.pages[0]!.fingerprint,
    first.pages[0]!.fingerprint,
    'ancestor compatibility is composed by emitter, not mixed into local source stamp',
  );
  await f.put(
    'src/routes/[id]/page.ts',
    `${native} export const route={search:Schema.Struct({tab:searchDefault(Schema.String,'history')})};`,
  );
  assert.notEqual(
    (await discover(f.root)).pages[0]!.fingerprint,
    first.pages[0]!.fingerprint,
    'page search defaults remain fingerprint significant',
  );
  await f.put(
    'src/routes/[id]/page.ts',
    `${native} import {Id} from '../../domain.ts'; export const route={params:{id:Id}};`,
  );
  await assert.rejects(discover(f.root), /conflicting inherited route.params id/);
  await writeFile(layout, `${native} export const route={search:Schema.Struct({})};`);
  await assert.rejects(discover(f.root), /layout route.search is unsupported/);
});
test('layout view-only fingerprints preserve; source/schema and prefix contracts invalidate', async (t) => {
  const f = await fixture(t);
  const file = await f.put('src/routes/layout.ts', native);
  const token = async () => (await discover(f.root)).layouts[0]!.fingerprint;
  const before = await token();
  await writeFile(file, native.replace('view=()=>null', 'view=()=>123'));
  assert.equal(await token(), before);
  await f.put('src/routes/inactive/layout.ts', native);
  assert.equal(await token(), before, 'unrelated layout additions preserve existing local stamps');
  await writeFile(file, native.replace('Model={}', 'Model={field:1}'));
  assert.notEqual(await token(), before);
});
test('native subscription static keys, local export aliases, and unsupported shapes', async (t) => {
  const f = await fixture(t);
  await f.put(
    'src/routes/page.ts',
    `${native} const local=Subscription.make<Model,Message>()(entry=>({z:entry({}),watch:entry({})})); export {local as subscriptions};`,
  );
  const m = await discover(f.root);
  assert.deepEqual(m.pages[0]!.subscriptionKeys, ['watch', 'z']);
  assert.deepEqual(m.layouts, []);
  for (const expr of [
    'Subscription.make<Model,Message>()(entry=>({...other}))',
    'Subscription.make<Model,Message>()(entry=>({[key]:entry({})}))',
    'dynamic',
    'Subscription.make<Model,Message>()(entry=>getEntries())',
  ]) {
    await f.put('src/routes/page.ts', `${native} export const subscriptions=${expr};`);
    await assert.rejects(discover(f.root), /subscriptions/);
  }
});
test('structured incomplete/parse diagnostics preserve deterministic missing runtime names', async (t) => {
  const f = await fixture(t);
  const file = await f.put(
    'src/routes/layout.ts',
    'export const Model={}; export const view=()=>null;',
  );
  await assert.rejects(discover(f.root), (error: unknown) => {
    const d = error as DiscoveryDiagnostic;
    assert.equal(d.code, 'DISCOVERY_MISSING_EXPORTS');
    assert.equal(d.file, file);
    assert.deepEqual(d.missingExports, ['Message', 'init', 'update']);
    return true;
  });
  await writeFile(file, 'export const Model=;');
  await assert.rejects(
    discover(f.root),
    (error: unknown) => (error as DiscoveryDiagnostic).code === 'DISCOVERY_PARSE_ERROR',
  );
});
