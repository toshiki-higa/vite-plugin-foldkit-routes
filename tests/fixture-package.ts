import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { putFile } from './fixtures.ts';

const project = path.resolve(import.meta.dirname, '..');

/** Keep package links local: the project's node_modules may be a shared symlink. */
export async function linkFixturePackage(root: string): Promise<void> {
  const modules = path.join(root, 'node_modules');
  await mkdir(modules);
  await symlink(project, path.join(modules, 'vite-plugin-foldkit-routes'), 'dir');
  for (const dependency of ['effect', 'foldkit', 'vite', '@types/node']) {
    const target = path.join(modules, dependency);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(path.join(project, 'node_modules', dependency), target, 'dir');
  }
  // Fixtures are standalone ESM consumers, not descendants of the project config.
  await putFile(root, 'package.json', JSON.stringify({ private: true, type: 'module' }));
}
