import type * as lambda from "aws-lambda";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Output from "../../Output.ts";
import type * as Serverless from "../../Serverless/index.ts";
import { FunctionTypeId } from "./Function.ts";
import { makeFunctionHttpHandler } from "./HttpServer.ts";

export interface FunctionRuntimeContext extends Serverless.FunctionContext {}

export const makeFunctionRuntimeContext = (
  id: string,
): FunctionRuntimeContext => {
  const listeners: Effect.Effect<Serverless.FunctionListener>[] = [];
  const env: Record<string, any> = {};

  const ctx: FunctionRuntimeContext = {
    Type: FunctionTypeId,
    id,
    env,
    set: (id: string, output: Output.Output) =>
      Effect.sync(() => {
        const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
        // Preserve `Redacted`-ness across the Output → Lambda env var
        // round-trip. `JSON.stringify(Redacted)` would emit the literal
        // string `"<redacted>"` and lose the value, so secrets are
        // serialized with a `{_tag: "Redacted", value: ...}` marker that
        // the runtime `get` path detects and rebuilds.
        env[key] = output.pipe(
          Output.map((value) =>
            Redacted.isRedacted(value)
              ? JSON.stringify({
                  _tag: "Redacted",
                  value: Redacted.value(value),
                })
              : JSON.stringify(value),
          ),
        );
        return key;
      }),
    get: <T>(key: string) =>
      Config.string(key).pipe(
        Effect.flatMap((val) =>
          Effect.try({
            try: () => {
              const value = JSON.parse(val);
              if (
                value !== null &&
                typeof value === "object" &&
                (value as { _tag?: unknown })._tag === "Redacted" &&
                "value" in (value as object)
              ) {
                return Redacted.make(
                  (value as { value: unknown }).value,
                ) as unknown as T;
              }
              return value as T;
            },
            catch: () => val,
          }),
        ),
        Effect.catch((cause) =>
          Effect.die(
            new Error(`Failed to get environment variable: ${key}`, { cause }),
          ),
        ),
      ),
    serve: (handler) => ctx.listen(makeFunctionHttpHandler(handler)),
    listen: ((
      handler:
        | Serverless.FunctionListener
        | Effect.Effect<Serverless.FunctionListener>,
    ) =>
      Effect.sync(() =>
        Effect.isEffect(handler)
          ? listeners.push(handler)
          : listeners.push(Effect.succeed(handler)),
      )) as any as Serverless.FunctionContext["listen"],
    exports: Effect.gen(function* () {
      const handlers = yield* Effect.all(listeners, {
        concurrency: "unbounded",
      });
      const services = yield* Effect.context();

      // Dispatcher for a single Lambda invocation. Walks the registered
      // listeners until one matches the event shape, then returns the
      // resulting Effect paired with the deploy-init service context so the
      // bridge can re-provide those services per invocation (linearized
      // request scope).
      const dispatch = (
        input: any,
        _context: lambda.Context,
      ): readonly [Effect.Effect<any, any, any>, Context.Context<never>] => {
        for (const handler of handlers) {
          const eff = handler(input);
          if (Effect.isEffect(eff)) {
            return [eff as Effect.Effect<any, any, any>, services];
          }
        }
        return [Effect.die(new Error("No event handler found")), services];
      };

      return {
        handler: dispatch,
      };
    }),
  };
  return ctx;
};
