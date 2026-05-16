import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import type { HttpEffect } from "../../Http.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import {
  DurableObjectNamespace,
  type DurableObjectNamespaceLike,
  type DurableObjectNamespaceProps,
  type DurableObjectNamespace as DurableObjectNamespaceType,
  type DurableObjectServices,
} from "./DurableObjectNamespace.ts";
import type { DurableObjectState } from "./DurableObjectState.ts";
import { bindEffectRpc } from "./Rpc.ts";
import type { Worker as WorkerService } from "./Worker.ts";

/**
 * The runtime value bound to a typed rpc Durable Object namespace.
 * Same shape as the underlying {@link DurableObjectNamespaceType} for
 * binding metadata (name, namespaceId, kind), but `getByName(id)`
 * returns a typed Effect `RpcClient` over the rpc server living on
 * the DO's `fetch` handler.
 */
export interface RpcDurableObjectNamespace<
  Self,
  Rpcs extends Rpc.Any = Rpc.Any,
> extends Omit<
  DurableObjectNamespaceType<{ fetch: HttpEffect<DurableObjectState> }>,
  "getByName" | "get" | "Shape"
> {
  /** @internal phantom — keeps `Self` reachable through the inferred type */
  Self?: Self;
  readonly getByName: (
    id: string,
  ) => Effect.Effect<
    RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError>,
    never,
    Scope.Scope | Rpc.MiddlewareClient<Rpcs>
  >;
}

// Context tag carrying the surrounding `RpcDurableObjectNamespace`
// inside an rpc DO impl. Yield it from within a DO handler to refer
// back to the surrounding namespace (e.g. to fan a call out to
// sibling instances). Documented as part of the main
// `RpcDurableObjectNamespace` JSDoc below.
export class RpcDurableObjectNamespaceScope extends Context.Service<
  RpcDurableObjectNamespaceScope,
  RpcDurableObjectNamespace<unknown>
>()("Cloudflare.RpcDurableObjectNamespace") {}

export interface RpcDurableObjectNamespaceClass extends Effect.Effect<
  RpcDurableObjectNamespace<unknown>,
  never,
  RpcDurableObjectNamespaceScope
> {
  /** Class-based form: `class X extends RpcDurableObjectNamespace<X>()(...)` */
  <Self>(): {
    <Rpcs extends Rpc.Any, InnerR = never, InitReq = never>(
      name: string,
      props: { readonly schema: RpcGroup.RpcGroup<Rpcs> },
      impl: Effect.Effect<
        Effect.Effect<
          Effect.Effect<HttpEffect<InnerR>, never, InnerR>,
          never,
          DurableObjectServices
        >,
        never,
        InitReq
      >,
    ): Effect.Effect<
      RpcDurableObjectNamespace<Self, Rpcs>,
      never,
      WorkerService | Exclude<InitReq | InnerR, DurableObjectServices>
    > & {
      new (_: never): {};
    };
  };
  /** Descriptor-only form, for `worker.bind` declarations */
  <Rpcs extends Rpc.Any>(
    name: string,
    props: {
      readonly schema: RpcGroup.RpcGroup<Rpcs>;
    } & Partial<DurableObjectNamespaceProps>,
  ): DurableObjectNamespaceLike<{ fetch: HttpEffect<DurableObjectState> }>;
  /** Bare form: `(name, { schema }, impl)` */
  <Rpcs extends Rpc.Any, InnerR = never, InitReq = never>(
    name: string,
    props: { readonly schema: RpcGroup.RpcGroup<Rpcs> },
    impl: Effect.Effect<
      Effect.Effect<
        Effect.Effect<HttpEffect<InnerR>, never, InnerR>,
        never,
        DurableObjectServices
      >,
      never,
      InitReq
    >,
  ): Effect.Effect<
    RpcDurableObjectNamespace<unknown, Rpcs>,
    never,
    WorkerService | Exclude<InitReq | InnerR, DurableObjectServices>
  >;
}

