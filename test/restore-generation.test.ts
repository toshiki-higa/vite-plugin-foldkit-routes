import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateRoot } from '../src/generate.ts';
import { linkFixturePackage } from './fixture-package.ts';
import { compileFixture, putFile, runModule, temporaryDirectory } from './fixtures.ts';

const base = path.resolve(import.meta.dirname, '..');
// Many independent compiler and Node process assertions need more than the default timeout.
test(
  'strict generated restore: affinity, one pass, fresh contexts, native requirements, fail-closed topology',
  { timeout: 30_000 },
  async () => {
    const root = await temporaryDirectory(path.join(base, '.test-output-restore-'));
    const put = (file: string, source: string) => putFile(root, file, source);
    await linkFixturePackage(root);
    await put(
      'src/domain.ts',
      `import {Context,Schema} from 'effect';
export const A=Context.Service<{readonly label:string}>('Restore/A');
export const B=Context.Service<{readonly label:string}>('Restore/B');
export const Id=Schema.String.pipe(Schema.brand('Restore/Id'));
export const Child=Schema.Struct({value:Schema.String});`,
    );
    const rootSource = `import {Effect,Option,Schema} from 'effect';import {Command} from 'foldkit';
import {A,Child} from '../domain.ts';import type {View} from './layout.gen.ts';
export const Model=Schema.Struct({key:Schema.String,open:Schema.Boolean,value:Schema.String,calls:Schema.Int});
export const Message=Schema.TaggedStruct('Open',{});export const ChildContext=Child;
export const provide=(model:typeof Model.Type)=>model.open?Option.some({key:model.key,context:{value:model.value}}):Option.none();
export const init=()=>({model:{key:'one',open:true,value:'before',calls:0}});
export const update=(model:typeof Model.Type)=>({model:{...model,open:true}});
export const Read=Command.define('RestoreRootRead',{messages:[Message],execute:Effect.gen(function*(){yield* A;return Message.make({});})});
export const restore=(model:typeof Model.Type)=>({model:{...model,value:'after',calls:model.calls+1},commands:[Read()]});
export const view:View=(_model,input,h)=>h.div([],[input.outlet()]);`;
    await put('src/routes/layout.ts', rootSource);
    const middle = `import {Schema} from 'effect';import {Id} from '../../domain.ts';import type {Input,View} from './layout.gen.ts';
export const route={params:{id:Id}};
export const Model=Schema.Struct({seen:Schema.String,calls:Schema.Int});export const Message=Schema.TaggedStruct('Noop',{});
export const init=(input:Input)=>({model:{seen:input.context.value,calls:0}});
export const update=(model:typeof Model.Type)=>({model});
export const restore=(model:typeof Model.Type,input:Input)=>({model:{seen:input.context.value,calls:model.calls+1}});
export const view:View=(_model,input,h)=>h.div([],[input.outlet()]);`;
    await put('src/routes/[id]/layout.ts', middle);
    const leaf = `import {Effect,Schema} from 'effect';import {Command} from 'foldkit';import {B} from '../../domain.ts';import type {Input,View} from './route.gen.ts';
export const route={search:Schema.Struct({q:Schema.String})};
export const Model=Schema.Struct({seen:Schema.String,calls:Schema.Int});export const Message=Schema.TaggedStruct('Noop',{});
export const init=(input:Input)=>({model:{seen:input.context.value,calls:0}});export const update=(model:typeof Model.Type)=>({model});
export const Read=Command.define('RestoreLeafRead',{messages:[Message],execute:Effect.gen(function*(){yield* B;return Message.make({});})});
export const restore=(model:typeof Model.Type,input:Input)=>({model:{seen:input.context.value,calls:model.calls+1},commands:[Read()]});
export const view:View=(model,_input,h)=>h.p([],[model.seen]);`;
    await put('src/routes/[id]/page.ts', leaf);
    await put(
      'src/routes/plain/page.ts',
      `import type {View} from './route.gen.ts';export const view:View=(_input,h)=>h.p([],['plain']);`,
    );
    await put(
      'src/requirements.ts',
      `import {Effect} from 'effect';import type * as G from './app.gen.ts';import {A,B} from './domain.ts';
declare const r:G.Requirements;const exact:typeof A.Service|typeof B.Service=r;const back:G.Requirements=exact;void back;
declare const result:Extract<G.RestoreDecision,{_tag:'Resume'}>['result'];
// @ts-expect-error restore-only native services must not be erased
Effect.runSync(result.commands![0]!.effect);
Effect.runSync(result.commands![0]!.effect.pipe(Effect.provideService(A,{label:'a'}),Effect.provideService(B,{label:'b'})));`,
    );
    await put(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          allowImportingTsExtensions: true,
          noEmit: true,
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          noImplicitReturns: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      }),
    );
    const strict = () => compileFixture(root, ['-p', path.join(root, 'tsconfig.json')]);
    const run = (source: string) =>
      runModule(
        root,
        `import assert from 'node:assert/strict';import {Option,Effect} from 'effect';import {Url} from 'foldkit';import * as G from './src/app.gen.ts';import {A,B} from './src/domain.ts';const url=p=>Option.getOrThrow(Url.fromString('https://restore.invalid'+p));${source}`,
      );
    await generateRoot(root);
    strict();
    run(`const initial=G.init(url('/one?q=x')).model;const snapshot=structuredClone(initial);
assert.equal(G.canRestoreAt(initial,url('/two?q=x')),false);
assert.equal(G.restore(initial,url('/two?q=x')).reason,'UrlMismatch');
assert.equal(G.restore(initial,url('/one?q=y')).reason,'UrlMismatch');
const restored=G.restore(initial,url('/one?q=x#ignored'));assert.equal(restored._tag,'Resume');
assert.deepEqual(initial,snapshot);assert.equal(restored.result.model.page.model.seen,'after');
assert.equal(restored.result.model.page.model.calls,1);
for(const state of Object.values(restored.result.model.layouts))if(state)assert.equal(state.model.calls,1);
assert.deepEqual(restored.result.commands.map(c=>c.name),['RestoreRootRead','RestoreLeafRead']);
assert.equal(restored.result.model.serial,initial.serial);
const completed=Effect.runSync(restored.result.commands[1].effect.pipe(Effect.provideService(A,{label:'a'}),Effect.provideService(B,{label:'b'})));
assert.equal(completed.occurrence,initial.page.occurrence);assert.equal(completed._tag,'/[id]');
const corrupt=structuredClone(initial);corrupt.page.scope='wrong';assert.equal(G.restore(corrupt,url('/one?q=x')).reason,'InvalidTree');
const notFound=G.init(url('/missing/path')).model;const nf=G.restore(notFound,url('/missing/path'));assert.equal(nf._tag,'Resume');assert.deepEqual(nf.result.commands.map(c=>c.name),['RestoreRootRead']);`);
    // Missing inactive owners do not veto a different active route.
    await put('src/routes/[id]/page.ts', leaf.replace(/export const restore=.*?;\n/, ''));
    await generateRoot(root);
    strict();
    run(
      `assert.equal(G.restore(G.init(url('/one?q=x')).model,url('/one?q=x')).reason,'MissingOwnerRestore');assert.equal(G.restore(G.init(url('/plain')).model,url('/plain'))._tag,'Resume');`,
    );
    await put('src/routes/[id]/page.ts', leaf);
    for (const replacement of [
      "value:'after',key:'changed',calls",
      "value:'after',open:false,calls",
    ]) {
      await put('src/routes/layout.ts', rootSource.replace("value:'after',calls", replacement));
      await generateRoot(root);
      strict();
      run(
        `const model=G.init(url('/one?q=x')).model;const decision=G.restore(model,url('/one?q=x'));assert.equal(decision._tag,'Reset');assert.equal(decision.reason,'TopologyChanged');assert.ok(!('result' in decision));`,
      );
    }
    // Restore must remain a native no-OutMessage callback, not an implicit emitter.
    await put('src/routes/layout.ts', rootSource);
    await put(
      'src/routes/[id]/page.ts',
      leaf.replace(
        'commands:[Read()]',
        "commands:[Read()],outMessage:{_tag:'Unexpected'} as const",
      ),
    );
    await generateRoot(root);
    const negative = spawnSync(
      path.join(base, 'node_modules/.bin/tsc'),
      ['-p', path.join(root, 'tsconfig.json')],
      { encoding: 'utf8' },
    );
    assert.notEqual(negative.status, 0);
    assert.match(negative.stdout + negative.stderr, /outMessage|Restore|Unexpected/);
    // restore body participates in compatibility, unlike a direct view body.
    const generated = await readFile(path.join(root, 'src/app.gen.ts'), 'utf8');
    assert.match(generated, /restoreUpdateP/);
  },
);
