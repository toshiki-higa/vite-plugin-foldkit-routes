import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { generateRoot } from '../src/generate.ts';
import { linkFixturePackage } from './fixture-package.ts';
import { compileFixture, putFile, runModule, temporaryDirectory } from './fixtures.ts';

const base = path.resolve(import.meta.dirname, '..');
test('inherited branded params coexist with a search-only page and empty intermediate route config', async () => {
  const root = await temporaryDirectory(path.join(base, '.test-output-desk-generation-'));
  const put = (name: string, source: string) => putFile(root, name, source);
  await linkFixturePackage(root);
  const layout = `import {Schema} from 'effect';import type {View} from './layout.gen.ts';
export const Model=Schema.Struct({count:Schema.Int});export const Message=Schema.TaggedStruct('Tick',{});
export const init=()=>({model:{count:0}});export const update=(model:typeof Model.Type)=>({model});
export const view:View=(_model,input,h)=>h.div([],[input.outlet()]);`;
  await put(
    'src/routes/teams/[id]/layout.ts',
    layout +
      `
export const Id=Schema.String.pipe(Schema.brand('TeamId'));export const route={params:{id:Id}};`,
  );
  await put('src/routes/teams/[id]/(group)/layout.ts', layout + '\nexport const route={};');
  await put(
    'src/routes/teams/[id]/(group)/page.ts',
    `import {Schema} from 'effect';import type {Input,View} from './route.gen.ts';import {Id} from '../layout.ts';
export const route={search:Schema.Struct({q:Schema.String})};
export const view:View=({params,search},h)=>h.p([],[params.id,search.q]);
export function typeProof(input:Input){const branded:typeof Id.Type=input.params.id;void branded;
// @ts-expect-error ancestor brand is retained, not widened to string
const wrong:Input['params']={id:'unbranded'};void wrong;}`,
  );
  await put(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
        allowImportingTsExtensions: true,
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
  const output = runModule(
    root,
    `
import assert from 'node:assert/strict';import {Option} from 'effect';import {Url} from 'foldkit';
import * as App from './src/app.gen.ts';import {Id} from './src/routes/teams/[id]/layout.ts';
assert.equal(App.href({to:'/teams/[id]',params:{id:Id.make('acme')},search:{q:'refund'}}),'/teams/acme?q=refund');
const model=App.init(Option.getOrThrow(Url.fromString('https://desk.invalid/teams/acme?q=refund'))).model;
assert.equal(model.page._tag,'/teams/[id]');assert.equal(model.page.input.params.id,'acme');assert.equal(model.page.input.search.q,'refund');
console.log('brand/search/runtime pass');`,
  );
  assert.match(output, /brand\/search\/runtime pass/);
});
