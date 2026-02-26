import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

export class ExecutionContext extends ServiceMap.Service<
  ExecutionContext,
  FunctionExecutionContext | DaemonExecutionContext
>()("Alchemy::ExecutionContext") {}

interface BaseExecutionContext<Type extends string> {
  type: Type;
  /**
   * Get a value from the Runtime
   */
  get<T>(key: string): Effect.Effect<T>;
}

export interface FunctionExecutionContext<
  Type extends string = string,
> extends BaseExecutionContext<Type> {
  listen<A, Req = never>(
    handler: (event: any) => Effect.Effect<A, never, Req> | void,
  ): Effect.Effect<A, never, Req>;
  listen<A, Req = never, InitReq = never>(
    effect: Effect.Effect<
      (event: any) => Effect.Effect<A, never, Req> | void,
      never,
      InitReq
    >,
  ): Effect.Effect<A, never, Req | InitReq>;
  run?: never;
}

export interface DaemonExecutionContext<
  Type extends string = string,
> extends BaseExecutionContext<Type> {
  listen?: never;
  run: <Req = never, RunReq = never>(
    effect: Effect.Effect<void, never, RunReq>,
  ) => Effect.Effect<void, never, Req | RunReq>;
}
