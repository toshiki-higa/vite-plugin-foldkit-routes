import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { contractResolver, unwrap, type ContractRef } from './contracts.ts';
import { sourceLoader, type SourceFile, type SourceLoader } from './source.ts';
export type { ContractRef } from './contracts.ts';

export type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'rest'; name: string };
export type Page = {
  file: string;
  relativeFile: string;
  id: string;
  pattern: string;
  segments: readonly Segment[];
  exports: readonly string[];
  fingerprint: string;
  layouts: readonly string[];
  outContract?: ContractRef;
  receiver?: string;
  subscriptionKeys: readonly string[];
};
export type Layout = Page & { childContract?: ContractRef };
export type Manifest = {
  root: string;
  routesDirectory: string;
  pages: readonly Page[];
  layouts: readonly Layout[];
};

type Node = {
  type: string;
  start: number;
  end: number;
  name?: string;
  value?: string;
  declaration?: Node | null;
  declarations?: Node[];
  id?: Node;
  init?: Node | null;
  body?: Node | Node[];
  specifiers?: Node[];
  source?: Node | null;
  exported?: Node;
  local?: Node;
  exportKind?: string;
  declare?: boolean;
  properties?: Node[];
  elements?: Array<Node | null>;
  argument?: Node;
};
const unsupported = new Set([
  'layout',
  'ManagedResource',
  'managedResources',
  'resources',
  'stateKey',
  'Flags',
]);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export type DiscoveryDiagnostic = Error & {
  code: string;
  file: string;
  missingExports: readonly string[];
};
function fail(
  file: string,
  message: string,
  code = 'DISCOVERY_INVALID_CONTRACT',
  missingExports: readonly string[] = [],
): never {
  throw Object.assign(new Error(`${file}: ${message}`), {
    code,
    file,
    missingExports,
  }) satisfies DiscoveryDiagnostic;
}
function names(node: Node): string[] {
  if (node.type === 'Identifier') return [node.name!];
  if (node.type === 'ObjectPattern')
    return (node.properties ?? []).flatMap((p) =>
      names(p.type === 'RestElement' ? p.argument! : (p as Node & { value: Node }).value),
    );
  if (node.type === 'ArrayPattern')
    return (node.elements ?? []).flatMap((p) => (p ? names(p) : []));
  if (node.type === 'AssignmentPattern') return names((node as Node & { left: Node }).left);
  if (node.type === 'RestElement') return names(node.argument!);
  return [];
}
function inspect(
  file: string,
  { source, parsed }: SourceFile,
  layout: boolean,
  segments: readonly Segment[],
): { exports: string[]; signature: string; params: string[]; subscriptionKeys?: string[] } {
  if (parsed.errors.length)
    fail(file, parsed.errors.map((e) => e.message).join('; '), 'DISCOVERY_PARSE_ERROR');
  const body = parsed.program.body as unknown as Node[];
  const exported = new Map<string, Set<string>>();
  const locals = new Map<string, Node>();
  let routeLocal: string | undefined;
  let subscriptionsLocal: string | undefined;
  for (const statement of body) {
    const decl = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (decl?.type === 'VariableDeclaration')
      for (const d of decl.declarations ?? [])
        if (d.id?.name && d.init) locals.set(d.id.name, d.init);
  }
  const cuts: Array<{ start: number; end: number }> = [];
  function add(name: string, kind: string) {
    if (
      unsupported.has(name) ||
      (!layout &&
        ['provide', 'ChildContext', 'ChildOutMessage', 'onChildOutMessage'].includes(name))
    )
      fail(file, `unsupported export ${name}`);
    const kinds = exported.get(name) ?? new Set<string>();
    if (kinds.has(kind)) fail(file, `duplicate export ${name}`);
    kinds.add(kind);
    exported.set(name, kinds);
    if (name === 'route') routeLocal = 'route';
    if (name === 'subscriptions') subscriptionsLocal = 'subscriptions';
  }
  for (const statement of body) {
    if (
      statement.type === 'ExportAllDeclaration' ||
      statement.type === 'ExportDefaultDeclaration' ||
      statement.type === 'TSExportAssignment'
    )
      fail(
        file,
        'default, wildcard, and export-assignment declarations are unsupported; use explicit named exports',
      );
    const decl = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.source)
        fail(file, 're-exports are unsupported; declare page contracts locally');
      if (decl) {
        if (decl.declare) fail(file, 'ambient exported declarations are unsupported');
        if (decl.type === 'VariableDeclaration')
          for (const d of decl.declarations ?? [])
            for (const name of names(d.id!)) add(name, 'value');
        else if (decl.id?.name)
          add(
            decl.id.name,
            decl.type === 'TSTypeAliasDeclaration' || decl.type === 'TSInterfaceDeclaration'
              ? 'type'
              : 'value',
          );
        else fail(file, `unsupported export declaration ${decl.type}`);
      }
      for (const spec of statement.specifiers ?? []) {
        const name =
          spec.exported?.name ?? spec.exported?.value ?? fail(file, 'invalid export name');
        add(name, spec.exportKind === 'type' || statement.exportKind === 'type' ? 'type' : 'value');
        if (name === 'route') routeLocal = spec.local?.name;
        if (name === 'subscriptions') subscriptionsLocal = spec.local?.name;
      }
    }
    if (
      decl?.type === 'FunctionDeclaration' &&
      decl.id?.name === 'view' &&
      decl.body &&
      !Array.isArray(decl.body)
    )
      cuts.push(decl.body);
    if (decl?.type === 'VariableDeclaration')
      for (const d of decl.declarations ?? []) {
        if (
          d.id?.name === 'view' &&
          (d.init?.type === 'ArrowFunctionExpression' || d.init?.type === 'FunctionExpression') &&
          d.init.body &&
          !Array.isArray(d.init.body)
        )
          cuts.push(d.init.body);
      }
  }
  const state = ['Model', 'Message', 'init', 'update'];
  const required = layout || state.some((n) => exported.has(n)) ? [...state, 'view'] : ['view'];
  const missing = required.filter((name) => !exported.get(name)?.has('value'));
  if (missing.length)
    fail(
      file,
      `native ${layout ? 'layout' : 'page'} requires runtime exports: ${missing.join(', ')}`,
      'DISCOVERY_MISSING_EXPORTS',
      missing,
    );
  if (exported.has('inform') && !exported.has('Model'))
    fail(file, 'inform requires a stateful page');
  if (exported.has('restore') && !exported.has('Model'))
    fail(file, 'restore requires a stateful page');
  if (exported.has('OutMessage') && !exported.has('Model'))
    fail(file, 'OutMessage requires a stateful page lifecycle');
  for (const name of [
    'route',
    'inform',
    'restore',
    'OutMessage',
    'ChildOutMessage',
    'ChildContext',
    'provide',
    'onChildOutMessage',
    'subscriptions',
  ])
    if (exported.has(name) && !exported.get(name)?.has('value'))
      fail(file, `${name} must be a runtime export`);
  if (layout) {
    if (exported.has('ChildContext') !== exported.has('provide'))
      fail(file, 'ChildContext and provide must be paired');
    if (exported.has('ChildOutMessage') !== exported.has('onChildOutMessage'))
      fail(
        file,
        'ChildOutMessage and onChildOutMessage must be paired; missing receiver contract or handler',
      );
  }
  const params: string[] = [];
  if (exported.has('route')) {
    let node = routeLocal ? locals.get(routeLocal) : undefined;
    while (
      node &&
      ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(node.type)
    )
      node = (node as Node & { expression: Node }).expression;
    if (node?.type !== 'ObjectExpression')
      fail(file, 'route must be a local object literal for initial contract validation');
    for (const property of node.properties ?? []) {
      const p = property as Node & { key?: Node; computed?: boolean };
      const key = p.key?.name ?? p.key?.value;
      if (p.type === 'SpreadElement' || p.computed || !key || !['params', 'search'].includes(key))
        fail(
          file,
          `unsupported route property ${key ?? p.type}; only params and search are supported`,
        );
      if (layout && key === 'search')
        fail(file, 'layout route.search is unsupported; each page owns its search schema');
      if (key === 'params') {
        let value = (p as unknown as { value: Node }).value;
        while (
          value &&
          ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(value.type)
        )
          value = (value as Node & { expression: Node }).expression;
        if (value?.type !== 'ObjectExpression')
          fail(file, 'route.params must be an explicit object literal');
        for (const property of value.properties ?? []) {
          const field = property as Node & { key?: Node; computed?: boolean };
          const name = field.key?.name ?? field.key?.value;
          if (field.type !== 'Property' || field.computed || !name)
            fail(file, 'route.params requires explicit noncomputed schema fields');
          if (!segments.some((s) => s.kind !== 'static' && s.name === name))
            fail(file, `route.params ${name} is not a URL-prefix parameter`);
          if (params.includes(name)) fail(file, `duplicate route.params ${name}`);
          params.push(name);
        }
      }
    }
  }
  let subscriptionKeys: string[] | undefined;
  if (exported.has('subscriptions')) {
    let node = subscriptionsLocal ? locals.get(subscriptionsLocal) : undefined;
    const visited = new Set<string>();
    while (node?.type === 'Identifier' && node.name && !visited.has(node.name)) {
      visited.add(node.name);
      node = locals.get(node.name);
    }
    type Call = Node & { callee?: Node & { object?: Node; property?: Node }; arguments?: Node[] };
    const call = node as Call | undefined;
    const factory = call?.callee as Call | undefined;
    const callback = call?.arguments?.[0];
    const body = callback?.body as Node | undefined;
    const entries = body ? (unwrap(body) as Node) : undefined;
    if (
      call?.type !== 'CallExpression' ||
      factory?.type !== 'CallExpression' ||
      factory.arguments?.length !== 0 ||
      factory.callee?.type !== 'MemberExpression' ||
      factory.callee.object?.name !== 'Subscription' ||
      factory.callee.property?.name !== 'make' ||
      call.arguments?.length !== 1 ||
      callback?.type !== 'ArrowFunctionExpression' ||
      entries?.type !== 'ObjectExpression'
    )
      fail(
        file,
        'subscriptions must be a local Subscription.make<...>()(entry => ({...})) with explicit entry keys',
      );
    subscriptionKeys = [];
    for (const property of entries.properties ?? []) {
      const field = property as Node & { key?: Node; computed?: boolean };
      const key = field.key?.name ?? field.key?.value;
      if (
        field.type !== 'Property' ||
        field.computed ||
        typeof key !== 'string' ||
        subscriptionKeys.includes(key)
      )
        fail(
          file,
          'subscriptions requires unique explicit noncomputed entry keys; spreads/aggregates are unsupported',
        );
      subscriptionKeys.push(key);
    }
    subscriptionKeys.sort(compare);
  }
  let signature = source;
  for (const cut of cuts.sort((a, b) => b.start - a.start))
    signature = signature.slice(0, cut.start) + '<view-body>' + signature.slice(cut.end);
  return {
    exports: [...exported.keys()].sort(compare),
    signature,
    params,
    ...(subscriptionKeys ? { subscriptionKeys } : {}),
  };
}
// Bounded source-only dependency discovery. Bare package imports are external;
// local runtime edges must resolve inside the watched src/lib source trees.
function runtimeSpecifiers(file: string, { parsed }: SourceFile): string[] {
  if (parsed.errors.length) fail(file, parsed.errors.map((e) => e.message).join('; '));
  const edges = new Set<string>();
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as Record<string, unknown>;
    const type = node.type;
    if (
      type === 'ImportDeclaration' ||
      type === 'ExportNamedDeclaration' ||
      type === 'ExportAllDeclaration'
    ) {
      const kind = type === 'ImportDeclaration' ? 'importKind' : 'exportKind';
      const specs = node.specifiers as Record<string, unknown>[] | undefined;
      if (
        node.source &&
        node[kind] !== 'type' &&
        (!specs?.length || specs.some((s) => s[kind] !== 'type'))
      ) {
        const spec = (node.source as { value?: unknown }).value;
        if (typeof spec !== 'string') fail(file, 'unsupported runtime module specifier');
        edges.add(spec);
      }
    }
    if (type === 'ImportExpression') {
      const input = node.source as { type?: string; value?: unknown };
      if (input.type !== 'Literal' || typeof input.value !== 'string')
        fail(
          file,
          'computed dynamic import cannot be fingerprinted; use a literal module specifier',
        );
      edges.add(input.value);
    }
    if (type === 'TSImportEqualsDeclaration' && node.importKind !== 'type')
      fail(file, 'runtime import-equals cannot be fingerprinted; use ESM imports');
    if (
      type === 'CallExpression' &&
      (node.callee as { type?: string; name?: string })?.name === 'require'
    )
      fail(file, 'require() cannot be fingerprinted; use ESM imports');
    for (const child of Object.values(node)) visit(child);
  }
  visit(parsed.program);
  return [...edges].sort(compare);
}
function dependencyStamps(root: string, loadSource: SourceLoader) {
  const cache = new Map<string, Promise<{ source: string; edges: string[] }>>();
  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
  const inTree = (file: string, tree: string) => {
    const rel = path.relative(path.join(root, tree), file);
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };
  async function resolveLocal(importer: string, spec: string): Promise<string | undefined> {
    if (/\.gen\.[cm]?[jt]sx?$/.test(spec)) return undefined;
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      if (
        spec.startsWith('/') ||
        spec.startsWith('#') ||
        spec.startsWith('~') ||
        spec.startsWith('@/')
      )
        fail(importer, `unsupported local/alias import ${spec}; use relative source imports`);
      return undefined;
    }
    if (/[?#]/.test(spec)) fail(importer, `unsupported local import suffix: ${spec}`);
    const base = path.resolve(path.dirname(importer), spec),
      ext = path.extname(base);
    let candidates: string[];
    if (!ext)
      candidates = extensions
        .map((e) => base + e)
        .concat(extensions.map((e) => path.join(base, 'index' + e)));
    else if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      const tsExt = { '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' }[ext]!;
      candidates = [base.slice(0, -ext.length) + tsExt, base];
    } else if (extensions.includes(ext)) candidates = [base];
    else fail(importer, `unsupported local runtime source import ${spec}`);
    for (const candidate of candidates) {
      if (!inTree(candidate, 'src') && !inTree(candidate, 'lib'))
        fail(importer, `local import escapes watched src/lib trees: ${spec}`);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        const actual = await realpath(candidate);
        const canonicalCandidate = path.join(await realpath(root), path.relative(root, candidate));
        if (actual !== canonicalCandidate)
          fail(importer, `symlink runtime dependency is unsupported: ${spec}`);
        return candidate;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
      }
    }
    fail(importer, `unresolved local runtime import ${spec}`);
  }
  function load(file: string) {
    let value = cache.get(file);
    if (!value) {
      value = (async () => {
        const loaded = await loadSource(file);
        return { source: loaded.source, edges: runtimeSpecifiers(file, loaded) };
      })();
      cache.set(file, value);
    }
    return value;
  }
  const stamp = async (
    page: string,
    source: SourceFile,
  ): Promise<readonly (readonly [string, string])[]> => {
    const visited = new Set<string>([page]);
    const stamps: Array<readonly [string, string]> = [];
    async function walk(file: string, edges: string[]): Promise<void> {
      for (const spec of edges) {
        const dependency = await resolveLocal(file, spec);
        if (!dependency || visited.has(dependency)) continue;
        visited.add(dependency);
        const next = await load(dependency);
        stamps.push([path.relative(root, dependency).split(path.sep).join('/'), hash(next.source)]);
        await walk(dependency, next.edges);
      }
    }
    await walk(page, runtimeSpecifiers(page, source));
    return stamps.sort((a, b) => compare(a[0], b[0]));
  };
  return { stamp, resolveLocal };
}
function segmentsFor(file: string, directories: string[]): Segment[] {
  const result: Segment[] = [];
  const params = new Set<string>();
  for (const dir of directories) {
    if (/^\([^()]+\)$/.test(dir)) continue;
    if (result.at(-1)?.kind === 'rest') fail(file, 'rest parameter must be terminal');
    const match = /^\[(\.\.\.)?([A-Za-z_][A-Za-z0-9_]*)\]$/.exec(dir);
    if (match) {
      const name = match[2]!;
      if (params.has(name)) fail(file, `duplicate parameter ${name}`);
      params.add(name);
      result.push({ kind: match[1] ? 'rest' : 'param', name });
    } else {
      if (/[[\]()?#%\\]/.test(dir)) fail(file, `malformed route segment ${dir}`);
      result.push({ kind: 'static', value: dir });
    }
  }
  return result;
}
export async function discover(root: string): Promise<Manifest> {
  root = path.resolve(root);
  const loadSource = sourceLoader(new Map<string, Promise<SourceFile>>());
  const routesDirectory = path.join(root, 'src/routes');
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === routesDirectory && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(file, 'symlinks in route trees are unsupported');
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        if (/^(provide|resources|subscriptions)\.[cm]?[jt]sx?$/.test(entry.name))
          fail(file, 'unsupported route feature file');
        if (entry.name === 'page.ts' || entry.name === 'layout.ts') files.push(file);
        else if (/^(page|layout)\.[cm]?[jt]sx?$/.test(entry.name))
          fail(file, 'only page.ts and layout.ts are supported');
      }
    }
  }
  await walk(routesDirectory);
  const shapes = new Map<string, string>();
  const pages: Page[] = [];
  const layouts: Layout[] = [];
  const paramsByFile = new Map<string, readonly string[]>();
  const { stamp: stampDependencies, resolveLocal } = dependencyStamps(root, loadSource);
  const resolveContract = contractResolver(root, resolveLocal, loadSource);
  for (const file of files) {
    const relativeFile = path.relative(root, file).split(path.sep).join('/');
    const dirs = path.relative(routesDirectory, path.dirname(file)).split(path.sep).filter(Boolean);
    const segments = segmentsFor(file, dirs);
    const layout = path.basename(file) === 'layout.ts';
    if (!layout) {
      const shape = JSON.stringify(
        segments.map((s) => (s.kind === 'static' ? ['static', s.value] : [s.kind])),
      );
      const existing = shapes.get(shape);
      if (existing) fail(file, `duplicate URL shape with ${existing}`);
      shapes.set(shape, file);
    }
    const source = await loadSource(file);
    const contract = inspect(file, source, layout, segments);
    paramsByFile.set(file, contract.params);
    const dependencies = await stampDependencies(file, source);
    const pattern =
      '/' +
      segments
        .map((s) =>
          s.kind === 'static' ? s.value : s.kind === 'param' ? `[${s.name}]` : `[...${s.name}]`,
        )
        .join('/');
    const owner: Layout = {
      file,
      relativeFile,
      id: (layout ? 'layout_' : 'page_') + hash(relativeFile).slice(0, 16),
      pattern,
      segments,
      exports: contract.exports,
      fingerprint: hash(
        JSON.stringify([segments, contract.exports, contract.signature, dependencies]),
      ),
      layouts: [],
      subscriptionKeys: contract.subscriptionKeys ?? [],
    };
    if (contract.exports.includes('OutMessage'))
      owner.outContract = await resolveContract(file, 'OutMessage');
    if (contract.exports.includes('ChildOutMessage'))
      owner.childContract = await resolveContract(file, 'ChildOutMessage');
    if (layout) layouts.push(owner);
    else pages.push(owner);
  }
  const rank = { static: 0, param: 1, rest: 2 };
  pages.sort((a, b) => {
    for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
      const x = a.segments[i]!,
        y = b.segments[i]!;
      const order = rank[x.kind] - rank[y.kind];
      if (order) return order;
      if (x.kind === 'static' && y.kind === 'static') {
        const order = compare(x.value, y.value);
        if (order) return order;
      }
    }
    return a.segments.length - b.segments.length || compare(a.relativeFile, b.relativeFile);
  });
  layouts.sort(
    (a, b) =>
      a.relativeFile.split('/').length - b.relativeFile.split('/').length ||
      compare(a.relativeFile, b.relativeFile),
  );
  for (const owner of [...layouts, ...pages]) {
    const ancestors = layouts.filter((layout) => {
      if (layout.file === owner.file) return false;
      const relative = path.relative(path.dirname(layout.file), path.dirname(owner.file));
      return (
        relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      );
    });
    owner.layouts = ancestors.map((layout) => layout.id);
    const declarations = new Map<string, string>();
    for (const node of [...ancestors, owner])
      for (const name of paramsByFile.get(node.file) ?? []) {
        const previous = declarations.get(name);
        if (previous)
          fail(
            owner.file,
            `conflicting inherited route.params ${name} declared by ${previous} and ${node.relativeFile}; redeclarations are unsupported`,
          );
        declarations.set(name, node.relativeFile);
      }
    if (owner.outContract) {
      const nearest = ancestors.findLast((layout) => layout.childContract !== undefined);
      if (!nearest) fail(owner.file, 'OutMessage has no ancestor ChildOutMessage receiver');
      if (JSON.stringify(owner.outContract) !== JSON.stringify(nearest.childContract))
        fail(
          owner.file,
          `incompatible nearest ChildOutMessage receiver ${nearest.relativeFile}; expected shared canonical contract ${JSON.stringify(nearest.childContract)}, got ${JSON.stringify(owner.outContract)}`,
        );
      owner.receiver = nearest.id;
    }
  }
  return { root, routesDirectory, pages, layouts };
}
