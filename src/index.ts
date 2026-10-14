import type { Plugin } from 'vite';
import { generate } from './generate.ts';
import { fileRoutesPlugin } from './vite.ts';

export interface FoldkitRoutesOptions {
  readonly root?: string;
  /** Cold reload after successful structural publication. Does not enable safe Model preservation. */
  readonly reloadOnStructure?: boolean;
}
export const foldkitRoutes = (options: FoldkitRoutesOptions = {}): Plugin =>
  fileRoutesPlugin({
    ...options,
    reloadOnStructure: options.reloadOnStructure ?? true,
    generate,
  });
export default foldkitRoutes;
export { discover } from './discover.ts';
export { generate, generateRoot } from './generate.ts';
export type { Manifest, Page, Layout, Segment, DiscoveryDiagnostic } from './discover.ts';
export type { WriteResult } from './files.ts';
