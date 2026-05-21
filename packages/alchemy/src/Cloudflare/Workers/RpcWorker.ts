import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  type Rpc,
  RpcClient,
  type RpcGroup,
  RpcSerialization,
} from "effect/unstable/rpc";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import type { HttpEffect } from "../../Http.ts";
import type { Rpc as RpcShape } from "../../Rpc.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import type { Worker, WorkerProps } from "./Worker.ts";
import { Worker as WorkerCtor, WorkerEnvironment } from "./Worker.ts";

/**
 * Props for {@link RpcWorker}. Same shape as {@link WorkerProps} with
 * an additional `schema` field carrying the rpc group definition.
 */
export type RpcWorkerProps<Rpcs extends Rpc.Any> = Omit<
  WorkerProps,
  "schema"
> & {
  /**
   * The {@link RpcGroup.RpcGroup} served on this worker's `fetch`
   * handler. The same value should be importable by any consumer of
   * the worker (other workers or scripts using `RpcClient.make`).
   */
  readonly schema: RpcGroup.RpcGroup<Rpcs>;
};

// Context tag carrying the surrounding `RpcWorker` value, so
// `yield* RpcWorker` inside the impl resolves to the worker itself
// (mirrors `yield* Worker` semantics inside `Cloudflare.Worker`).
// Documented as part of the main `RpcWorker` JSDoc below.
export class RpcWorkerScope extends Context.Service<RpcWorkerScope, Worker>()(
  "Cloudflare.RpcWorker",
) {}

// Symbol used internally to stash the rpc `RpcGroup` schema on the
// `effectClass` that `RpcWorker(...)` returns, so `RpcWorker.bind`
// can recover it when handed the class later.
const SchemaSymbol = Symbol.for("alchemy.RpcWorker.schema");

// Phantom carrier — `RpcWorker.bind` uses `Rpcs` to type the returned
// rpc client. We don't tie it to a specific `Effect.R` since the
// requirements come from the underlying `Cloudflare.Worker` factory
// and shouldn't leak into the Stack-side service signature.
export interface RpcWorkerYieldable<
  Self,
  Rpcs extends Rpc.Any,
> extends Effect.Effect<Worker<{}> & RpcShape<Self>, never, any> {
  /** @internal */
  readonly [SchemaSymbol]: RpcGroup.RpcGroup<Rpcs>;
}

/**
 * Type of the {@link RpcWorker} constructor. Mirrors the class-form
 * signature of {@link Worker} so `class X extends RpcWorker<X>()(...)`
 * works identically and the resulting worker is `Rpc<Self>`-typed for
 * binding consumers.
 */
export interface RpcWorkerClass extends Effect.Effect<
  Worker,
  never,
  RpcWorkerScope
> {
  /**
   * Class-based form: `class X extends RpcWorker<X>()(name, props, impl)`.
   *
   * Yielding the class in a Stack returns the {@link Worker} resource
   * (so `worker.url`, `worker.workerName`, etc. work as usual). To get
   * a typed `RpcClient` for *this* worker's rpc group from inside
   * another worker's init, call {@link RpcWorker.bind}.
   */
  <Self>(): {
    <Rpcs extends Rpc.Any, InnerR = never, InitReq = never>(
      id: string,
      props: RpcWorkerProps<Rpcs>,
      impl: Effect.Effect<
        Effect.Effect<HttpEffect<InnerR>, never, InnerR>,
        never,
        InitReq
      >,
    ): RpcWorkerYieldable<Self, Rpcs> & {
      // Phantom — `class X extends RpcWorker<X>()(...)` carries `X`
      // through the result type via `Rpc<Self>` on the binding side;
      // the instance shape itself is empty (no methods exposed on
      // `new X(...)` — everything goes through `fetch`).
      new (_: never): {};
    };
  };

  /**
   * Bind a typed Effect rpc client to a worker resource, using the
   * worker's declared rpc {@link RpcGroup.RpcGroup} schema. Mirrors
   * `Cloudflare.R2Bucket.bind(MyBucket)` and friends — but the
   * returned value is the rpc client itself, so `client.someRpc(...)`
   * calls go straight through to the bound worker's `fetch`.
   *
   * Pair with {@link RpcWorker} on the server side; both ends share
   * the same schema so values round-trip through one `Schema` codec.
   *
   * @example
   * ```ts
   * // Inside another worker's init
   * const tasks = yield* Cloudflare.RpcWorker.bind(TaskWorker);
   * const task = yield* tasks.getTask({ id: "abc" });
   * ```
   */
  readonly bind: <Self, Rpcs extends Rpc.Any>(
    workerEff: RpcWorkerYieldable<Self, Rpcs>,
  ) => Effect.Effect<
    RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError> & RpcShape<Self>,
    never,
    Worker
  >;
}

