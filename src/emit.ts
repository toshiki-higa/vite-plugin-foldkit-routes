import path from 'node:path';
import type { Manifest, Page, Layout } from './discover.ts';
import { treeComposition } from './emit-tree.ts';
import type { GeneratedFile } from './files.ts';
import {
  inheritedParamsConfig,
  ownerIdentifier,
  pageIdentifiers,
  paramFields,
  paramSchema,
} from './emission.ts';

const quote = JSON.stringify;
const importsFrom = (from: string, target: string) => {
  const relative = path.posix.relative(path.posix.dirname(from), target);
  return relative.startsWith('.') ? relative : `./${relative}`;
};
const has = (owner: Page | Layout, name: string) => owner.exports.includes(name);
const config = (page: Page, index: number) =>
  has(page, 'route') ? `${ownerIdentifier(false, index)}.route` : 'undefined';

// Conservative compile-time overlap filtering, NOT a second URL matcher.
// Native ordered oneOf still decides every actual acceptance.
export function mayOverlap(a: Page, b: Page): boolean {
  const restA = a.segments.at(-1)?.kind === 'rest',
    restB = b.segments.at(-1)?.kind === 'rest';
  if (!restA && !restB && a.segments.length !== b.segments.length) return false;
  if (!restA && a.segments.length < b.segments.length) return false;
  if (!restB && b.segments.length < a.segments.length) return false;
  for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
    const x = a.segments[i]!,
      y = b.segments[i]!;
    if (x.kind === 'rest' || y.kind === 'rest') return true;
    if (x.kind === 'static' && y.kind === 'static' && x.value !== y.value) return false;
  }
  return true;
}

function helper(owner: Page | Layout, manifest: Manifest, layout = false): GeneratedFile {
  const file = path.posix.join(
    path.posix.dirname(owner.relativeFile),
    layout ? 'layout.gen.ts' : 'route.gen.ts',
  );
  const ancestors = owner.layouts.map((id) => manifest.layouts.find((l) => l.id === id)!);
  const provider = ancestors.findLast((l) => has(l, 'ChildContext'));
  const context = provider
    ? `typeof Ancestor${ancestors.indexOf(provider)}.ChildContext.Type`
    : 'Readonly<Record<string,never>>';
  const params = owner.segments.filter((s) => s.kind !== 'static');
  const fields = params.map(
    (segment) =>
      `${quote(segment.name)}:${segment.kind === 'rest' ? `readonly [Param<${quote(segment.name)}>,...Param<${quote(segment.name)}>[]]` : `Param<${quote(segment.name)}>`}`,
  );
  const stateful = has(owner, 'Model');
  return {
    path: file,
    content: `import type { Schema, Result } from 'effect';
import type { Html, HtmlBuilder } from 'foldkit/html';
import type { Route, Update as NativeUpdate } from 'foldkit';
import type * as Source from './${layout ? 'layout' : 'page'}.ts';
${ancestors.map((a, i) => `import type * as Ancestor${i} from ${quote(importsFrom(file, a.relativeFile))};`).join('\n')}
import type { RouteConfig as Config } from 'vite-plugin-foldkit-routes/runtime';
import type { Destination } from ${quote(importsFrom(file, 'src/routes.gen.ts'))};
export type RouteConfig=Omit<Config,${layout ? "'params'|'search'" : "'params'"}> & {readonly params?:${params.length ? `Partial<Record<${params.map((s) => quote(s.name)).join('|')},Schema.Codec<unknown,string>>>` : 'Readonly<Record<string,never>>'}};
type Contract=${[...ancestors.map((a, i) => (has(a, 'route') ? `typeof Ancestor${i}.route` : '{}')), has(owner, 'route') ? 'typeof Source.route' : '{}'].join(' & ')};
type Param<K extends string>=Contract extends {readonly params:infer P}?K extends keyof P?P[K] extends Schema.Top?P[K]['Type']:never:string:string;
export type Params=${fields.length ? '{readonly ' + fields.join(';readonly ') + '}' : 'Readonly<Record<string,never>>'};
type SearchSchema=${!layout && has(owner, 'route') ? 'typeof Source.route' : '{}'} extends {readonly search:infer S extends Schema.Struct<Schema.Struct.Fields>}?S:Schema.Struct<{}>;
export type Input={readonly params:Params;readonly search:SearchSchema['Type'];readonly context:${context}};
export type InputChange={readonly previous:Input;readonly current:Input;readonly changed:{readonly params:boolean;readonly search:boolean;readonly context:boolean}};
type SearchInput=keyof SearchSchema['fields'] extends never?Readonly<Record<string,never>>:SearchSchema['~type.make.in'];
export type DestinationInput=${fields.length ? '{readonly params:Params}' : '{readonly params?:Params}'} & ({} extends SearchInput?{readonly search?:SearchInput}:{readonly search:SearchInput});
export type ViewInputs=Input & {readonly href:(destination:Destination)=>string;readonly hrefResult:(destination:Destination)=>Result.Result<string,Route.ParseError>${layout ? ';readonly outlet:()=>Html' : ''}};
${
  stateful
    ? `export type Return<R>=NativeUpdate.ReturnWithOutMessage<typeof Source.Model.Type,typeof Source.Message.Type,${has(owner, 'OutMessage') ? 'typeof Source.OutMessage.Type' : 'never'},R>;
export type Update<R>=(model:typeof Source.Model.Type,message:typeof Source.Message.Type,input:Input)=>Return<R>;
export type Restore<R>=(model:typeof Source.Model.Type,input:Input)=>NativeUpdate.Return<typeof Source.Model.Type,typeof Source.Message.Type,R>;`
    : ''
}
export type View=${stateful ? '(model:typeof Source.Model.Type,input:ViewInputs,h:HtmlBuilder<typeof Source.Message.Type>)' : '(input:ViewInputs,h:HtmlBuilder<never>)'}=>Html;
`,
  };
}

