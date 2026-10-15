import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { Context, Deferred, Effect, Fiber, Option, Queue, Schema, Stream } from 'effect';
import { Subscription } from 'foldkit';
import { liftOccurrence, type OccurrenceDependencies } from '../src/subscriptions.ts';

type Child = { readonly key: string; readonly live: number };
type Message = { readonly occurrence: number; readonly live: number };
type Parent = Option.Option<{ readonly occurrence: number; readonly model: Child }>;
const Probe = Context.Service<{ readonly acquired: Queue.Queue<Lease> }>('SubscriptionsTest/Probe');
type Probe = typeof Probe.Service;
type Lease = { readonly tick: Queue.Queue<void>; readonly released: Deferred.Deferred<number> };
const fields = {
  key: Schema.String.annotate({ title: 'Native key dependency' }),
  live: Schema.NumberFromString,
};
const owner = Subscription.make<Child, number, Probe>()((entry) => ({
  watch: entry(fields, {
    modelToDependencies: (model) => model,
    keepAliveEquivalence: (a, b) => a.key === b.key,
    dependenciesToStream: (initial, read) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const probe = yield* Probe;
          const lease = yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const lease = {
                tick: yield* Queue.make<void>(),
                released: yield* Deferred.make<number>(),
              };
              yield* Queue.offer(probe.acquired, lease);
              return lease;
            }),
            (lease) => Deferred.succeed(lease.released, read().live),
          );
          return Stream.fromQueue(lease.tick).pipe(Stream.map(() => read().live));
        }),
      ),
  }),
  snapshot: entry(fields, {
    modelToDependencies: (model) => model,
    dependenciesToStream: (initial) => Stream.succeed(initial.live),
  }),
  persistent: Subscription.persistentEntry(Stream.succeed(42)),
}));
const read = (model: Parent) => model;
const toParentMessage = (live: number, occurrence: number): Message => ({ live, occurrence });
const watch = liftOccurrence({ owner: owner.watch, key: 'page/item/watch', read, toParentMessage });
const snapshot = liftOccurrence({
  owner: owner.snapshot,
  key: 'page/item/snapshot',
  read,
  toParentMessage,
});
const persistent = liftOccurrence({
  owner: owner.persistent,
  key: 'layout/root/persistent',
  read,
  toParentMessage,
});
const entry = watch['page/item/watch'];
const restarting = snapshot['page/item/snapshot'];
const state = (occurrence: number, live: number): Parent =>
  Option.some({ occurrence, model: { key: 'equal-domain-key', live } });
const first = state(1, 10);
const retained = state(1, 20);
const b = state(2, 99);
const again = state(3, 10);

test('keepAlive requires the same occurrence even for equal A → B → A dependencies', () => {
  const deps = entry.modelToDependencies;
  assert.equal(entry.keepAliveEquivalence(deps(first), deps(retained)), true);
  assert.equal(entry.keepAliveEquivalence(deps(first), deps(b)), false);
  assert.equal(entry.keepAliveEquivalence(deps(first), deps(again)), false);
  assert.equal(entry.keepAliveEquivalence(deps(Option.none()), deps(Option.none())), true);
  assert.equal(entry.keepAliveEquivalence(deps(first), deps(Option.none())), false);
  assert.equal(entry.keepAliveEquivalence(deps(Option.none()), deps(first)), false);
});

