import { Option, Schema, Stream } from 'effect';
import { Subscription } from 'foldkit';

/** A serial allocated by the owning composition, never a route/dependency hash. */
export type Occurrence<Model> = Readonly<{ occurrence: number; model: Model }>;
export type OccurrenceDependencies<Dependencies> = Readonly<{
  active: Option.Option<Readonly<{ occurrence: number; dependencies: Dependencies }>>;
}>;

/** Extract the union of native stream requirements without fixing it to never. */
export type SubscriptionRequirements<RecordType> = RecordType[keyof RecordType] extends infer Entry
  ? Entry extends {
      readonly dependenciesToStream: (...args: never[]) => Stream.Stream<unknown, never, infer R>;
    }
    ? R
    : never
  : never;

type Config<CM, Msg, D, R, PM, PMsg, Key extends string> = Readonly<{
  owner: Subscription.Subscription<CM, Msg, D, R>;
  key: Key;
  read: (model: PM) => Option.Option<Occurrence<CM>>;
  toParentMessage: (message: Msg, occurrence: number) => PMsg;
}>;
type Native<PM, Msg, D, R> = Subscription.Subscription<PM, Msg, OccurrenceDependencies<D>, R>;
type Keeping<PM, Msg, D, R> = Extract<
  Native<PM, Msg, D, R>,
  { readonly keepAliveEquivalence: unknown }
>;
type Restarting<PM, Msg, D, R> = Exclude<
  Native<PM, Msg, D, R>,
  { readonly keepAliveEquivalence: unknown }
>;

/**
 * Lift one public native entry. Generate one call per named entry and aggregate
 * the returned records with Subscription.aggregate (which rejects collisions).
 * The author's dependency schema is nested intact, not reconstructed from fields.
 */
export function liftOccurrence<CM, Msg, D, R, PM, PMsg, const Key extends string>(
  config: Config<CM, Msg, D, R, PM, PMsg, Key> & {
    readonly owner: Extract<
      Subscription.Subscription<CM, Msg, D, R>,
      { readonly keepAliveEquivalence: unknown }
    >;
  },
): Readonly<Record<Key, Keeping<PM, PMsg, D, R>>>;
export function liftOccurrence<CM, Msg, D, R, PM, PMsg, const Key extends string>(
  config: Config<CM, Msg, D, R, PM, PMsg, Key> & {
    readonly owner: Subscription.EntryWithoutKeepAlive<CM, Msg, D, R>;
  },
): Readonly<Record<Key, Restarting<PM, PMsg, D, R>>>;
export function liftOccurrence<CM, Msg, D, R, PM, PMsg, const Key extends string>(
  config: Config<CM, Msg, D, R, PM, PMsg, Key>,
): Readonly<Record<Key, Native<PM, PMsg, D, R>>>;
export function liftOccurrence<
  ChildModel,
  ChildMessage,
  Dependencies,
  Services,
  ParentModel,
  ParentMessage,
  const Key extends string,
>(config: {
  readonly owner: Subscription.Subscription<ChildModel, ChildMessage, Dependencies, Services>;
  readonly key: Key;
  readonly read: (model: ParentModel) => Option.Option<Occurrence<ChildModel>>;
  readonly toParentMessage: (message: ChildMessage, occurrence: number) => ParentMessage;
}): Readonly<
  Record<
    Key,
    Subscription.Subscription<
      ParentModel,
      ParentMessage,
      OccurrenceDependencies<Dependencies>,
      Services
    >
  >
> {
  const { owner, read, toParentMessage, key } = config;
  if (key.length === 0) throw new Error('liftOccurrence: subscription key must be nonempty');
  const fields = {
    active: Schema.Option(
      Schema.Struct({ occurrence: Schema.Number, dependencies: owner.dependenciesSchema }),
    ),
  };
  const modelToDependencies = (model: ParentModel): OccurrenceDependencies<Dependencies> => ({
    active: Option.map(read(model), (origin) => ({
      occurrence: origin.occurrence,
      dependencies: owner.modelToDependencies(origin.model),
    })),
  });
  const record = Subscription.make<ParentModel, ParentMessage, Services>()((entry) => {
    if (owner.keepAliveEquivalence !== undefined) {
      const equivalent = owner.keepAliveEquivalence;
      return {
        [key]: entry(fields, {
          modelToDependencies,
          keepAliveEquivalence: (left, right) =>
            Option.isNone(left.active)
              ? Option.isNone(right.active)
              : Option.isSome(right.active) &&
                left.active.value.occurrence === right.active.value.occurrence &&
                equivalent(left.active.value.dependencies, right.active.value.dependencies),
          dependenciesToStream: ({ active }, readLatest) => {
            if (Option.isNone(active)) return Stream.empty;
            const origin = active.value;
            return owner
              .dependenciesToStream(origin.dependencies, () => {
                const latest = readLatest().active;
                return Option.isSome(latest) && latest.value.occurrence === origin.occurrence
                  ? latest.value.dependencies
                  : origin.dependencies;
              })
              .pipe(Stream.map((message) => toParentMessage(message, origin.occurrence)));
          },
        }),
      };
    }
    return {
      [key]: entry(fields, {
        modelToDependencies,
        dependenciesToStream: ({ active }) => {
          if (Option.isNone(active)) return Stream.empty;
          const origin = active.value;
          return owner
            .dependenciesToStream(origin.dependencies)
            .pipe(Stream.map((message) => toParentMessage(message, origin.occurrence)));
        },
      }),
    };
  });
  // TS widens a computed generic property name to string. This assertion only
  // restores that key; all callback, dependency and service types were checked
  // by native make above. It neither invents a brand nor erases Services.
  return record as Readonly<
    Record<
      Key,
      Subscription.Subscription<
        ParentModel,
        ParentMessage,
        OccurrenceDependencies<Dependencies>,
        Services
      >
    >
  >;
}
