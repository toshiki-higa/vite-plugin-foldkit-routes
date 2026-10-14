import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { discover } from './discover.ts';
import { emit, mayOverlap } from './emit.ts';
import { writeGenerated } from './files.ts';
import type { Manifest } from './discover.ts';

const hash = (source: string) => createHash('sha256').update(source).digest('hex');
export const generate = async (manifest: Manifest) => {
  // Every page depends on the package-local compiler and helpers, even when
  // it imports no helper itself. Read only; never depend on consumer/vendor files.
  // Packaging preserves module siblings; follow this module's extension.
  const extension = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js';
  const dependencies = [
    './contracts',
    './discover',
    './source',
    './emit',
    './emit-tree',
    './emission',
    './files',
    './generate',
    './runtime',
    './subscriptions',
  ];
  const shared = hash(
    (
      await Promise.all(
        dependencies.map((file) => readFile(new URL(file + extension, import.meta.url), 'utf8')),
      )
    ).join('\n'),
  );
  const ancestors = (ids: readonly string[]) =>
    ids.map((id) => {
      const layout = manifest.layouts.find((l) => l.id === id);
      if (!layout) throw new Error(`Missing layout ${id}`);
      return [id, layout.fingerprint];
    });
  const stamped = {
    ...manifest,
    layouts: manifest.layouts.map((layout) => ({
      ...layout,
      fingerprint: hash(JSON.stringify([layout.fingerprint, shared, ancestors(layout.layouts)])),
    })),
    pages: manifest.pages.map((page, index) => ({
      ...page,
      fingerprint: hash(
        JSON.stringify([
          page.fingerprint,
          shared,
          ancestors(page.layouts),
          manifest.pages
            .slice(0, index)
            .filter((previous) => mayOverlap(previous, page))
            .map((previous) => [
              previous.pattern,
              previous.fingerprint,
              ancestors(previous.layouts),
            ]),
        ]),
      ),
    })),
  };
  return writeGenerated(
    resolve(manifest.root, 'src'),
    emit(stamped).map((file) => ({ path: file.path.slice('src/'.length), content: file.content })),
  );
};
export const generateRoot = async (root: string) => generate(await discover(root));
