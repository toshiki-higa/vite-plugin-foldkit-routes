import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { Context, Effect, Option, Result, Schema } from 'effect';
import { Route } from 'foldkit';
import * as Runtime from '../src/runtime.ts';

const Id = Schema.String.pipe(Schema.brand('PersonId'));
const Params = Schema.Struct({ id: Id });
const Search = Schema.Struct({
  id: Schema.OptionFromOptionalKey(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<string>())),
  ),
  page: Runtime.searchDefault(Schema.NumberFromString.check(Schema.isGreaterThan(0)), 1),
});
const config = { params: { id: Id }, search: Search } satisfies Runtime.RouteConfig;
const Payload = Schema.Struct({ params: Params, search: Search });
const Person = Schema.TaggedStruct('Person', Payload.fields);
const New = Schema.TaggedStruct('New', {});
const path = Route.slash(Runtime.param('id', Runtime.paramSchema(config, 'id')))(
  Route.literal('people'),
);
const codec = Runtime.nested(path, Runtime.searchSchema(config));
const personRouter = Route.mapTo({ make: (value: typeof Payload.Type) => Person.make(value) })(
  codec,
);
const newRouter = Route.mapTo(New)(Route.slash(Route.literal('new'))(Route.literal('people')));
const registry = Route.oneOf(newRouter, personRouter);
const mount = { origin: 'https://example.test', base: '/app' };
type Destination = { readonly _tag: 'Person' } & Runtime.DestinationInput<
  typeof Params,
  typeof Search
>;
const checkDestination = (input: Destination) =>
  Runtime.normalizeInput(Params, Search, input).pipe(
    Effect.flatMap((value) =>
      Runtime.checkedHref(
        codec,
        value,
        registry,
        (resolved) => resolved._tag === 'Person' && Schema.toEquivalence(Payload)(value, resolved),
        mount,
      ),
    ),
  );
const { href, hrefResult } = Runtime.hrefHelpers(checkDestination);
const target = (
  id: string,
  search?: Runtime.DestinationInput<typeof Params, typeof Search>['search'],
): Destination => ({ _tag: 'Person', params: { id: Id.make(id) }, ...(search ? { search } : {}) });
const runResult = <A>(effect: Effect.Effect<A, Route.ParseError>) =>
  Effect.runSync(Effect.result(effect));
const state = () => ({ segments: [], queryParams: new URLSearchParams() });

