import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { serializeConfig } from "./config.serialize";
import type { Config } from "./config.types";

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()(
  "RuntimeError",
  {
    message: Schema.String,
    stderr: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ControlMessage = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("listen"),
    socket: Schema.String,
    port: Schema.Number,
  }),
  Schema.Struct({
    event: Schema.Literal("listen-inspector"),
    port: Schema.Number,
  }),
]);
export type ControlMessage = typeof ControlMessage.Type;

export class Runtime extends ServiceMap.Service<
  Runtime,
  {
    readonly compatibilityDate: string;
    readonly serve: (
      config: Config,
      args?: Record<string, string | number | boolean>,
    ) => Effect.Effect<Array<ControlMessage>, RuntimeError, Scope.Scope>;
  }
>()("Runtime") {}

export const RuntimeLive = Layer.effect(
  Runtime,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const workerd = yield* Effect.promise(
      async (): Promise<{
        bin: string;
        compatibilityDate: string;
        version: string;
      }> => {
        const pkg = await import("workerd");
        const bin =
          typeof pkg.default === "string"
            ? (pkg.default as string)
            : (pkg.default as { default: string }).default;
        return {
          bin,
          compatibilityDate: pkg.compatibilityDate,
          version: pkg.version,
        };
      },
    );

    const readStderr = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
      stream.pipe(
        Stream.run(
          Sink.fold(
            () => "",
            () => true,
            (acc, data) => Effect.succeed(acc + data.toString()),
          ),
        ),
        Effect.mapError(
          (error) =>
            new RuntimeError({
              message: "Failed to read stderr",
              cause: error,
            }),
        ),
      );

    const readControlMessages = (
      stream: Stream.Stream<Uint8Array, PlatformError>,
      count: number,
    ) =>
      stream.pipe(
        Stream.run(
          Sink.fold(
            () => [] as Array<ControlMessage>,
            (acc) => acc.length < count,
            (acc, data) =>
              Effect.succeed(
                acc.concat(
                  data
                    .toString()
                    .split("\n")
                    .filter((line) => line.trim() !== "")
                    .map((line) =>
                      Schema.decodeSync(ControlMessage)(JSON.parse(line)),
                    ),
                ),
              ),
          ),
        ),
        Effect.mapError(
          (error) =>
            new RuntimeError({
              message: "Failed to read control messages",
              cause: error,
            }),
        ),
      );

    return Runtime.of({
      compatibilityDate: workerd.compatibilityDate,
      serve: Effect.fn("Runtime.serve")((config, args) =>
        Effect.gen(function* () {
          const command = ChildProcess.make(
            workerd.bin,
            [
              "serve",
              "--binary",
              "--experimental",
              "--verbose",
              "--control-fd=3",
              ...Object.entries(args ?? {}).map(([key, value]) =>
                typeof value === "boolean" ? `--${key}` : `--${key}=${value}`,
              ),
              "-",
            ],
            {
              stdin: Stream.succeed(new Uint8Array(serializeConfig(config))),
              stdout: "inherit",
              stderr: "pipe",
              additionalFds: { fd3: { type: "output" } },
            },
          );
          const process = yield* spawner.spawn(command).pipe(
            Effect.mapError(
              (error) =>
                new RuntimeError({
                  message: "The workerd process failed to start",
                  cause: error,
                }),
            ),
          );
          const count =
            (config.sockets?.length ?? 0) +
            (typeof args?.["debug-port"] !== "undefined" ? 1 : 0) +
            (typeof args?.["inspector-addr"] !== "undefined" ? 1 : 0);
          const controlMessages = yield* readControlMessages(
            process.getOutputFd(3),
            count,
          );
          if (controlMessages.length !== count) {
            const stderr = yield* readStderr(process.stderr);
            return yield* new RuntimeError({
              message: "The workerd process failed to start",
              stderr,
            });
          }
          return controlMessages;
        }),
      ),
    });
  }),
);
