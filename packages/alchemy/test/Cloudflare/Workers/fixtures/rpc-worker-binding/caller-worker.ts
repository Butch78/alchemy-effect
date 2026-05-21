import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { CallerRpcs } from "./group.ts";
import BindingTargetRpcWorker from "./target-worker.ts";

/**
 * Caller {@link RpcWorker} that uses `Cloudflare.RpcWorker.bind` to
 * obtain a typed `RpcClient` for {@link BindingTargetRpcWorker}. The
 * `ProxyGreet` handler forwards each call through the service-binding
 * client — exercising the RpcWorker-to-RpcWorker pathway.
 */
export default class BindingCallerRpcWorker extends Cloudflare.RpcWorker<BindingCallerRpcWorker>()(
  "BindingCallerRpcWorker",
  { main: import.meta.filename, schema: CallerRpcs },
  Effect.gen(function* () {
    const handlers = CallerRpcs.toLayer({
      ProxyGreet: ({ name }) =>
        Effect.gen(function* () {
          const target = yield* Cloudflare.RpcWorker.bind(
            BindingTargetRpcWorker,
          );
          return yield* target.Greet({ name });
        }).pipe(Effect.orDie),
    });
    return RpcServer.toHttpEffect(CallerRpcs).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
    );
  }),
) {}
