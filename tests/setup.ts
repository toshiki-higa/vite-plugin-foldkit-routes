import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

// Compiled-package consumers need actual dist files, even on a fresh checkout.
// Vitest global setup runs once before collecting any test files.
export default async function setup() {
  await promisify(execFile)('pnpm', ['build'], {
    cwd: path.resolve(import.meta.dirname, '..'),
  });
}
