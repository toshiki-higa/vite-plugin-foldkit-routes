import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { GENERATED_MARKER, writeGenerated } from '../src/files.ts';
import { temporaryDirectory } from './fixtures.ts';
test('atomic changed-only writes and marker-limited stale cleanup', async () => {
  const dir = await temporaryDirectory(
    path.resolve(import.meta.dirname, '..', '.test-output-writer-'),
  );
  await writeFile(path.join(dir, 'keep.txt'), 'authored');
  assert.deepEqual(
    await writeGenerated(dir, [
      { path: 'b.ts', content: 'b' },
      { path: 'a.ts', content: 'a' },
    ]),
    { written: ['a.ts', 'b.ts'], unchanged: [], removed: [] },
  );
  const before = await stat(path.join(dir, 'a.ts'));
  assert.deepEqual(await writeGenerated(dir, [{ path: 'a.ts', content: 'a' }]), {
    written: [],
    unchanged: ['a.ts'],
    removed: ['b.ts'],
  });
  assert.equal((await stat(path.join(dir, 'a.ts'))).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(path.join(dir, 'keep.txt'), 'utf8'), 'authored');
  assert.equal(await readFile(path.join(dir, 'a.ts'), 'utf8'), GENERATED_MARKER + '\na');
  assert.deepEqual((await readdir(dir)).sort(), ['a.ts', 'keep.txt']);
});
test('collisions, invalid paths and symlinks fail without overwriting authored data', async () => {
  const dir = await temporaryDirectory(
    path.resolve(import.meta.dirname, '..', '.test-output-writer-'),
  );
  await writeFile(path.join(dir, 'authored.ts'), 'keep');
  await assert.rejects(
    writeGenerated(dir, [
      { path: 'new.ts', content: 'new' },
      { path: 'authored.ts', content: 'bad' },
    ]),
    /unowned/,
  );
  assert.deepEqual(await readdir(dir), ['authored.ts']);
  for (const name of ['../escape.ts', '/tmp/escape.ts', 'a/../b', 'a//b'])
    await assert.rejects(writeGenerated(dir, [{ path: name, content: '' }]), /Invalid/);
  await symlink(dir, path.join(dir, 'link'));
  await assert.rejects(writeGenerated(dir, [{ path: 'link/x', content: '' }]), /symlink/);
  assert.equal(await readFile(path.join(dir, 'authored.ts'), 'utf8'), 'keep');
  await mkdir(path.join(dir, 'existing'));
  await assert.rejects(
    writeGenerated(path.join(dir, 'link/existing'), [{ path: 'x.gen.ts', content: 'bad' }]),
    /Unsafe output directory/,
  );
  assert.deepEqual(
    await readdir(path.join(dir, 'existing')),
    [],
    'existing output directory must not hide a symlink ancestor',
  );
  await assert.rejects(
    writeGenerated(dir, [{ path: 'authored.ts/child.gen.ts', content: 'bad' }]),
    /Unsafe output directory/,
  );
  await assert.rejects(
    writeGenerated(dir, [
      { path: 'duplicate.gen.ts', content: 'one' },
      { path: 'duplicate.gen.ts', content: 'two' },
    ]),
    /Duplicate generated path/,
  );
  assert.equal(await readFile(path.join(dir, 'authored.ts'), 'utf8'), 'keep');
});
