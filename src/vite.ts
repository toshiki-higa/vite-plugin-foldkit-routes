import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { discover, type DiscoveryDiagnostic, type Manifest } from './discover.ts';
import type { WriteResult } from './files.ts';
// Publication paths are relative to root/src, as returned by writeGenerated.
// Observer-only callbacks can continue returning void.
export type Generate = (manifest: Manifest) => Promise<void | WriteResult> | void | WriteResult;
export function fileRoutesPlugin(options: {
  root?: string;
  generate: Generate;
  reloadOnStructure?: boolean;
}): Plugin {
  let root = path.resolve(options.root ?? process.cwd());
  let tail: Promise<void> = Promise.resolve();
  let failure: Error | undefined;
  let recoveryPending = false;
  let dirty = false;
  let running: Promise<void> | undefined;
  let server: ViteDevServer | undefined;
  function compile(): Promise<void> {
    // Mark pending synchronously. Same-turn saves share one read; saves during
    // generation require a final read, never parallel publication or stale success.
    dirty = true;
    if (running) return running;
    const task = Promise.resolve().then(async () => {
      while (dirty) {
        dirty = false;
        try {
          const recovering = failure !== undefined;
          const publication = await options.generate(await discover(root));
          if (publication && server) {
            // The authored event can reach official Foldkit before Chokidar's
            // separate output event (which may also coalesce). Invalidate only
            // changed physical outputs now, so reload/HTTP sees the new schema.
            // Do not dispatch HMR or filter ordinary authored update modules.
            const outputRoot = path.join(root, 'src');
            for (const name of [...publication.written, ...publication.removed]) {
              const file = path.resolve(outputRoot, name),
                relative = path.relative(outputRoot, file);
              if (
                !relative ||
                relative === '..' ||
                relative.startsWith('..' + path.sep) ||
                path.isAbsolute(relative)
              )
                throw new Error(`Invalid publication path: ${name}`);
              for (const environment of Object.values(server.environments)) {
                for (const module of environment.moduleGraph.getModulesByFile(file) ?? [])
                  environment.moduleGraph.invalidateModule(module);
              }
            }
          }
          failure = undefined;
          if (recovering) recoveryPending = true;
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      }
      running = undefined;
      if (failure) throw failure;
    });
    running = task;
    tail = task.catch(() => {});
    return task.then(async () => {
      if (!recoveryPending || !server) return;
      // An invalid never-imported page may disappear without changing any output.
      // Wait for all queued work before clearing the overlay with one cold reload.
      await settled();
      if (!recoveryPending) return;
      recoveryPending = false;
      server.environments.client.moduleGraph.invalidateAll();
      server.ws.send({ type: 'full-reload', path: '*' });
    });
  }
  function inSourceTree(file: string): boolean {
    return ['src', 'lib'].some((tree) => {
      const relative = path.relative(path.join(root, tree), path.resolve(file));
      return (
        relative === '' ||
        (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
      );
    });
  }
  function relevant(file: string): boolean {
    // Emitted registries and same-directory atomic writer temporaries are outputs,
    // not authored route inputs. Ignore them in both watcher and HMR paths.
    const basename = path.basename(file);
    if (/\.gen\.[cm]?[jt]sx?$/.test(basename) || basename.endsWith('.tmp')) return false;
    if (path.extname(basename) && !/\.[cm]?[jt]sx?$/.test(basename)) return false;
    return inSourceTree(file);
  }
  async function settled(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = tail;
      await observed;
    } while (observed !== tail);
    if (failure) throw failure;
  }
  function report(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const diagnostic = err as Partial<DiscoveryDiagnostic>;
    const details = {
      ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
      ...(diagnostic.file !== undefined ? { id: diagnostic.file } : {}),
      ...(diagnostic.missingExports !== undefined
        ? { missingExports: diagnostic.missingExports }
        : {}),
    };
    server?.config.logger.error(err.message);
    server?.ws.send({
      type: 'error',
      err: {
        message: err.message,
        stack: err.stack ?? '',
        plugin: 'vite-plugin-foldkit-routes',
        ...details,
      },
    });
  }
  return {
    name: 'vite-plugin-foldkit-routes',
    enforce: 'pre',
    configResolved(config) {
      root = path.resolve(options.root ?? config.root);
    },
    async buildStart() {
      await compile();
    },
    async load(id) {
      // Public load barrier also protects uncached transformRequest loads.
      // Do not read/return retained on-disk generated bytes during a known error.
      const file = id.split('?')[0]!;
      if (inSourceTree(file)) await settled();
      return null;
    },
    configureServer(devServer) {
      server = devServer;
      server.watcher.add([path.join(root, 'src'), path.join(root, 'lib')]);
      void compile().catch(report);
      const changed = (file: string) => {
        if (!relevant(file)) return;
        // Normal success only refreshes outputs; official Foldkit owns HMR.
        // compile() has one explicit cold-reload exception after error recovery.
        void compile().catch(report);
      };
      for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const)
        server.watcher.on(event, changed);
      server.httpServer?.once('close', () => {
        for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const)
          devServer.watcher.off(event, changed);
      });
      server.middlewares.use((_request, response, next) => {
        void (async () => {
          // Also wait for work queued while a preceding compilation was running.
          try {
            await settled();
          } catch (error) {
            response.statusCode = 500;
            response.setHeader('Content-Type', 'text/plain');
            response.end(error instanceof Error ? error.message : String(error));
            return;
          }
          next();
        })().catch(next);
      });
    },
    hotUpdate: {
      order: 'pre',
      async handler(context) {
        if (!relevant(context.file)) return undefined;
        // Client generation runs first in Vite's native dispatch. Other
        // environments share that result rather than compiling it again.
        if (this.environment.name === 'client') await compile();
        await settled();
        if (context.type !== 'update') {
          // Vite 8 does not run legacy handleHotUpdate for create/delete. Its
          // default deleted-module propagation can reload a stale registry before
          // the changed physical generated module reaches official Foldkit HMR.
          // Drop that structural event only, after invalidating public caches.
          this.environment.moduleGraph.invalidateAll();
          // An unimported new route may have no changed generated module event
          // left to propagate after publication/cache invalidation. Reset-only
          // applications opt into one explicit structural cold reload here;
          // ordinary updates still belong to the native Foldkit plugin.
          if (options.reloadOnStructure && this.environment.name === 'client') {
            server?.ws.send({ type: 'full-reload', path: '*' });
          }
          return [];
        }
        // Actual update modules must reach the official preservation lifecycle.
        return undefined;
      },
    },
  };
}