function effectiveConfig(page: Page, index: number, manifest: Manifest): string {
  const ancestors = page.layouts
    .map((id) => manifest.layouts.findIndex((l) => l.id === id))
    .filter((i) => has(manifest.layouts[i]!, 'route'))
    .map((i) => `${ownerIdentifier(true, i)}.route`);
  // A native route can declare only search (or no fields). Supply the absent
  // property before spreading its precise inferred config; never widen codecs.
  return ancestors.length
    ? inheritedParamsConfig([...ancestors, ...(has(page, 'route') ? [config(page, index)] : [])])
    : config(page, index);
}
function routeDeclarations(manifest: Manifest): string {
  return manifest.pages
    .map((page, i) => {
      const names = pageIdentifiers(i);
      const fields = paramFields(page.segments, effectiveConfig(page, i, manifest));
      return `const ${names.params}=Schema.Struct({${fields}});
const ${names.search}=Runtime.searchSchema(${config(page, i)});
const ${names.payload}=Schema.Struct({params:${names.params},search:${names.search}});
const ${names.equalParams}=Schema.toEquivalence(${names.params});
const ${names.equalSearch}=Schema.toEquivalence(${names.search});`;
    })
    .join('\n');
}
function parser(page: Page, index: number, manifest: Manifest): string {
  const names = pageIdentifiers(index);
  const segments = page.segments.map((segment) => {
    if (segment.kind === 'static')
      return `Runtime.escapedSegment(Route.literal(${quote(segment.value)}))`;
    return `Runtime.${segment.kind === 'rest' ? 'rest' : 'param'}(${quote(segment.name)},${paramSchema(effectiveConfig(page, index, manifest), segment.name)})`;
  });
  const pathParser = segments.length
    ? `pipe(${segments[0]}${
        segments.length > 1
          ? ',' +
            segments
              .slice(1)
              .map((s) => `Route.slash(${s})`)
              .join(',')
          : ''
      })`
    : 'Route.root';
  return `const ${names.codec}=Runtime.nested(${pathParser},${names.search});
const ${names.router}=Route.mapTo({make:(value:typeof ${names.payload}.Type)=>AppRoute[${quote(page.pattern)}](value)})(${names.codec});`;
}
/** Only native URL declarations. Lifecycle emission has exactly one implementation. */
function routing(manifest: Manifest): GeneratedFile {
  const { pages } = manifest;
  return {
    path: 'src/app.gen.ts',
    content: `import { Effect, Option, Schema, pipe } from 'effect';
import { Command, Route, Submodel, Update, Url } from 'foldkit';
import { defineTaggedUnion } from 'foldkit/schema';
import { defineMessageUnion } from 'foldkit/message';
import * as Runtime from 'vite-plugin-foldkit-routes/runtime';
import { Urls } from './navigation.gen.ts';
import type { Destination } from './routes.gen.ts';
${pages.map((p, i) => `import * as ${pageIdentifiers(i).owner} from ${quote(importsFrom('src/app.gen.ts', p.relativeFile))};`).join('\n')}
${routeDeclarations(manifest)}
export const AppRoute=Route.defineRouteUnion({${pages.map((p, i) => `${quote(p.pattern)}:${pageIdentifiers(i).payload}.fields`).join(',')},NotFound:{path:Schema.String}});
export type AppRoute=typeof AppRoute.Type;
${pages.map((p, i) => parser(p, i, manifest)).join('\n')}
const parser=Route.oneOf(${pages.map((_, i) => pageIdentifiers(i).router).join(',')});
${pages
  .map(
    (page, i) =>
      `const ${pageIdentifiers(i).acceptance}=Route.oneOf(${pages
        .slice(0, i + 1)
        .flatMap((previous, j) => (mayOverlap(previous, page) ? [pageIdentifiers(j).router] : []))
        .join(',')});`,
  )
  .join('\n')}
export const parse=Route.parseUrlWithFallback(parser,AppRoute.NotFound);
export const buildUrl=(destination:Destination):Effect.Effect<string,Route.ParseError>=>{
 switch(destination.to){
${pages
  .map((p, i) => {
    const names = pageIdentifiers(i);
    return `case ${quote(p.pattern)}:return Runtime.normalizeInput(${names.params},${names.search},{...destination,params:${p.segments.some((s) => s.kind !== 'static') ? 'destination.params' : 'destination.params ?? {}'}}).pipe(Effect.flatMap(value=>Runtime.checkedHref(${names.codec},value,${names.acceptance},resolved=>resolved._tag===${quote(p.pattern)} && Schema.toEquivalence(${names.payload})(value,resolved))));`;
  })
  .join('\n')}
 }
};
export const {href,hrefResult}=Runtime.hrefHelpers(buildUrl);
`,
  };
}
function destinations(pages: readonly Page[]): GeneratedFile {
  return {
    path: 'src/routes.gen.ts',
    content: `${pages.map((p, i) => `import type { DestinationInput as Input${i} } from ${quote(importsFrom('src/routes.gen.ts', path.posix.join(path.posix.dirname(p.relativeFile), 'route.gen.ts')))};`).join('\n')}
export type Destination=${pages.map((p, i) => `({readonly to:${quote(p.pattern)}} & Input${i})`).join('|')};
`,
  };
}
function navigation(): GeneratedFile {
  return {
    path: 'src/navigation.gen.ts',
    content: `import { Context, Effect } from 'effect';
import { Navigation, Route } from 'foldkit';
import type { Destination } from './routes.gen.ts';
export const Urls=Context.Service<{readonly build:(destination:Destination)=>Effect.Effect<string,Route.ParseError>}>('FileRoutes/Urls');
export const Navigate={
push:(destination:Destination)=>Effect.gen(function*(){const urls=yield* Urls;const url=yield* urls.build(destination);yield* Navigation.pushUrl(url);}),
replace:(destination:Destination)=>Effect.gen(function*(){const urls=yield* Urls;const url=yield* urls.build(destination);yield* Navigation.replaceUrl(url);}),
};
`,
  };
}
export function emit(manifest: Manifest): readonly GeneratedFile[] {
  if (manifest.pages.length === 0)
    throw new Error('Add at least one src/routes/**/page.ts before generating');
  return [
    ...manifest.pages.map((p) => helper(p, manifest)),
    ...manifest.layouts.map((l) => helper(l, manifest, true)),
    destinations(manifest.pages),
    navigation(),
    treeComposition(manifest, routing(manifest)),
  ];
}