// Compile-time contracts are deliberately kept in the test file, never executed.
function typeContracts() {
  const exactId: typeof Id = Runtime.paramSchema(config, 'id');
  const exactSearch: typeof Search = Runtime.searchSchema(config);
  const defaultId: typeof Schema.String = Runtime.paramSchema(config, 'other');
  const empty: Schema.Struct<{}> = Runtime.searchSchema(undefined);
  const absentId: typeof Schema.String = Runtime.paramSchema(undefined, 'id');
  void [exactId, exactSearch, defaultId, empty, absentId];
  const required = Schema.Struct({ q: Schema.String });
  const accepts = (value: Runtime.DestinationInput<typeof Params, typeof Search>) => value;
  accepts({ params: { id: Id.make('x') } });
  accepts({ params: { id: Id.make('x') }, search: { page: 2, id: Option.some('x') } });
  // @ts-expect-error params preserve the native brand
  accepts({ params: { id: 'x' } });
  // @ts-expect-error navigation receives decoded number, not wire string
  accepts({ params: { id: Id.make('x') }, search: { page: '2' } });
  // @ts-expect-error Option search uses decoded Option, not a string
  accepts({ params: { id: Id.make('x') }, search: { id: 'x' } });
  // @ts-expect-error missing params
  accepts({});
  const requiredInput = (value: Runtime.DestinationInput<typeof Params, typeof required>) => value;
  // @ts-expect-error required non-default search cannot be omitted
  requiredInput({ params: { id: Id.make('x') } });
  // @ts-expect-error normalization also requires non-default search input
  Runtime.normalizeInput(Params, required, { params: { id: Id.make('x') } });
  const decoded = (value: Runtime.Input<typeof Params, typeof Search>) => value;
  // @ts-expect-error canonical search fields cannot be omitted
  decoded({ params: { id: Id.make('x') }, search: {} });
  // @ts-expect-error search is Struct-only, not arbitrary codec
  const invalid: Runtime.RouteConfig = { search: Schema.String };
  void invalid;
  class Database extends Context.Service<Database, { readonly name: string }>()(
    'runtime-test/Database',
  ) {}
  class AppNavigate extends Context.Service<AppNavigate, Runtime.Navigate<Destination>>()(
    'runtime-test/Navigate',
  ) {}
  const navigateCommand = (destination: Destination) =>
    AppNavigate.pipe(Effect.flatMap((service) => service.push(destination)));
  const navR: Runtime.EffectRequirements<typeof navigateCommand> = {} as AppNavigate;
  const navReverse: AppNavigate = {} as Runtime.EffectRequirements<typeof navigateCommand>;
  void [navR, navReverse];
  const command = (_id: string) => Database.pipe(Effect.map((service) => service.name));
  type R = Runtime.EffectRequirements<typeof command>;
  const native: R = {} as Database;
  const reverse: Database = {} as R;
  void [native, reverse];
  // @ts-expect-error the extracted native environment is not a string
  const wrong: R = 'not Database';
  void wrong;
  const terminal = Runtime.rest('parts', Id);
  // @ts-expect-error native slash cannot follow terminal rest
  Route.slash(Route.literal('after'))(terminal);
}
void typeContracts;

test('schema lookup retains exact native values and supplies absent defaults', () => {
  assert.equal(Runtime.paramSchema(config, 'id'), Id);
  assert.equal(Runtime.paramSchema(config, 'missing'), Schema.String);
  assert.equal(Runtime.paramSchema(undefined, 'missing'), Schema.String);
  assert.equal(Runtime.searchSchema(config), Search);
  assert.deepEqual(Runtime.searchSchema(undefined).make({}), {});
});

test('paramSchema ignores inherited keys and accepts computed own prototype-named fields', () => {
  for (const key of ['constructor', '__proto__', 'toString']) {
    assert.equal(Runtime.paramSchema(config, key), Schema.String);
    assert.equal(Runtime.paramSchema({ params: {} }, key), Schema.String);
    assert.equal(Runtime.paramSchema(undefined, key), Schema.String);
  }
  const own = { params: { ['constructor']: Id, ['__proto__']: Id } } satisfies Runtime.RouteConfig;
  const exactConstructor: typeof Id = Runtime.paramSchema(own, 'constructor');
  const exactProto: typeof Id = Runtime.paramSchema(own, '__proto__');
  assert.equal(exactConstructor, Id);
  assert.equal(exactProto, Id);
  assert.ok(Object.hasOwn(own.params, '__proto__'));
});

test('nested path/search namespaces and dual defaults', () => {
  const [value] = Effect.runSync(
    Runtime.parseAtMount(registry, new URL('https://example.test/app/people/path?id=query'), mount),
  );
  assert.equal(value._tag, 'Person');
  if (value._tag !== 'Person') return;
  assert.equal(value.params.id, 'path');
  assert.deepEqual(value.search.id, Option.some('query'));
  assert.equal(value.search.page, 1);
  assert.equal(href(target('path')), '/app/people/path?page=1');
  assert.equal(
    href(target('path', { id: Option.some(''), page: 2 })),
    '/app/people/path?id=&page=2',
  );
});