/**
 * `RpcWorker` is a thin sugar over {@link Worker} for the common case
 * where a worker's entire `fetch` surface is a typed Effect `RpcGroup`.
 * It takes the rpc `schema` directly in props alongside `main`, and
 * accepts an init Effect that returns the already-piped
 * `RpcServer.toHttpEffect(...)`-producing Effect (no `{ fetch }`
 * wrapper) — the wrapper plugs it into the worker's `fetch` for you.
 *
 * Functionally identical to writing `Cloudflare.Worker(...)` with
 * `return { fetch: RpcServer.toHttpEffect(schema).pipe(...) }`; use
 * whichever style you prefer.
 *
 * The class form (`class X extends Cloudflare.RpcWorker<X>()(...)`)
 * carries `Self` through the result type as `Rpc<Self>`, so other
 * workers binding to this one see the rpc shape pinned to `Self`.
 *
 * @resource
 *
 * @section Defining the rpc group
 * @example Pure schema description
 * The rpc group and its schemas live outside any worker so both the
 * server (`RpcWorker`) and any consumers (`RpcClient.make` /
 * `RpcDurableObjectNamespace`) import the same value.
 * ```typescript
 * import * as Schema from "effect/Schema";
 * import { Rpc, RpcGroup } from "effect/unstable/rpc";
 *
 * export class TaskNotFound extends Schema.TaggedClass<TaskNotFound>()(
 *   "TaskNotFound",
 *   { id: Schema.String },
 * ) {}
 *
 * const getTask = Rpc.make("getTask", {
 *   payload: { id: Schema.String },
 *   success: Schema.String,
 *   error: TaskNotFound,
 * });
 *
 * export class TaskRpcs extends RpcGroup.make(getTask) {}
 * ```
 *
 * @section Implementing the worker
 * @example Class form (recommended)
 * Mirrors `Cloudflare.Worker<Self>()(...)` — `class X extends ...`
 * works the same. The init Effect builds a handlers `Layer` from the
 * group and returns the `RpcServer.toHttpEffect(schema)`-piped Effect
 * directly.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
 * import { TaskRpcs } from "./rpcs.ts";
 *
 * export default class Worker extends Cloudflare.RpcWorker<Worker>()(
 *   "Worker",
 *   { main: import.meta.filename, schema: TaskRpcs },
 *   Effect.gen(function* () {
 *     const handlers = TaskRpcs.toLayer({
 *       getTask: ({ id }) => Effect.succeed(`task-${id}`),
 *     });
 *     return RpcServer.toHttpEffect(TaskRpcs).pipe(
 *       Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerJson)),
 *     );
 *   }),
 * ) {}
 * ```
 *
 * @example NDJSON for streaming rpcs
 * If any rpc in the group is a streaming rpc, the wire serialization
 * must be `RpcSerialization.layerNdjson` — streaming rpcs need
 * newline framing on the wire.
 * ```typescript
 * return RpcServer.toHttpEffect(ChatRpcs).pipe(
 *   Effect.provide(handlers),
 *   Effect.provide(RpcSerialization.layerNdjson),
 * );
 * ```
 *
 * @section Binding it from another worker
 * @example `Cloudflare.RpcWorker.bind(WorkerClass)`
 * Inside another worker's init, `RpcWorker.bind(WorkerClass)`
 * auto-registers the service binding on the surrounding worker and
 * returns a typed rpc client. The client's methods are typed by the
 * bound worker's `schema`. Mirrors `Cloudflare.R2Bucket.bind(MyBucket)`.
 * ```typescript
 * import TaskWorker from "./task-worker.ts";
 *
 * export default class Caller extends Cloudflare.RpcWorker<Caller>()(
 *   "Caller",
 *   { main: import.meta.filename, schema: CallerRpcs },
 *   Effect.gen(function* () {
 *     const tasks = yield* Cloudflare.RpcWorker.bind(TaskWorker);
 *     const handlers = CallerRpcs.toLayer({
 *       proxyGetTask: ({ id }) => tasks.getTask({ id }),
 *     });
 *     return RpcServer.toHttpEffect(CallerRpcs).pipe(
 *       Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerJson)),
 *     );
 *   }),
 * ) {}
 * ```
 *
 * @section Calling it from a script
 * @example Typed rpc client (outside a worker)
 * The same `RpcGroup` value drives a fully typed client for scripts
 * too. Errors arrive as the schema-typed values declared in
 * `Rpc.make` — match on them with `Effect.catchTag`.
 * ```typescript
 * import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
 * import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
 * import { TaskRpcs } from "./rpcs.ts";
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* RpcClient.make(TaskRpcs);
 *   return yield* client.getTask({ id: "abc" });
 * });
 *
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(
 *       Layer.mergeAll(
 *         RpcClient.layerProtocolHttp({ url: process.env.URL! }),
 *         RpcSerialization.layerJson,
 *         FetchHttpClient.layer,
 *       ),
 *     ),
 *   ),
 * );
 * ```
 *
 * @section Yielding the surrounding worker from inside the impl
 * @example `yield* RpcWorker` inside the init effect
 * Mirrors `yield* DurableObjectNamespace` — yield the tag to access
 * the surrounding worker.
 * ```typescript
 * Effect.gen(function* () {
 *   const self = yield* Cloudflare.RpcWorker;
 * });
 * ```
 */