test('no-keepAlive retains native variant, schema equality, transforms, and captured origin', async () => {
  assert.equal(Object.hasOwn(restarting, 'keepAliveEquivalence'), false);
  const deps = restarting.modelToDependencies;
  const equivalent = Schema.toEquivalence(restarting.dependenciesSchema);
  assert.equal(equivalent(deps(first), deps(first)), true);
  assert.equal(equivalent(deps(first), deps(retained)), false);
  assert.equal(equivalent(deps(first), deps(again)), false);
  assert.deepEqual(
    await Effect.runPromise(
      Stream.runCollect(restarting.dependenciesToStream(deps(first))).pipe(
        Effect.provideService(Probe, { acquired: await Effect.runPromise(Queue.make<Lease>()) }),
      ),
    ),
    [{ occurrence: 1, live: 10 }],
  );
  // Nest the ORIGINAL schema: a NumberFromString field must still encode as text.
  // Native Subscription's public Schema<D> annotation hides codec services.
  // This fixture's fields are known service-free; only that fixture fact is asserted.
  const codec = Schema.toCodecJson(restarting.dependenciesSchema) as unknown as Schema.Codec<
    OccurrenceDependencies<Child>,
    Schema.Json
  >;
  const encoded = Schema.encodeSync(codec)(deps(first));
  assert.match(JSON.stringify(encoded), /"live":"10"/);
  assert.match(
    JSON.stringify(Schema.toJsonSchemaDocument(restarting.dependenciesSchema)),
    /Native key dependency/,
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(encoded))),
    deps(first),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(codec)({
      active: {
        _tag: 'Some',
        value: { occurrence: 'not-number', dependencies: { key: 'k', live: '10' } },
      },
    }),
  );
});

test('absent does not project child dependencies or acquire services; persistent entries are gated', async () => {
  const absent = entry.modelToDependencies(Option.none());
  const acquired = await Effect.runPromise(Queue.make<Lease>());
  assert.deepEqual(
    await Effect.runPromise(
      Stream.runCollect(entry.dependenciesToStream(absent, () => absent)).pipe(
        Effect.provideService(Probe, { acquired }),
      ),
    ),
    [],
  );
  assert.equal(Option.isNone(await Effect.runPromise(Queue.poll(acquired))), true);
  const p = persistent['layout/root/persistent'];
  assert.deepEqual(
    await Effect.runPromise(
      Stream.runCollect(p.dependenciesToStream(p.modelToDependencies(Option.none()))),
    ),
    [],
  );
  assert.deepEqual(
    await Effect.runPromise(
      Stream.runCollect(p.dependenciesToStream(p.modelToDependencies(first))),
    ),
    [{ occurrence: 1, live: 42 }],
  );
  const forbidden = Subscription.make<Child, number>()((build) => ({
    check: build(
      {},
      {
        modelToDependencies: () => {
          throw new Error('absent child must not be read');
        },
        dependenciesToStream: () => Stream.empty,
      },
    ),
  }));
  const gate = liftOccurrence({ owner: forbidden.check, key: 'gate/check', read, toParentMessage });
  assert.deepEqual(gate['gate/check'].modelToDependencies(Option.none()), {
    active: Option.none(),
  });
});

test('multiple owner namespaces aggregate; duplicate keys fail closed', () => {
  const other = liftOccurrence({
    owner: owner.watch,
    key: 'layout/item/watch',
    read,
    toParentMessage,
  });
  const combined = Subscription.aggregate(watch, snapshot, other, persistent);
  assert.deepEqual(Object.keys(combined), [
    'page/item/watch',
    'page/item/snapshot',
    'layout/item/watch',
    'layout/root/persistent',
  ]);
  assert.equal(combined['layout/item/watch'], other['layout/item/watch']);
  assert.throws(() => Subscription.aggregate(watch, watch), /duplicate.*page\/item\/watch/i);
  assert.throws(
    () => liftOccurrence({ owner: owner.watch, key: '', read, toParentMessage }),
    /nonempty/,
  );
});

test('no-keepAlive streams acquire and finalize under their starting dependencies', async () => {
  const native = Subscription.make<Child, number, Probe>()((build) => ({
    fixed: build(fields, {
      modelToDependencies: (model) => model,
      dependenciesToStream: (initial) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const probe = yield* Probe;
            const lease = yield* Effect.acquireRelease(
              Effect.gen(function* () {
                const lease = {
                  tick: yield* Queue.make<void>(),
                  released: yield* Deferred.make<number>(),
                };
                yield* Queue.offer(probe.acquired, lease);
                return lease;
              }),
              (lease) => Deferred.succeed(lease.released, initial.live),
            );
            return Stream.fromQueue(lease.tick).pipe(Stream.map(() => initial.live));
          }),
        ),
    }),
  }));
  const lifted = liftOccurrence({
    owner: native.fixed,
    key: 'page/fixed/stream',
    read,
    toParentMessage,
  })['page/fixed/stream'];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const acquired = yield* Queue.make<Lease>();
        const messages = yield* Queue.make<Message>();
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(
            lifted.dependenciesToStream(lifted.modelToDependencies(first)),
            (message) => Queue.offer(messages, message),
          ).pipe(Effect.provideService(Probe, { acquired })),
        );
        const lease = yield* Queue.take(acquired);
        yield* Queue.offer(lease.tick, undefined);
        assert.deepEqual(yield* Queue.take(messages), { occurrence: 1, live: 10 });
        yield* Fiber.interrupt(fiber);
        assert.equal(yield* Deferred.await(lease.released), 10);
      }),
    ).pipe(Effect.timeout('5 seconds')),
  );
});