for (const text of [
  'plain',
  'a/b',
  '/',
  '%',
  '%2F',
  '%2e',
  '?',
  '#',
  '+',
  ' ',
  '\\',
  '日本語',
  'a.b',
  'a?b#c/d%',
]) {
  test(`single segment URL roundtrip ${JSON.stringify(text)}`, () => {
    const result = hrefResult(target(text, { id: Option.some(text), page: 2 }));
    assert.ok(Result.isSuccess(result));
    const url = new URL(result.success, mount.origin);
    const [resolved] = Effect.runSync(Runtime.parseAtMount(registry, url, mount));
    assert.equal(resolved._tag, 'Person');
    if (resolved._tag !== 'Person') return;
    assert.equal(resolved.params.id, text);
    assert.deepEqual(resolved.search.id, Option.some(text));
    assert.equal(href(target(text, { id: Option.some(text), page: 2 })), result.success);
  });
}
for (const id of ['', '.', '..', '\uD800', 'new']) {
  test(`same-input href rejection ${JSON.stringify(id)}`, () => {
    const input = target(id);
    assert.ok(Result.isFailure(hrefResult(input)));
    assert.throws(() => href(input));
  });
}
test('constructor refinement failure remains in hrefResult typed channel', () => {
  assert.ok(Result.isFailure(hrefResult(target('x', { page: 0 }))));
  assert.throws(() => href(target('x', { page: 0 })));
});

test('ordered native overlap, completion and schema-error fallthrough', () => {
  const reversed = Route.oneOf(personRouter, newRouter);
  const [first] = Effect.runSync(registry.parse(['people', 'new']));
  const [other] = Effect.runSync(reversed.parse(['people', 'new']));
  assert.equal(first._tag, 'New');
  assert.equal(other._tag, 'Person');
  const [, remaining] = Effect.runSync(codec.parse(['people', 'x', 'extra']));
  assert.deepEqual(remaining, ['extra']);
  assert.ok(Result.isFailure(runResult(registry.parse(['people', 'x', 'extra']))));
  const Ignored = Schema.TaggedStruct('Ignored', {});
  const fallback = Route.mapTo({ make: (_value: { id: string }) => Ignored.make({}) })(
    Route.slash(Route.string('id'))(Route.literal('people')),
  );
  const withFallback = Route.oneOf(personRouter, fallback);
  const [resolved] = Effect.runSync(withFallback.parse(['people', 'x'], '?page=0'));
  assert.equal(resolved._tag, 'Ignored');
});

test('query remains native: last wins, unknown strips, forgiving escapes', () => {
  const [value] = Effect.runSync(codec.parse(['people', 'x'], '?page=2&page=3&id=%FF&unknown=yes'));
  assert.equal(value.search.page, 3);
  assert.deepEqual(value.search.id, Option.some('\uFFFD'));
  assert.equal(Object.hasOwn(value.search, 'unknown'), false);
  assert.ok(Result.isFailure(runResult(codec.parse(['people', '%FF']))));
  assert.ok(Result.isFailure(runResult(codec.parse(['people', '%']))));
});

test('scalar-wire JSON array is not rejected as a repeated-wire contract', () => {
  const search = Schema.Struct({ tags: Schema.fromJsonString(Schema.Array(Schema.String)) });
  const jsonCodec = Runtime.nested(Route.literal('tags'), search);
  const input = { params: {}, search: { tags: ['a/b', '日本語', '+'] } };
  const printed = Effect.runSync(jsonCodec.print(input, state()));
  const [decoded] = Effect.runSync(jsonCodec.parse(['tags'], '?' + printed.queryParams.toString()));
  assert.deepEqual(decoded, input);
});

test('mount origin and slash boundary, normalized separators and hash outside identity', () => {
  for (const text of [
    'https://example.test/application/people/x',
    'https://example.test/app2/people/x',
    'https://example.test/app%2Fpeople/x',
    'https://other.test/app/people/x',
    'https://example.test/App/people/x',
  ]) {
    assert.ok(Result.isFailure(runResult(Runtime.parseAtMount(registry, new URL(text), mount))));
  }
  const [value] = Effect.runSync(
    Runtime.parseAtMount(
      registry,
      new URL('https://example.test/app//people/x/?page=1#ignored'),
      mount,
    ),
  );
  assert.equal(value._tag, 'Person');
  assert.ok(
    Result.isFailure(
      runResult(Runtime.parseAtMount(registry, new URL('https://example.test/app'), mount)),
    ),
  );
});

