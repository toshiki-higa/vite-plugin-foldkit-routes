import { Effect, Record, Schema } from 'effect';
import { Navigation, Route } from 'foldkit';

const error = (message: string) => new Route.ParseError({ message });
const emptySearch = Schema.Struct({});

export type RouteConfig = {
  readonly params?: Readonly<Record<string, Schema.Codec<unknown, string>>>;
  readonly search?: Schema.Struct<Schema.Struct.Fields>;
};
export type ParamSchema<C, K extends string> = C extends { readonly params: infer P }
  ? K extends keyof P
    ? P[K]
    : typeof Schema.String
  : typeof Schema.String;
export type SearchSchema<C> = C extends { readonly search: infer S } ? S : typeof emptySearch;

export function paramSchema<C extends RouteConfig | undefined, K extends string>(
  config: C,
  key: K,
): ParamSchema<C, K>;
export function paramSchema(
  config: RouteConfig | undefined,
  key: string,
): Schema.Codec<unknown, string> {
  const params = config?.params;
  return params && Object.hasOwn(params, key) ? (params[key] ?? Schema.String) : Schema.String;
}
export function searchSchema<C extends RouteConfig | undefined>(config: C): SearchSchema<C>;
export function searchSchema(config: RouteConfig | undefined): Schema.Struct<Schema.Struct.Fields> {
  return config?.search ?? emptySearch;
}

export type Input<P extends Schema.Constraint, S extends Schema.Constraint> = {
  readonly params: P['Type'];
  readonly search: S['Type'];
};
export type DestinationInput<P extends Schema.Constraint, S extends Schema.Constraint> = {
  readonly params: P['Type'];
} & ({} extends S['~type.make.in']
  ? { readonly search?: S['~type.make.in'] }
  : { readonly search: S['~type.make.in'] });

/** Preserve the environment union of native commands/effects, including function returns. */
export type EffectRequirements<T> =
  T extends Effect.Effect<infer _A, infer _E, infer R>
    ? R
    : T extends (...args: never[]) => infer Out
      ? EffectRequirements<Out>
      : never;

/** One decoded default, used by both wire decoding and the ergonomic constructor. */
export function searchDefault<S extends Schema.Constraint & Schema.WithoutConstructorDefault>(
  schema: S,
  value: S['Type'] & S['~type.make.in'],
) {
  const decoding = Schema.withDecodingDefaultTypeKey<S>(Effect.succeed(value))(schema);
  return Schema.withConstructorDefault<typeof decoding>(Effect.succeed(value))(decoding);
}

/** Decode transport once; the child is a single-segment domain codec. */
export function escapedSegment<A>(child: Route.Biparser<A>): Route.Biparser<A> {
  return {
    parse: (segments, search) =>
      Effect.gen(function* () {
        if (!segments.length) return yield* Effect.fail(error('Missing segment'));
        const head = yield* decodeSegment(segments[0]!);
        const [value, remaining] = yield* child.parse([head, ...segments.slice(1)], search);
        if (remaining.length !== segments.length - 1)
          return yield* Effect.fail(error('Expected one consumed segment'));
        return [value, remaining];
      }),
    print: (value, state) =>
      Effect.gen(function* () {
        const printed = yield* child.print(value, { segments: [], queryParams: state.queryParams });
        if (printed.segments.length !== 1)
          return yield* Effect.fail(error('Expected one printed segment'));
        const text = yield* encodeSegment(printed.segments[0]!);
        return { segments: [...state.segments, text], queryParams: printed.queryParams };
      }),
  };
}
function stableSegment(text: string): boolean {
  return text !== '' && text !== '.' && text !== '..';
}
function decodeSegment(text: string) {
  return Effect.try({
    try: () => decodeURIComponent(text),
    catch: () => error('Malformed path escape'),
  }).pipe(
    Effect.flatMap((value) =>
      stableSegment(value) ? Effect.succeed(value) : Effect.fail(error('Unstable segment')),
    ),
  );
}
function encodeSegment(text: string) {
  return stableSegment(text)
    ? Effect.try({ try: () => encodeURIComponent(text), catch: () => error('Unencodable segment') })
    : Effect.fail(error('Unstable segment'));
}
export function param<K extends string, A>(
  name: K,
  schema: Schema.Codec<A, string>,
): Route.Biparser<Record<K, A>> {
  return escapedSegment(Route.schemaSegment(name, schema));
}

