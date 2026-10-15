import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vite-plus/test';
import { generateRoot } from 'vite-plugin-foldkit-routes';
import { putFile, temporaryDirectory } from './fixtures.ts';

test('generated tree uses the shared route declarations and keeps transition internal', async () => {
  const root = await temporaryDirectory(
    path.resolve(import.meta.dirname, '..', '.test-output-emission-'),
  );
  await putFile(
    root,
    'src/routes/[team]/layout.ts',
    `
import { Schema } from 'effect';
import { defineMessageUnion } from 'foldkit/message';
export const Model=Schema.Struct({count:Schema.Int});
export const Message=defineMessageUnion({Increment:{}});
export const init=()=>({model:Model.make({count:0})});
export const update=(model)=>({model});
export const route={params:{team:Schema.String}};
export const view=(_model,_input,h)=>h.div([],[]);
`,
  );
  await putFile(
    root,
    'src/routes/[team]/[...path]/page.ts',
    `
import { Schema } from 'effect';
export const route={params:{path:Schema.String},search:Schema.Struct({q:Schema.String})};
export const view=(_input,h)=>h.div([],[]);
`,
  );
  await generateRoot(root);
  const source = await readFile(path.join(root, 'src/app.gen.ts'), 'utf8');
  assert.match(source, /const Params0=Schema\.Struct/);
  assert.match(source, /const Search0=Runtime\.searchSchema/);
  assert.match(source, /params:Params0,search:Search0/);
  assert.match(source, /Schema\.NonEmptyArray\(Runtime\.paramSchema/);
  assert.match(source, /\.\.\.\(\{\.\.\.\{params:\{\}\},\.\.\.L0\.route\}\)\.params/);
  assert.match(source, /const transition=/);
  assert.doesNotMatch(source, /export const transition=/);
  assert.match(source, /export const init=/);
  assert.match(source, /export const update=/);
  assert.deepEqual((await generateRoot(root)).written, []);
});