const bind = <Self, Rpcs extends Rpc.Any>(
  workerEff: RpcWorkerYieldable<Self, Rpcs>,
): Effect.Effect<
  RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError> & RpcShape<Self>,
  never,
  Worker
> =>
  Effect.gen(function* () {
    const schema = (workerEff as unknown as Record<symbol, unknown>)[
      SchemaSymbol
    ] as RpcGroup.RpcGroup<Rpcs> | undefined;
    if (!schema) {
      return yield* Effect.die(
        new Error(
          "RpcWorker.bind: passed value isn't an RpcWorker class — no schema attached.",
        ),
      );
    }
    // Yielding the class auto-binds it as a service binding on the
    // surrounding worker (delegated to the underlying `Cloudflare.Worker`).
    const worker = (yield* workerEff) as Worker;
    // A fresh `RpcClient` is built per call. Cloudflare workers reject
    // I/O objects (the service-binding `stub.fetch` body) created on a
    // previous request — any cached client breaks with "Cannot perform
    // I/O on behalf of a different request" the moment a second request
    // arrives. Callers `yield*` this Effect once per request.
    const httpClient = HttpClient.layerMergedContext(
      Effect.map(WorkerEnvironment, (env) => {
        const stub = (env as Record<string, any>)[worker.LogicalId];
        return HttpClient.make((req) => stub.fetch(req));
      }),
    );
    const protocol = RpcClient.layerProtocolHttp({
      url: "http://alchemy-rpc-worker/",
    }).pipe(
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(httpClient),
    );
    return RpcClient.make(schema).pipe(
      Effect.provide(protocol),
    ) as unknown as RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError> &
      RpcShape<Self>;
  });

export const RpcWorker: RpcWorkerClass = (() => {
  const fn = (...args: any[]) => {
    // Class-form: zero args returns the `(name, props, impl) =>` builder.
    if (args.length === 0) {
      return (
        id: string,
        props: RpcWorkerProps<any>,
        impl: Effect.Effect<Effect.Effect<HttpEffect<any>>>,
      ) => build(id, props, impl);
    }
    // Bare form: `(name, props, impl)`.
    const [id, props, impl] = args as [
      string,
      RpcWorkerProps<any>,
      Effect.Effect<Effect.Effect<HttpEffect<any>>>,
    ];
    return build(id, props, impl);
  };

  const tagged = taggedFunction(RpcWorkerScope, fn as any) as any;
  tagged.bind = bind;
  return tagged;
})() as any;

const build = (
  id: string,
  props: RpcWorkerProps<any>,
  impl: Effect.Effect<Effect.Effect<HttpEffect<any>>>,
) => {
  const { schema, ...workerProps } = props;

  // Wrap the user's HttpEffect-returning Effect into the `{ fetch }`
  // shape `Cloudflare.Worker` expects.
  const wrappedImpl = Effect.map(
    impl,
    (fetch) => ({ fetch }) as unknown as { fetch: HttpEffect<any> },
  );

  // Delegate registration / binding metadata to the underlying
  // `Cloudflare.Worker`. The returned `effectClass`, when yielded,
  // produces the standard `Worker` resource (so `worker.url`,
  // `worker.workerName`, etc. all work as usual).
  const underlying = (WorkerCtor as any)()(id, workerProps, wrappedImpl);

  // Re-wrap as our own `effectClass` so we can stash the rpc schema
  // on the class for `RpcWorker.bind` to recover later. (Re-using
  // `effectClass` here means `class X extends RpcWorker<X>()(...)`
  // still works.)
  const klass = effectClass(
    (underlying as { asEffect(): Effect.Effect<Worker> }).asEffect(),
  ) as unknown as Record<symbol, unknown>;
  klass[SchemaSymbol] = schema;
  return klass;
};
