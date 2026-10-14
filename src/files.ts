import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
export const GENERATED_MARKER = '// @generated vite-plugin-foldkit-routes; DO NOT EDIT';
export type GeneratedFile = { path: string; content: string };
export type WriteResult = {
  written: readonly string[];
  unchanged: readonly string[];
  removed: readonly string[];
};
const owned = (text: string) =>
  text === GENERATED_MARKER || text.startsWith(GENERATED_MARKER + '\n');
async function safeDirectory(directory: string): Promise<void> {
  // Existing descendants can hide a symlink ancestor too; inspect the whole
  // chain rather than checking ancestors only while creating missing folders.
  const parent = path.dirname(directory);
  if (parent !== directory) await safeDirectory(parent);
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`Unsafe output directory: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(directory);
  }
}
export async function writeGenerated(
  directory: string,
  files: readonly GeneratedFile[],
): Promise<WriteResult> {
  directory = path.resolve(directory);
  const desired = new Map<string, string>();
  for (const file of files) {
    const name = file.path;
    if (
      !name ||
      path.isAbsolute(name) ||
      name.includes('\\') ||
      name.split('/').some((p) => !p || p === '.' || p === '..')
    )
      throw new Error(`Invalid generated path: ${name}`);
    if (desired.has(name)) throw new Error(`Duplicate generated path: ${name}`);
    desired.set(name, owned(file.content) ? file.content : GENERATED_MARKER + '\n' + file.content);
  }
  await safeDirectory(directory);
  const current = new Map<string, string>();
  async function scan(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name),
        relative = path.relative(directory, file).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        if ([...desired.keys()].some((n) => n === relative || n.startsWith(relative + '/')))
          throw new Error(`Generated path traverses symlink: ${relative}`);
        continue;
      }
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile()) current.set(relative, await readFile(file, 'utf8'));
    }
  }
  await scan(directory);
  // Validate all collisions before changing any file.
  for (const name of desired.keys()) {
    const old = current.get(name);
    if (old !== undefined && !owned(old))
      throw new Error(`Refusing to overwrite unowned file: ${name}`);
    await safeDirectory(path.dirname(path.join(directory, name)));
    try {
      const stat = await lstat(path.join(directory, name));
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`Unsafe generated target: ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const written: string[] = [],
    unchanged: string[] = [],
    removed: string[] = [];
  for (const name of [...desired.keys()].sort()) {
    const content = desired.get(name)!;
    if (current.get(name) === content) {
      unchanged.push(name);
      continue;
    }
    const target = path.join(directory, name),
      temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, content, { flag: 'wx' });
      await rename(temporary, target);
      written.push(name);
    } finally {
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
  for (const name of [...current.keys()].sort())
    if (!desired.has(name) && owned(current.get(name)!)) {
      await unlink(path.join(directory, name));
      removed.push(name);
    }
  return { written, unchanged, removed };
}
