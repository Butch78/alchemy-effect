import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Stream } from "./Stream.ts";

/**
 * The runtime shape of a Pipelines `pipelines` binding (Cloudflare exposes
 * `env.X.send(records)` where each record is a JSON-serializable value).
 */
export interface PipelinesSendBinding {
  send(records: ReadonlyArray<unknown>): Promise<void>;
}

/** Raised when `env.X.send(records)` rejects at runtime. */
export class StreamSendError extends Data.TaggedError("StreamSendError")<{
  message: string;
  cause: unknown;
}> {}

/**
 * Runtime client returned by `Stream.bind(stream)`. Schema-typed when the
 * underlying stream was defined with an `effect/Schema` struct; falls back
 * to `unknown` when the schema is opaque.
 */
export interface StreamSender<Record = unknown> {
  /** The raw Cloudflare `pipelines` binding from `env`. */
  raw: Effect.Effect<PipelinesSendBinding, never, RuntimeContext>;
  /** Send one record. */
  send(record: Record): Effect.Effect<void, StreamSendError, RuntimeContext>;
  /** Send a batch of records. */
  sendBatch(
    records: ReadonlyArray<Record>,
  ): Effect.Effect<void, StreamSendError, RuntimeContext>;
}

/**
 * Runtime binding service for {@link Stream}. Resolves the native Cloudflare
 * `pipelines` binding from the Worker's `env` and wraps it with `send` /
 * `sendBatch` Effect callables.
 *
 * Not part of the public surface — callers reach this via `Stream.bind(stream)`,
 * which the {@link Stream} resource wires through `Resource(...)({ bind })`.
 */
export class StreamBinding extends Binding.Service<
  StreamBinding,
  (stream: Stream) => Effect.Effect<StreamSender>
>()("Cloudflare.PipelinesStream") {}

/**
 * Runtime layer for {@link StreamBinding}. Provide this in your Worker's
 * runtime layer so `Stream.bind(stream)` resolves at request time.
 */
export const StreamBindingLive = Layer.effect(
  StreamBinding,
  Effect.gen(function* () {
    const bind = yield* StreamBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (stream: Stream) {
      yield* bind(stream);
      const raw = Effect.sync(
        () => (env as Record<string, PipelinesSendBinding>)[stream.LogicalId]!,
      );

      const tryPromise = (fn: () => Promise<void>) =>
        Effect.tryPromise({
          try: fn,
          catch: (error: any) =>
            new StreamSendError({
              message: error?.message ?? "Unknown error sending to stream",
              cause: error,
            }),
        });

      return {
        raw,
        send: (record: unknown) =>
          raw.pipe(Effect.flatMap((b) => tryPromise(() => b.send([record])))),
        sendBatch: (records: ReadonlyArray<unknown>) =>
          raw.pipe(
            Effect.flatMap((b) =>
              tryPromise(() => b.send(records as ReadonlyArray<unknown>)),
            ),
          ),
      } satisfies StreamSender as StreamSender;
    });
  }),
);

/**
 * Deploy-time policy that records the native `pipelines` binding on the host
 * Worker. The `pipeline` field carries the Cloudflare-side **stream id**
 * (per Cloudflare's `pipelines` binding contract).
 */
export class StreamBindingPolicy extends Binding.Policy<
  StreamBindingPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("Cloudflare.PipelinesStream") {}

export const StreamBindingPolicyLive = StreamBindingPolicy.layer.succeed(
  Effect.fnUntraced(function* (host: ResourceLike, stream: Stream) {
    if (isWorker(host)) {
      yield* host.bind`${stream}`({
        bindings: [
          {
            type: "pipelines",
            name: stream.LogicalId,
            pipeline: stream.streamId,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(
          `StreamBindingPolicy does not support runtime '${host.Type}'`,
        ),
      );
    }
  }),
);
