import path from 'node:path';
import type { SourceLoader } from './source.ts';

export type ContractRef = { file: string; exportName: string };
export type ContractNode = {
  type: string;
  name?: string;
  value?: string;
  declaration?: ContractNode | null;
  declarations?: ContractNode[];
  id?: ContractNode;
  init?: ContractNode | null;
  specifiers?: ContractNode[];
  source?: ContractNode | null;
  exported?: ContractNode;
  local?: ContractNode;
  imported?: ContractNode;
  importKind?: string;
  exportKind?: string;
  expression?: ContractNode;
};
export const unwrap = (input: ContractNode): ContractNode => {
  let node = input;
  while (
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'ParenthesizedExpression',
    ].includes(node.type) &&
    node.expression
  )
    node = node.expression;
  return node;
};
function fail(file: string, message: string): never {
  throw Object.assign(new Error(`${file}: ${message}`), {
    code: 'DISCOVERY_CONTRACT_IDENTITY',
    file,
    missingExports: [],
  });
}

/** Bounded declaration identity, not schema reflection or structural equivalence. */
export function contractResolver(
  root: string,
  resolveLocal: (file: string, spec: string) => Promise<string | undefined>,
  loadSource: SourceLoader,
) {
  async function resolve(
    file: string,
    name: string,
    mode: 'export' | 'local',
    seen: Set<string>,
  ): Promise<ContractRef> {
    const key = JSON.stringify([file, name, mode]);
    if (seen.has(key)) fail(file, `cyclic contract alias ${name}`);
    seen = new Set(seen).add(key);
    const { parsed } = await loadSource(file);
    if (parsed.errors.length) fail(file, parsed.errors.map((e) => e.message).join('; '));
    const body = parsed.program.body as unknown as ContractNode[];
    async function imported(spec: string, target: string) {
      const dependency = await resolveLocal(file, spec);
      if (!dependency)
        fail(file, `contract ${name} must resolve to a local source declaration, not ${spec}`);
      return resolve(dependency, target, 'export', seen);
    }
    if (mode === 'export') {
      for (const statement of body) {
        if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type')
          continue;
        const declaration = statement.declaration;
        if (
          declaration?.type === 'VariableDeclaration' &&
          declaration.declarations?.some((d) => d.id?.name === name)
        )
          return resolve(file, name, 'local', seen);
        for (const spec of statement.specifiers ?? [])
          if (
            (spec.exported?.name ?? spec.exported?.value) === name &&
            spec.exportKind !== 'type'
          ) {
            const local = spec.local?.name ?? fail(file, `unsupported contract export ${name}`);
            return statement.source?.value
              ? imported(statement.source.value, local)
              : resolve(file, local, 'local', seen);
          }
      }
      fail(
        file,
        `unresolved explicit runtime contract export ${name}; wildcard contracts are unsupported`,
      );
    }
    for (const statement of body) {
      if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type')
        for (const spec of statement.specifiers ?? [])
          if (spec.local?.name === name && spec.importKind !== 'type') {
            if (spec.type !== 'ImportSpecifier' || !statement.source?.value)
              fail(file, `unsupported contract import ${name}; use a named local source import`);
            return imported(
              statement.source.value,
              spec.imported?.name ??
                spec.imported?.value ??
                fail(file, `invalid contract import ${name}`),
            );
          }
      const declaration =
        statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
      if (declaration?.type !== 'VariableDeclaration') continue;
      for (const d of declaration.declarations ?? [])
        if (d.id?.name === name && d.init) {
          const expression = unwrap(d.init);
          if (expression.type === 'Identifier' && expression.name)
            return resolve(file, expression.name, 'local', seen);
          // Only a named declaration can establish identity. Never evaluate its initializer.
          if (
            ['OutMessage', 'ChildOutMessage'].includes(name) &&
            /\/(page|layout)\.ts$/.test(file.split(path.sep).join('/'))
          )
            fail(file, `unsupported contract expression ${name}; reuse a shared schema identifier`);
          if (
            !['CallExpression', 'NewExpression', 'MemberExpression', 'ObjectExpression'].includes(
              expression.type,
            )
          )
            fail(file, `unsupported contract expression ${name}`);
          return { file: path.relative(root, file).split(path.sep).join('/'), exportName: name };
        }
    }
    fail(file, `unresolved runtime contract identifier ${name}`);
  }
  return (file: string, name: string) => resolve(file, name, 'export', new Set());
}