test('checkedHref rejects lossy local codec using native Schema equality', () => {
  const lossy: Route.Biparser<typeof Payload.Type> = {
    ...codec,
    print: (input, state) =>
      codec.print({ ...input, params: { id: Id.make(input.params.id.toLowerCase()) } }, state),
  };
  const value = Effect.runSync(Runtime.normalizeInput(Params, Search, target('ABC')));
  assert.ok(
    Result.isFailure(
      runResult(
        Runtime.checkedHref(
          lossy,
          value,
          registry,
          (resolved) =>
            resolved._tag === 'Person' && Schema.toEquivalence(Payload)(value, resolved),
          mount,
        ),
      ),
    ),
  );
});

test('escaped rest is nonempty, terminal, schema-decoded and segment-safe', () => {
  const restCodec = Runtime.rest('parts', Id);
  const input = { parts: [Id.make('a/b'), Id.make('%2F'), Id.make('日本語')] as const };
  const printed = Effect.runSync(restCodec.print(input, state()));
  assert.deepEqual(printed.segments, ['a%2Fb', '%252F', '%E6%97%A5%E6%9C%AC%E8%AA%9E']);
  const [decoded, remaining] = Effect.runSync(restCodec.parse(printed.segments));
  assert.deepEqual(decoded, input);
  assert.deepEqual(remaining, []);
  assert.ok(Result.isFailure(runResult(restCodec.parse([]))));
  for (const segment of ['.', '..', '%FF', '%'])
    assert.ok(Result.isFailure(runResult(restCodec.parse([segment]))));
  const files = Runtime.nested(
    Route.slash(restCodec)(Route.literal('files')),
    Runtime.searchSchema(undefined),
  );
  const Files = Schema.TaggedStruct('Files', {
    params: Schema.Struct({ parts: Schema.NonEmptyArray(Id) }),
    search: Runtime.searchSchema(undefined),
  });
  const router = Route.mapTo({
    make: (value: Omit<typeof Files.Type, '_tag'>) => Files.make(value),
  })(files);
  const parser = Route.oneOf(router);
  const payload = { params: input, search: {} };
  const checked = Runtime.checkedHref(
    files,
    payload,
    parser,
    (value) => Schema.toEquivalence(Files)(Files.make(payload), value),
    mount,
  );
  const url = Effect.runSync(checked);
  assert.equal(url, '/app/files/a%2Fb/%252F/%E6%97%A5%E6%9C%AC%E8%AA%9E');
});

test('rest element transforms encode and decode independently', () => {
  const Positive = Schema.NumberFromString.check(Schema.isGreaterThan(0));
  const numbers = Runtime.rest('parts', Positive);
  const [value] = Effect.runSync(numbers.parse(['1', '2', '3']));
  assert.deepEqual(value, { parts: [1, 2, 3] });
  assert.deepEqual(Effect.runSync(numbers.print(value, state())).segments, ['1', '2', '3']);
  assert.ok(Result.isFailure(runResult(numbers.parse(['1', '0']))));
  assert.ok(Result.isFailure(runResult(numbers.print({ parts: [1, 0] }, state()))));
});

