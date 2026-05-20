import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import { NodeServices } from "@effect/platform-node";
import type * as lambda from "aws-lambda";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/unstable/http";
import { ExecutionContext } from "../../ExecutionContext.ts";
import { makeEntrypointLayer } from "../../Runtime.ts";
import { Self } from "../../Self.ts";
import { Stack } from "../../Stack.ts";
import { HandlerContext } from "./Function.ts";
import type { FunctionRuntimeContext } from "./FunctionRuntimeContext.ts";

/**
 * Resolve the user's entrypoint into the dispatch handler plus the
 * deploy-init `globalContext` Layer that wires up Stack, AWS Credentials /
 * Region, the Effect platform, and the env-backed `ConfigProvider`.
 *
 * Mirrors the Cloudflare `getWorkerExport` shape so both runtimes share the
 * same convention.
 */
export const getFunctionExport = ({
  entrypoint,
  stack,
}: {
  entrypoint: any;
  stack: { name: string; stage: string };
}) => {
  const tag = Self as any as Context.Service<
    never,
    { RuntimeContext: FunctionRuntimeContext }
  >;

  const exported = tag.pipe(
    Effect.flatMap((func) => func.RuntimeContext.exports!),
    Effect.flatMap((exports) =>
      Effect.isEffect(exports.handler)
        ? exports.handler
        : Effect.succeed(exports.handler),
    ),
  ) as Effect.Effect<
    (
      input: any,
      context: lambda.Context,
    ) => readonly [Effect.Effect<any, any, any>, Context.Context<never>]
  >;

  const layer = makeEntrypointLayer(tag, entrypoint);

  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    // TODO(sam): wire this up to telemetry more directly
    Logger.layer([Logger.consolePretty()]),
  );

  const globalContext = layer.pipe(
    Layer.provideMerge(
      Layer.succeed(Stack, {
        name: stack.name,
        stage: stack.stage,
        bindings: {},
        resources: {},
        actions: {},
      }),
    ),
    Layer.provideMerge(Credentials.fromEnv()),
    Layer.provideMerge(Region.fromEnv()),
    Layer.provideMerge(platform),
    Layer.provideMerge(
      Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
    ),
    Layer.provideMerge(
      Layer.succeed(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info"),
    ),
  );

  return { globalContext, exported };
};

/**
 * Build the Lambda async handler that bridges Effect-Native function exports
 * to the AWS Lambda runtime contract.
 *
 * Each invocation gets a fresh `Scope` and per-invocation services
 * (`HandlerContext`, `ExecutionContext`); the user effect runs with the
 * captured deploy-init service context plus the `globalContext` Layer.
 * The scope is closed before the promise resolves so subscriptions /
 * finalizers torn down before AWS freezes the container.
 */
export const makeFunctionBridge = ({
  entrypoint,
  stack,
}: {
  entrypoint: any;
  stack: { name: string; stage: string };
}) => {
  const { globalContext, exported } = getFunctionExport({ entrypoint, stack });

  return async (event: any, context: lambda.Context): Promise<any> => {
    const scope = Scope.makeUnsafe();
    const exit = await exported
      .pipe(
        Effect.map((dispatch) => dispatch(event, context)),
        Effect.flatMap(([eff, services]) =>
          Effect.provide(
            eff,
            pipe(
              Layer.succeedContext(services),
              Layer.provideMerge(Layer.succeed(HandlerContext, context)),
              Layer.provideMerge(
                Layer.succeed(ExecutionContext, { scope, cache: {} }),
              ),
            ),
          ),
        ),
        Effect.provide(
          Layer.provideMerge(globalContext, Layer.succeed(Scope.Scope, scope)),
        ),
        Effect.runPromiseExit,
      )
      .finally(() => Effect.runPromise(Scope.close(scope, Exit.void)));

    if (exit._tag === "Success") {
      return exit.value;
    }
    throw Cause.squash(exit.cause);
  };
};
