import assert from 'node:assert/strict';
import { access, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { test } from 'vite-plus/test';
import { linkFixturePackage } from './fixture-package.ts';
import { compileFixture, temporaryDirectory } from './fixtures.ts';

const project = path.resolve(import.meta.dirname, '..');

test('minimal example builds from authored files and strictly connects to the native Runtime', async () => {
  const root = await temporaryDirectory(path.join(project, '.test-output-example-'));
  await cp(path.join(project, 'examples/basic'), root, {
    recursive: true,
    filter: (file) =>
      !file.endsWith('.gen.ts') && !['dist', 'node_modules'].includes(path.basename(file)),
  });
  // Keep the copied consumer's compiler config self-contained.
  await cp(path.join(project, 'tsconfig.base.json'), path.join(root, 'tsconfig.base.json'));
  const config = JSON.parse(await readFile(path.join(root, 'tsconfig.json'), 'utf8'));
  await writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ ...config, extends: './tsconfig.base.json' }),
  );
  await linkFixturePackage(root);
  await mkdir(path.join(root, 'node_modules/@foldkit'));
  await symlink(
    path.join(project, 'node_modules/@foldkit/vite-plugin'),
    path.join(root, 'node_modules/@foldkit/vite-plugin'),
    'dir',
  );
  await assert.rejects(access(path.join(root, 'src/app.gen.ts')), { code: 'ENOENT' });

  await build({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    logLevel: 'silent',
  });
  await access(path.join(root, 'src/app.gen.ts'));
  await access(path.join(root, 'src/routes/route.gen.ts'));
  await access(path.join(root, 'src/routes/about/route.gen.ts'));
  assert.match(await readFile(path.join(root, 'dist/index.html'), 'utf8'), /assets\/.*\.js/);

  compileFixture(root, [
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
    'src/entry.ts',
    'vite.config.ts',
  ]);
});