test('nested native root handles empty path and empty default Struct', () => {
  const empty = Runtime.searchSchema(undefined);
  const root = Runtime.nested(Route.root, empty);
  const Root = Schema.TaggedStruct('Root', { params: Schema.Struct({}), search: empty });
  const router = Route.mapTo({ make: (value: Omit<typeof Root.Type, '_tag'>) => Root.make(value) })(
    root,
  );
  const parser = Route.oneOf(router);
  const input = { params: {}, search: {} };
  assert.deepEqual(Effect.runSync(root.parse([])), [input, []]);
  // Effect's native empty Struct retains unknown fields; do not invent a stripping policy.
  assert.deepEqual(Effect.runSync(root.parse([], '?unknown=x')), [
    { params: {}, search: { unknown: 'x' } },
    [],
  ]);
  assert.equal(
    Effect.runSync(Runtime.checkedHref(root, input, parser, (value) => value._tag === 'Root')),
    '/',
  );
  assert.equal(
    Effect.runSync(
      Runtime.checkedHref(root, input, parser, (value) => value._tag === 'Root', {
        origin: mount.origin,
        base: '/',
      }),
    ),
    '/',
  );
  assert.equal(
    Effect.runSync(
      Runtime.checkedHref(root, input, parser, (value) => value._tag === 'Root', mount),
    ),
    '/app/',
  );
});

test('escaping adapter rejects children that violate single-segment shape', () => {
  const bad = Runtime.escapedSegment(Route.root);
  assert.ok(Result.isFailure(runResult(bad.parse(['x']))));
  assert.ok(Result.isFailure(runResult(bad.print({}, state()))));
});

test('sync href explicitly does not claim async codec support', async () => {
  const helpers = Runtime.hrefHelpers((_input: string) =>
    Effect.promise(() => Promise.resolve('/async')),
  );
  assert.throws(() => helpers.href('x'));
  assert.throws(() => helpers.hrefResult('x'));
});

test('stateless per-app Navigate delegates only checked hrefs to native transport', () => {
  class AppNavigate extends Context.Service<AppNavigate, Runtime.Navigate<Destination>>()(
    'runtime-test/Navigate',
  ) {}
  const calls: string[] = [];
  const service = Runtime.navigation(checkDestination, {
    pushUrl: (url) =>
      Effect.sync(() => {
        calls.push('push:' + url);
      }),
    replaceUrl: (url) =>
      Effect.sync(() => {
        calls.push('replace:' + url);
      }),
  });
  const command = (input: Destination) =>
    AppNavigate.pipe(Effect.flatMap((nav) => nav.push(input)));
  const pending = command(target('x'));
  assert.deepEqual(calls, []);
  Effect.runSync(pending.pipe(Effect.provideService(AppNavigate, service)));
  Effect.runSync(service.replace(target('y')));
  assert.deepEqual(calls, ['push:/app/people/x?page=1', 'replace:/app/people/y?page=1']);
  assert.ok(Result.isFailure(runResult(service.push(target('new')))));
  assert.equal(calls.length, 2);
});

test('normalizeInput validates decoded params and required search in typed channel', () => {
  const Positive = Schema.NumberFromString.check(Schema.isGreaterThan(0));
  const params = Schema.Struct({ n: Positive });
  const search = Schema.Struct({ q: Schema.String });
  assert.ok(
    Result.isFailure(
      runResult(Runtime.normalizeInput(params, search, { params: { n: 0 }, search: { q: 'ok' } })),
    ),
  );
  const normalized = Effect.runSync(
    Runtime.normalizeInput(params, search, { params: { n: 2 }, search: { q: 'ok' } }),
  );
  assert.deepEqual(normalized, { params: { n: 2 }, search: { q: 'ok' } });
});

test('invalid mount bases and unchecked parser remainder cannot produce checked href', () => {
  const payload = Effect.runSync(Runtime.normalizeInput(Params, Search, target('x')));
  for (const base of [
    'app',
    '/app/',
    '/app/..',
    '/app?x',
    '/app#x',
    '/app%2f',
    '/app//x',
    '/app\\x',
  ]) {
    assert.ok(
      Result.isFailure(
        runResult(
          Runtime.checkedHref(codec, payload, registry, () => true, { origin: mount.origin, base }),
        ),
      ),
    );
  }
  const prefix = {
    parse: () => Effect.succeed<[typeof Payload.Type, readonly string[]]>([payload, ['extra']]),
  };
  assert.ok(
    Result.isFailure(runResult(Runtime.checkedHref(codec, payload, prefix, () => true, mount))),
  );
});
