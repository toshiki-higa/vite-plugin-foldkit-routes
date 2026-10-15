import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateRoot } from '../src/generate.ts';
import { linkFixturePackage } from './fixture-package.ts';
import { compileFixture, putFile, runModule, temporaryDirectory } from './fixtures.ts';
// Strict compilation, repeated generation/imports and a fresh Node process share this budget.
test(
  'independent strict fixture: arbitrary ancestry, gates, context, semantic init/inform output and root NotFound',
  { timeout: 30_000 },
  async () => {
    // Canonicalize OS aliases such as macOS /tmp; the writer rejects symlink ancestors.
    const root = await temporaryDirectory(path.join(await realpath(tmpdir()), 'layout-emitter-'));
    const put = (file: string, content: string) => putFile(root, file, content);
    await linkFixturePackage(root);
    await put(
      'src/domain.ts',
      `import { Schema,Context as NativeContext } from 'effect';export const Store=NativeContext.Service<{readonly label:string}>('Fixture/Store');export const Other=NativeContext.Service<{readonly count:number}>('Fixture/Other');export const Request=Schema.TaggedStruct('Request',{value:Schema.String});export const Context=Schema.Struct({value:Schema.String});`,
    );
    await put(
      'src/routes/layout.ts',
      `import { Schema } from 'effect';import {Request,Context,Store} from '../domain.ts';import {Option,Effect} from 'effect';import {Command} from 'foldkit';import type {View} from './layout.gen.ts';export const Model=Schema.Struct({received:Schema.Array(Schema.String),sealed:Schema.Boolean});export const Message=Schema.TaggedStruct('Noop',{});export const ChildOutMessage=Request;export const Reply=Command.define('Reply',{messages:[Message],execute:Effect.gen(function*(){yield* Store;return Message.make({});})});export const ChildContext=Context;export const provide=(model:typeof Model.Type)=>model.sealed?Option.none():Option.some({key:'root',context:{value:'outer'}});export const init=()=>({model:{received:[] as string[],sealed:false}});export const update=(model:typeof Model.Type)=>({model});export const onChildOutMessage=(model:typeof Model.Type,request:typeof Request.Type)=>({model:{...model,received:[...model.received,request.value],sealed:request.value==='read:two'},commands:[Reply()]});export const view:View=(_model,input,h)=>h.div([],[input.outlet()]);`,
    );
    await put(
      'src/routes/a/layout.ts',
      `import {Option,Schema} from 'effect';import {Context,Request} from '../../domain.ts';import type {View} from './layout.gen.ts';export const Model=Schema.Struct({ready:Schema.Boolean,key:Schema.String,value:Schema.String,received:Schema.Int});export const Message=Schema.Union([Schema.TaggedStruct('Open',{}),Schema.TaggedStruct('Close',{}),Schema.TaggedStruct('Value',{value:Schema.String}),Schema.TaggedStruct('Key',{key:Schema.String})]);export const ChildContext=Context;export const ChildOutMessage=Request;export const OutMessage=Request;export const onChildOutMessage=(model:typeof Model.Type,request:typeof Request.Type)=>({model:{...model,received:model.received+1},outMessage:request});export const init=()=>({model:{ready:false,key:'first',value:'one',received:0},outMessage:Request.make({value:'owner:init'})});export const update=(model:typeof Model.Type,message:typeof Message.Type)=>({model:message._tag==='Open'?{...model,ready:true}:message._tag==='Close'?{...model,ready:false}:message._tag==='Value'?{...model,value:message.value}:{...model,key:message.key}});export const provide=(model:typeof Model.Type)=>model.ready?Option.some({key:model.key,context:{value:model.value}}):Option.none();export const view:View=(_model,input,h)=>h.div([],[input.outlet()]);`,
    );
    for (const directory of ['a/(b)', 'a/(b)/(c)'])
      await put(
        `src/routes/${directory}/layout.ts`,
        `import {Schema} from 'effect';import type {View} from './layout.gen.ts';export const Model=Schema.Struct({privateCount:Schema.Int});export const Message=Schema.TaggedStruct('Tick',{});export const init=()=>({model:{privateCount:0}});export const update=(model:typeof Model.Type)=>({model:{privateCount:model.privateCount+1}});export const view:View=(_model,input,h)=>h.div([],[input.outlet()]);`,
      );
    const leaf = `import {Schema,Effect} from 'effect';import {Command} from 'foldkit';import {Request,Store,Other} from '../../../../../domain.ts';import type {Input,InputChange,View,Return} from './route.gen.ts';export const Model=Schema.Struct({seen:Schema.String});export const Message=Schema.Union([Schema.TaggedStruct('Read',{}),Schema.TaggedStruct('Done',{})]);export const Start=Command.define('LeafInit',{messages:[Message],execute:Effect.succeed({_tag:'Done'} as const)});export const Fetch=Command.define('Fetch',{messages:[Message],execute:Effect.gen(function*(){yield* Other;return {_tag:'Done'} as const;})});export const Ping=Command.define('Ping',{messages:[Message],execute:Effect.gen(function*(){yield* Store;return {_tag:'Done'} as const;})});export const OutMessage=Request;export const init=(input:Input)=>({model:{seen:input.context.value},outMessage:Request.make({value:'init:'+input.context.value}),commands:[Start()]});export const update=(model:typeof Model.Type,message:typeof Message.Type,input:Input)=>message._tag==='Read'?{model:{seen:input.context.value},outMessage:Request.make({value:'read:'+input.context.value}),commands:[Fetch()]}:{model,commands:[Ping()]};export const inform=(model:typeof Model.Type,change:InputChange):Return<never>=>({model:{seen:change.current.context.value},outMessage:Request.make({value:'inform:'+change.current.context.value})});export const view:View=(model,_input,h)=>h.div([],[model.seen]);`;
    // A newly added nested layout need not already have any page. It must
    // typecheck and remain inert even while all its ancestors are active.
    await put(
      'src/routes/a/(b)/(c)/unused/layout.ts',
      `import {Schema} from 'effect';import type {View} from './layout.gen.ts';export const Model=Schema.Struct({privateValue:Schema.Int});export const Message=Schema.TaggedStruct('Tick',{});export const init=()=>({model:{privateValue:0}});export const update=(model:typeof Model.Type)=>({model});export const view:View=(_model,input,h)=>h.div([],[input.outlet()]);`,
    );
    await put('src/routes/a/(b)/(c)/x/page.ts', leaf);
    await put('src/routes/a/(b)/(c)/y/page.ts', leaf);
    await put(
      'src/requirements.type-test.ts',
      `import {Effect} from 'effect';import type * as G from './app.gen.ts';import {Store,Other} from './domain.ts';declare const result:G.Return;declare const required:G.Requirements;const exact:typeof Store.Service|typeof Other.Service=required;const reverse:G.Requirements=exact;void reverse;\n// @ts-expect-error Native service R must not be erased\nEffect.runSync(result.commands![0]!.effect);\nEffect.runSync(result.commands![0]!.effect.pipe(Effect.provideService(Store,{label:'local'}),Effect.provideService(Other,{count:1})));`,
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
    await generateRoot(root);
    compileFixture(root, ['-p', path.join(root, 'tsconfig.json')]);
    const G = await import(pathToFileURL(path.join(root, 'src/app.gen.ts')).href);
    const { Url } = await import('foldkit');
    const url = (pathname: string) => Url.fromString('https://fixture.invalid' + pathname);
    // Native Url constructor in the fixture uses the same public parser as app init.
    const { Option } = await import('effect');
    const initUrl = (pathname: string) => {
      const parsed = url(pathname);
      assert.ok(Option.isSome(parsed));
      return parsed.value;
    };
    let model = G.init(initUrl('/a/x')).model;
    assert.equal(model.page._tag, 'Gated');
    const gatedSnapshot = JSON.parse(JSON.stringify(model));
    const ids = Object.keys(model.layouts);
    const rootId = ids.find((id) => model.layouts[id]?.model.received !== undefined)!;
    const providerId = ids.find((id) => model.layouts[id]?.model.ready !== undefined)!;
    const send = (tag: string, message: unknown) => {
      const result = G.update(
        model,
        G.Message[tag]({ occurrence: model.layouts[tag].occurrence, message }),
      );
      model = result.model;
      return result;
    };
    const opened = send(providerId, { _tag: 'Open' });
    assert.deepEqual(
      opened.commands.map((command: { name: string }) => command.name),
      ['LeafInit', 'Reply'],
    );
    const { Effect } = await import('effect');
    const oldCompletion = Effect.runSync(opened.commands[0].effect);
    assert.equal(model.page._tag, '/a/x');
    assert.equal(Object.values(model.layouts).filter((value) => value === null).length, 1);
    assert.deepEqual(model.layouts[rootId].model.received, ['owner:init', 'init:one']);
    const occurrence = model.page.occurrence;
    const activeSnapshot = JSON.parse(JSON.stringify(model));
    const { Schema: ActiveSchema } = await import('effect');
    const tamperedLayout = structuredClone(activeSnapshot);
    tamperedLayout.layouts[providerId].definition = 'incompatible';
    assert.throws(() => ActiveSchema.decodeUnknownSync(G.Model)(tamperedLayout));
    // Nullable defaults apply to missing keys, never invalid PRESENT states.
    const tamperedPrivateModel = structuredClone(activeSnapshot);
    tamperedPrivateModel.layouts[providerId].model.ready = 'not a boolean';
    assert.throws(() => ActiveSchema.decodeUnknownSync(G.Model)(tamperedPrivateModel));
    send(providerId, { _tag: 'Value', value: 'two' });
    assert.equal(model.page.occurrence, occurrence);
    assert.equal(model.page.model.seen, 'two');
    assert.deepEqual(model.layouts[rootId].model.received, [
      'owner:init',
      'init:one',
      'inform:two',
    ]);
    send(providerId, { _tag: 'Key', key: 'second' });
    assert.ok(model.page.occurrence > occurrence);
    const parentOccurrence = model.layouts[providerId].occurrence;
    model = G.update(model, G.Message.ChangedUrl({ url: initUrl('/a/y') })).model;
    assert.equal(model.layouts[providerId].occurrence, parentOccurrence);
    // A semantic receiver closes an already-visited ancestor gate.
    model = G.update(
      model,
      G.Message['/a/y']({ occurrence: model.page.occurrence, message: { _tag: 'Read' } }),
    ).model;
    assert.equal(model.page._tag, 'Gated');
    assert.equal(model.layouts[providerId], null);
    assert.equal(model.layouts[rootId].model.sealed, true);
    const retired = model;
    model = G.update(model, oldCompletion).model;
    assert.deepEqual(model, retired);
    model = G.update(model, G.Message.ChangedUrl({ url: initUrl('/missing') })).model;
    assert.equal(model.page._tag, 'NotFound');
    assert.notEqual(model.layouts[rootId], null);
    assert.equal(model.layouts[providerId], null);
    // Unrelated layout addition defaults a new state slot to null on restore,
    // while gated destinations carry graph acceptance compatibility.
    await put(
      'src/routes/z/layout.ts',
      `import {Schema} from 'effect';import type {View} from './layout.gen.ts';export const Model=Schema.Struct({value:Schema.Int});export const Message=Schema.TaggedStruct('Tick',{});export const init=()=>({model:{value:0}});export const update=(model:typeof Model.Type)=>({model});export const view:View=(_model,input,h)=>h.div([],[input.outlet()]);`,
    );
    await put(
      'src/routes/z/page.ts',
      `import type {View} from './route.gen.ts';export const view:View=(_input,h)=>h.div([],['z']);`,
    );
    await generateRoot(root);
    const G2 = await import(pathToFileURL(path.join(root, 'src/app.gen.ts')).href + '?added');
    const { Schema } = await import('effect');
    const restored = Schema.decodeUnknownSync(G2.Model)(activeSnapshot);
    assert.equal(Object.keys(restored.layouts).length, ids.length + 1);
    assert.equal(restored.page.occurrence, occurrence);
    assert.throws(() => Schema.decodeUnknownSync(G2.Model)(gatedSnapshot));
    const ownerFile = 'src/routes/layout.ts';
    const ownerSource = await readFile(path.join(root, ownerFile), 'utf8');
    await put(
      ownerFile,
      ownerSource.replace(
        'h.div([],[input.outlet()])',
        "h.div([],[h.div([],['view edit']),input.outlet()])",
      ),
    );
    await generateRoot(root);
    const GView = await import(pathToFileURL(path.join(root, 'src/app.gen.ts')).href + '?view');
    assert.doesNotThrow(() => Schema.decodeUnknownSync(GView.Model)(activeSnapshot));
    // A semantic ancestor edit invalidates every active descendant stamp. This
    // variant also deliberately oscillates activation via initializer output.
    await put(ownerFile, ownerSource.replace("key:'root'", 'key:String(model.received.length)'));
    await generateRoot(root);
    const GCycle = await import(pathToFileURL(path.join(root, 'src/app.gen.ts')).href + '?cycle');
    assert.throws(() => Schema.decodeUnknownSync(GCycle.Model)(activeSnapshot));
    // Check the descendant separately so rejection cannot be explained only
    // by the changed ancestor's own local definition.
    assert.throws(() => Schema.decodeUnknownSync(GCycle.PageState)(activeSnapshot.page));
    runModule(
      root,
      `import assert from 'node:assert/strict';import * as G from './src/app.gen.ts';import {Url} from 'foldkit';import {Option} from 'effect';assert.throws(()=>G.init(Option.getOrThrow(Url.fromString('https://fixture.invalid/a/x'))),/did not stabilize/);`,
    );
  },
);