test('two simultaneous owner namespaces have independent captured origins and finalizers', async () => {
  type Pair = { readonly a: Parent; readonly b: Parent };
  const a = liftOccurrence({
    owner: owner.watch,
    key: 'layout/a/watch',
    read: (p: Pair) => p.a,
    toParentMessage,
  })['layout/a/watch'];
  const other = liftOccurrence({
    owner: owner.watch,
    key: 'layout/b/watch',
    read: (p: Pair) => p.b,
    toParentMessage,
  })['layout/b/watch'];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const acquired = yield* Queue.make<Lease>();
        const messages = yield* Queue.make<Message>();
        let current: Pair = { a: first, b };
        const fa = yield* Effect.forkChild(
          Stream.runForEach(
            a.dependenciesToStream(a.modelToDependencies(current), () =>
              a.modelToDependencies(current),
            ),
            (message) => Queue.offer(messages, message),
          ).pipe(Effect.provideService(Probe, { acquired })),
        );
        const la = yield* Queue.take(acquired);
        const fb = yield* Effect.forkChild(
          Stream.runForEach(
            other.dependenciesToStream(other.modelToDependencies(current), () =>
              other.modelToDependencies(current),
            ),
            (message) => Queue.offer(messages, message),
          ).pipe(Effect.provideService(Probe, { acquired })),
        );
        const lb = yield* Queue.take(acquired);
        current = { a: again, b: state(2, 77) };
        yield* Queue.offer(la.tick, undefined);
        assert.deepEqual(yield* Queue.take(messages), { occurrence: 1, live: 10 });
        yield* Queue.offer(lb.tick, undefined);
        assert.deepEqual(yield* Queue.take(messages), { occurrence: 2, live: 77 });
        yield* Fiber.interrupt(fa);
        assert.equal(yield* Deferred.await(la.released), 10);
        yield* Fiber.interrupt(fb);
        assert.equal(yield* Deferred.await(lb.released), 77);
      }),
    ).pipe(Effect.timeout('5 seconds')),
  );
});

test('actual scoped stream finalization reads starting deps, never retired replacement; messages capture origin', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const acquired = yield* Queue.make<Lease>();
        const messages = yield* Queue.make<Message>();
        // Explicit fake boundary supplied to native stream, not an adapter registry.
        let current = first;
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(
            entry.dependenciesToStream(entry.modelToDependencies(first), () =>
              entry.modelToDependencies(current),
            ),
            (message) => Queue.offer(messages, message),
          ).pipe(Effect.provideService(Probe, { acquired })),
        );
        const lease = yield* Queue.take(acquired);
        current = retained;
        yield* Queue.offer(lease.tick, undefined);
        assert.deepEqual(yield* Queue.take(messages), { occurrence: 1, live: 20 });
        current = b;
        yield* Queue.offer(lease.tick, undefined);
        assert.deepEqual(yield* Queue.take(messages), { occurrence: 1, live: 10 });
        current = again;
        yield* Queue.offer(lease.tick, undefined);
        assert.deepEqual(yield* Queue.take(messages), { occurrence: 1, live: 10 });
        current = Option.none();
        yield* Fiber.interrupt(fiber);
        assert.equal(yield* Deferred.await(lease.released), 10);
        assert.equal(Option.isNone(yield* Queue.poll(acquired)), true);
      }),
    ).pipe(Effect.timeout('5 seconds')),
  );
});
