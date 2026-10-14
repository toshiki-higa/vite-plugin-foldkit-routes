import { readFile } from 'node:fs/promises';
import { parseSync } from 'vite';

export type SourceFile = {
  source: string;
  parsed: ReturnType<typeof parseSync>;
};
export type SourceCache = Map<string, Promise<SourceFile>>;
export type SourceLoader = (file: string) => Promise<SourceFile>;

/** One source/AST snapshot per file in a discovery invocation. Consumers own diagnostics. */
export function sourceLoader(cache: SourceCache): SourceLoader {
  return (file) => {
    let pending = cache.get(file);
    if (!pending) {
      pending = (async () => {
        const source = await readFile(file, 'utf8');
        return { source, parsed: parseSync(file, source) };
      })();
      cache.set(file, pending);
    }
    return pending;
  };
}