/** Terminal, nonempty rest, with escaping and schema transport applied per element. */
export function rest<K extends string, A>(
  name: K,
  schema: Schema.Codec<A, string>,
): Route.TerminalParser<Record<K, readonly [A, ...A[]]>> {
  const element = param(name, schema);
  return {
    __terminal: true,
    parse: (segments, search) =>
      Effect.gen(function* () {
        if (!segments.length) return yield* Effect.fail(error('Missing rest segments'));
        const values = yield* Effect.forEach(segments, (segment) =>
          element.parse([segment], search).pipe(Effect.map(([value]) => value[name])),
        );
        // Nonemptiness was checked before traversal; no unchecked payload cast.
        const first = values[0]!;
        const payload = Record.singleton<K, readonly [A, ...A[]]>(name, [
          first,
          ...values.slice(1),
        ]);
        return [payload, []];
      }),
    print: (value, state) =>
      Effect.gen(function* () {
        if (!value[name].length) return yield* Effect.fail(error('Missing rest segments'));
        let next = state;
        for (const item of value[name]) {
          next = yield* element.print(Record.singleton(name, item), next);
        }
        return next;
      }),
  };
}
const neutral: Route.Biparser<{}> = {
  parse: (segments) => Effect.succeed([{}, segments]),
  print: (_, state) => Effect.succeed(state),
};
/** Deliberately does not enforce completion: native oneOf owns it and fallthrough. */
export function nested<P, Q extends {}, I extends Readonly<Record<string, unknown>>>(
  path: Route.Biparser<P>,
  search: Schema.Codec<Q, I>,
): Route.TerminalParser<{ params: P; search: Q }> {
  const query = Route.query(search)(neutral);
  return {
    __terminal: true,
    parse: (segments, rawSearch) =>
      Effect.gen(function* () {
        const [params, remaining] = yield* path.parse(segments, rawSearch);
        const [search, rest] = yield* query.parse(remaining, rawSearch);
        return [{ params, search }, rest];
      }),
    print: (value, state) =>
      path
        .print(value.params, state)
        .pipe(Effect.flatMap((next) => query.print(value.search, next))),
  };
}

/** Constructor failures belong to the same checked href channel as encoding failures. */
export function normalizeInput<P extends Schema.Struct.Fields, S extends Schema.Struct.Fields>(
  params: Schema.Struct<P>,
  search: Schema.Struct<S>,
  input: DestinationInput<Schema.Struct<P>, Schema.Struct<S>>,
): Effect.Effect<Input<Schema.Struct<P>, Schema.Struct<S>>, Route.ParseError> {
  return Effect.gen(function* () {
    const decodedParams = yield* Schema.decodeUnknownEffect(Schema.toType(params))(
      input.params,
    ).pipe(Effect.mapError((cause) => error(String(cause))));
    const decodedSearch = yield* Effect.try({
      try: () => search.make(input.search ?? ({} as Schema.Struct.MakeIn<S>)),
      catch: (cause) => error(String(cause)),
    });
    return { params: decodedParams, search: decodedSearch };
  });
}

export type Mount = { readonly origin: string; readonly base?: string };
const defaultMount: Mount = { origin: 'https://routes.invalid' };
function mountBase(mount: Mount) {
  const base = mount.base === '/' ? '' : (mount.base ?? '');
  if (
    base !== '' &&
    (base[0] !== '/' ||
      base.endsWith('/') ||
      /[?#%\\]/.test(base) ||
      base.includes('//') ||
      base.split('/').some((s) => s === '.' || s === '..'))
  ) {
    return Effect.fail(error('Invalid route mount base'));
  }
  return Effect.succeed(base);
}
export function parseAtMount<A>(
  parser: Pick<Route.Biparser<A>, 'parse'>,
  url: URL,
  mount: Mount = defaultMount,
) {
  return Effect.gen(function* () {
    const base = yield* mountBase(mount);
    if (
      url.origin !== mount.origin ||
      (base && url.pathname !== base && !url.pathname.startsWith(base + '/'))
    ) {
      return yield* Effect.fail(error('Outside route mount'));
    }
    return yield* parser.parse(
      url.pathname.slice(base.length).split('/').filter(Boolean),
      url.search,
    );
  });
}

/** Local print is insufficient: validate normalization and global ordered identity. */
export function checkedHref<P, A>(
  codec: Route.Biparser<P>,
  payload: P,
  parser: Pick<Route.Biparser<A>, 'parse'>,
  same: (resolved: A) => boolean,
  mount: Mount = defaultMount,
): Effect.Effect<string, Route.ParseError> {
  return Effect.gen(function* () {
    const base = yield* mountBase(mount);
    const state = yield* codec.print(payload, { segments: [], queryParams: new URLSearchParams() });
    const query = state.queryParams.toString();
    const text = `${base}/${state.segments.join('/')}${query ? '?' + query : ''}`;
    const url = yield* Effect.try({
      try: () => new URL(text, mount.origin),
      catch: () => error('Invalid route URL'),
    });
    const [resolved, remaining] = yield* parseAtMount(parser, url, mount);
    if (remaining.length || !same(resolved))
      return yield* Effect.fail(error('Global route roundtrip failed'));
    return url.pathname + url.search;
  });
}
export function hrefHelpers<D>(check: (destination: D) => Effect.Effect<string, Route.ParseError>) {
  const checked = (destination: D) => Effect.suspend(() => check(destination));
  return {
    href: (destination: D): string => Effect.runSync(checked(destination)),
    hrefResult: (destination: D) => Effect.runSync(Effect.result(checked(destination))),
  };
}

/** Service shape; each application declares its own native Context.Service identity. */
export type Navigate<D> = {
  readonly push: (destination: D) => Effect.Effect<void, Route.ParseError>;
  readonly replace: (destination: D) => Effect.Effect<void, Route.ParseError>;
};
/** Stateless native Navigation facade: no second history runtime or hidden context. */
export function navigation<D>(
  check: (destination: D) => Effect.Effect<string, Route.ParseError>,
  transport: Pick<typeof Navigation, 'pushUrl' | 'replaceUrl'> = Navigation,
): Navigate<D> {
  return {
    push: (destination) =>
      Effect.suspend(() => check(destination)).pipe(Effect.flatMap(transport.pushUrl)),
    replace: (destination) =>
      Effect.suspend(() => check(destination)).pipe(Effect.flatMap(transport.replaceUrl)),
  };
}
