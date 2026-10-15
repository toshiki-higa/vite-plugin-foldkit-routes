// Inert compile-only proof: never invoke this function.
import { Context, Effect, Option, Schema, Stream } from 'effect';
import { Subscription } from 'foldkit';
import {
  liftOccurrence,
  type OccurrenceDependencies,
  type SubscriptionRequirements,
} from '../src/subscriptions.ts';
const Service = Context.Service<{ readonly value: number }>('SubscriptionTypes/Service');
type Service = typeof Service.Service;
type Child = { readonly count: number };
type Parent = {
  readonly child: Option.Option<{ readonly occurrence: number; readonly model: Child }>;
};
type Message = { readonly count: number; readonly occurrence: number };

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <_T extends true>() => {};
export function compileProof(): void {
  const child = Subscription.make<Child, number, Service>()((entry) => ({
    watch: entry(
      { count: Schema.Number },
      {
        modelToDependencies: (model) => model,
        keepAliveEquivalence: (a, b) => a.count === b.count,
        dependenciesToStream: (initial, read) =>
          Stream.fromEffect(
            Effect.map(Service, (service) => service.value + initial.count + read().count),
          ),
      },
    ),
    plain: entry(
      { count: Schema.Number },
      {
        modelToDependencies: (model) => model,
        dependenciesToStream: (initial) =>
          Stream.fromEffect(Effect.map(Service, (service) => service.value + initial.count)),
      },
    ),
  }));
  const read = (model: Parent) => model.child;
  const toParentMessage = (count: number, occurrence: number): Message => ({ count, occurrence });
  const watch = liftOccurrence({ owner: child.watch, key: 'page/a/watch', read, toParentMessage });
  const plain = liftOccurrence({
    owner: child.plain,
    key: 'layout/a/plain',
    read,
    toParentMessage,
  });
  const aggregate = Subscription.aggregate(watch, plain);
  same<Equal<SubscriptionRequirements<typeof aggregate>, Service>>();
  same<Equal<keyof typeof aggregate, 'page/a/watch' | 'layout/a/plain'>>();
  const dependencies = watch['page/a/watch'].modelToDependencies({ child: Option.none() });
  same<Equal<typeof dependencies, OccurrenceDependencies<Child>>>();
  watch['page/a/watch'].keepAliveEquivalence(dependencies, dependencies);
  plain['layout/a/plain'].dependenciesToStream(dependencies);
  // @ts-expect-error no-keepAlive must remain non-callable, not silently gain equivalence.
  plain['layout/a/plain'].keepAliveEquivalence(dependencies, dependencies);
  liftOccurrence({
    owner: child.watch,
    key: 'bad/read',
    // @ts-expect-error absent origin/model projection is not the adapter contract.
    read: (model: Parent) => Option.map(model.child, (x) => x.model),
    toParentMessage,
  });
  // @ts-expect-error entry still requires Service: do not erase R to never.
  const erased: Subscription.Subscriptions<Parent, Message> = aggregate;
  void erased;
  const stream = watch['page/a/watch'].dependenciesToStream(dependencies, () => dependencies);
  // @ts-expect-error service must be supplied before executing the stream.
  void Effect.runPromise(Stream.runCollect(stream));
  void Effect.runPromise(
    Stream.runCollect(stream).pipe(Effect.provideService(Service, { value: 1 })),
  );
  // @ts-expect-error precise literal namespaces exclude unknown keys.
  void aggregate['page/b/watch'];
  // @ts-expect-error exact child dependency fields survive lifting.
  const wrong: OccurrenceDependencies<{ readonly count: string }> = dependencies;
  void wrong;
  // Different native service requirements union through aggregation.
  const Other = Context.Service<{ readonly label: string }>('SubscriptionTypes/Other');
  const other = Subscription.make<Child, string, typeof Other.Service>()((entry) => ({
    label: entry(
      {},
      {
        modelToDependencies: () => ({}),
        dependenciesToStream: () => Stream.fromEffect(Effect.map(Other, (s) => s.label)),
      },
    ),
  }));
  const liftedOther = liftOccurrence({
    owner: other.label,
    key: 'layout/b/label',
    read,
    toParentMessage: (label: string, occurrence: number) => ({ label, occurrence }),
  });
  same<
    Equal<SubscriptionRequirements<ReturnType<typeof combine>>, Service | typeof Other.Service>
  >();
  function combine() {
    return Subscription.aggregate(aggregate, liftedOther);
  }
}
