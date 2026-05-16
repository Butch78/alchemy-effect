import * as Cloudflare from "alchemy/Cloudflare";
import { Layer } from "effect";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import ChatAgent from "./Agent.ts";
import { ChatRpcs, InternalError } from "./Api.ts";

const toInternalError =
  (label: string) =>
  <A, R>(
    effect: Effect.Effect<A, unknown, R>,
  ): Effect.Effect<A, InternalError, R> =>
    Effect.catchCause(effect, (cause) =>
      Effect.logError(`${label} failed`, cause).pipe(
        Effect.andThen(
          Effect.fail(new InternalError({ message: Cause.pretty(cause) })),
        ),
      ),
    );

const streamToInternalError =
  (label: string) =>
  <A, R>(
    stream: Stream.Stream<A, unknown, R>,
  ): Stream.Stream<A, InternalError, R> =>
    stream.pipe(
      Stream.catchCause((cause) =>
        Effect.logError(`${label} stream failed`, cause).pipe(
          Effect.andThen(
            Effect.fail(new InternalError({ message: Cause.pretty(cause) })),
          ),
          Stream.fromEffect,
        ),
      ),
    );

/**
 * Backend Worker for the chat bot SPA. `RpcWorker` takes the `ChatRpcs`
 * schema and an init Effect that returns the already-piped
 * `RpcServer.toHttpEffect(...)`; the wrapper just exposes it on the
 * worker's `fetch`.
 *
 * Each per-session call is forwarded to the matching
 * `ChatAgent.getByName(id)` rpc procedure (typed by `RpcDurableObjectNamespace`),
 * so values round-trip through one `Schema` codec end-to-end —
 * `Schema.Class` identity preserved.
 */
export default class Worker extends Cloudflare.RpcWorker<Worker>()(
  "Worker",
  { main: import.meta.filename, schema: ChatRpcs },
  Effect.gen(function* () {
    const chatAgents = yield* ChatAgent;

    const chatRpc = ChatRpcs.toLayer({
      sendChat: ({ id, threadId, prompt, model }) =>
        chatAgents.getByName(id).pipe(
          Effect.map((agent) => agent.sendChat({ threadId, prompt, model })),
          Stream.unwrap,
          streamToInternalError("sendChat"),
        ),
      getMessages: ({ id, threadId }) =>
        chatAgents.getByName(id).pipe(
          Effect.flatMap((agent) => agent.getMessages({ threadId })),
          toInternalError("getMessages"),
        ),
      resetThread: ({ id, threadId }) =>
        chatAgents.getByName(id).pipe(
          Effect.flatMap((agent) => agent.resetThread({ threadId })),
          toInternalError("resetThread"),
        ),
    });

    return RpcServer.toHttpEffect(ChatRpcs).pipe(
      Effect.provide(Layer.mergeAll(chatRpc, RpcSerialization.layerNdjson)),
    );
  }).pipe(Effect.provide(Cloudflare.AiGatewayBindingLive)),
) {}