/**
 * `RpcDurableObjectNamespace` is sugar over {@link DurableObjectNamespace}
 * for Durable Objects whose surface is a typed Effect `RpcGroup`. The
 * DO serves an `RpcServer.toHttpEffect(group)` on its own `fetch`, and
 * consumers see `namespace.getByName(id)` as a typed `RpcClient`
 * directly — no manual client wiring.
 *
 * Use this over alchemy's built-in DO method bridge whenever values
 * crossing the DO boundary contain `Schema.Class` instances. The
 * built-in bridge `JSON.stringify`s every method return value, which
 * strips class identity (e.g. an `effect/ai` `Response.Usage` instance
 * becomes a plain struct on the consumer side). With
 * `RpcDurableObjectNamespace`, both ends go through the same
 * `RpcSerialization` codec, so `Schema.decode` reconstructs class
 * instances correctly.
 *
 * @resource
 *
 * @section Defining the rpc group
 * @example DO-scoped rpc schemas
 * The DO instance *is* the session, so the group payloads typically
 * don't include any per-session identifier — only the per-call inputs.
 * ```typescript
 * import * as Schema from "effect/Schema";
 * import { Rpc, RpcGroup } from "effect/unstable/rpc";
 *
 * const setTitle = Rpc.make("setTitle", {
 *   success: Schema.Void,
 *   payload: { title: Schema.String },
 * });
 *
 * const getTitle = Rpc.make("getTitle", {
 *   success: Schema.String,
 *   payload: {},
 * });
 *
 * export class CounterRpcs extends RpcGroup.make(setTitle, getTitle) {}
 * ```
 *
 * @section Implementing the Durable Object
 * @example Class form (recommended)
 * Mirrors `Cloudflare.DurableObjectNamespace<Self>()(...)` — same
 * outer/inner Effect pattern. The outer Effect resolves shared deps;
 * the per-instance inner Effect returns the
 * `RpcServer.toHttpEffect(schema)`-piped Effect directly.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
 * import { CounterRpcs } from "./rpcs.ts";
 *
 * export default class Counter extends Cloudflare.RpcDurableObjectNamespace<Counter>()(
 *   "Counter",
 *   { schema: CounterRpcs },
 *   Effect.gen(function* () {
 *     // outer init: shared deps for all instances
 *     return Effect.gen(function* () {
 *       // per-instance init: state + handlers
 *       const state = yield* Cloudflare.DurableObjectState;
 *       const handlers = CounterRpcs.toLayer({
 *         setTitle: ({ title }) => state.storage.put("title", title),
 *         getTitle: () =>
 *           Effect.map(state.storage.get<string>("title"), (t) => t ?? ""),
 *       });
 *       return RpcServer.toHttpEffect(CounterRpcs).pipe(
 *         Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
 *       );
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @section Calling the DO from a Worker
 * @example Typed rpc client at the call site
 * `yield* Counter` resolves to a value whose `getByName(id)` returns
 * a typed `RpcClient<CounterRpcs>`. Each rpc method is a typed
 * Effect/Stream factory — no `RpcClient.make` setup needed.
 * ```typescript
 * import Counter from "./counter.ts";
 *
 * Effect.gen(function* () {
 *   const counters = yield* Counter;
 *   yield* counters.getByName("global").setTitle({ title: "Hello" });
 *   const title = yield* counters.getByName("global").getTitle({});
 *   return title;
 * });
 * ```
 *
 * @section Yielding the surrounding namespace from inside a DO
 * @example `yield* RpcDurableObjectNamespace` inside the DO impl
 * Lets a DO instance refer to its own namespace — e.g. to fan a call
 * out to sibling instances. Mirrors `yield* DurableObjectNamespace`
 * on the regular `DurableObjectNamespace`.
 * ```typescript
 * Effect.gen(function* () {
 *   const self = yield* Cloudflare.RpcDurableObjectNamespace;
 *   yield* self.getByName("peer-1").setTitle({ title: "Sibling call" });
 * });
 * ```
 */
export const RpcDurableObjectNamespace: RpcDurableObjectNamespaceClass =
  taggedFunction(RpcDurableObjectNamespaceScope, (...args: any[]) => {
    // Class-form: zero args returns the `(name, props, impl) => …` builder.
    if (args.length === 0) {
      return (
        name: string,
        props: { readonly schema: RpcGroup.RpcGroup<any> },
        impl: Effect.Effect<Effect.Effect<any>>,
      ) => build(name, props, impl);
    }
    // Descriptor-only form: `(name, { schema })` — no impl.
    if (args.length === 2) {
      const [name, props] = args as [
        string,
        {
          readonly schema: RpcGroup.RpcGroup<any>;
        } & Partial<DurableObjectNamespaceProps>,
      ];
      return {
        kind: "Cloudflare.DurableObjectNamespace" as const,
        name,
        className: props?.className,
      } satisfies DurableObjectNamespaceLike<any>;
    }
    // Bare form: `(name, { schema }, impl)`.
    const [name, props, impl] = args as [
      string,
      { readonly schema: RpcGroup.RpcGroup<any> },
      Effect.Effect<Effect.Effect<any>>,
    ];
    return build(name, props, impl);
  }) as any;

const build = (
  name: string,
  props: { readonly schema: RpcGroup.RpcGroup<any> },
  impl: Effect.Effect<Effect.Effect<any>>,
) => {
  // 1. Wrap the user's HttpEffect-returning inner Effect into the
  //    `{ fetch }` shape the underlying `DurableObjectNamespace`
  //    expects. The user constructs `RpcServer.toHttpEffect(schema).pipe(
  //    Effect.provide(handlers), Effect.provide(layerNdjson))` themselves;
  //    we just map it to `{ fetch }`.
  const wrappedImpl = impl.pipe(
    Effect.map((inner) =>
      inner.pipe(Effect.map((fetch: HttpEffect<any>) => ({ fetch }))),
    ),
  ) as Effect.Effect<Effect.Effect<any>>;

  // 2. Delegate to the underlying `DurableObjectNamespace`. It returns
  //    an `effectClass` (Effect + iterable constructor) that registers
  //    binding metadata and produces the alchemy namespace proxy when
  //    yielded.
  const underlying = (DurableObjectNamespace as any)()(name, wrappedImpl);

  // Unwrap to a plain Effect so we can `.pipe(Effect.flatMap(...))`
  // safely (effect-classes are not first-class Effect values).
  const underlyingEff: Effect.Effect<
    DurableObjectNamespaceType<any>,
    never,
    any
  > = (underlying as { asEffect(): Effect.Effect<any, never, any> }).asEffect();

  // 3. Layer `bindEffectRpc(rawNs, schema)` so consumers see the
  //    rpc-bound view at the call site.
  const rpcBound = underlyingEff.pipe(
    Effect.map((rawNs) => {
      const rpcView = bindEffectRpc(rawNs as any, props.schema);
      return Object.assign({}, rawNs, { getByName: rpcView.getByName });
    }),
  ) as unknown as Effect.Effect<RpcDurableObjectNamespace<any>>;

  return effectClass(rpcBound);
};
