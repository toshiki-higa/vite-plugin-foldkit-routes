import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { onTestFinished } from 'vite-plus/test';

/** The caller chooses the location; package consumers can stay outside the project. */
export async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(prefix);
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

export async function putFile(root: string, file: string, content: string): Promise<void> {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** Successful infrastructure commands only; negative compiler checks keep their own assertions. */
export function runProcess(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} (cwd: ${cwd})\nstatus: ${result.status}; signal: ${result.signal}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
      { cause: result.error },
    );
  }
  return result.stdout;
}

/** Compiler arguments are deliberately supplied by each scenario. */
export function compileFixture(root: string, args: readonly string[]): string {
  return runProcess(path.resolve(import.meta.dirname, '../node_modules/.bin/tsc'), args, root);
}

export function runModule(root: string, source: string): string {
  return runProcess(process.execPath, ['--input-type=module', '-e', source], root);
}
