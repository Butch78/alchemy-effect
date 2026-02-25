import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Pipeable } from "effect/Pipeable";
import type { AnyClass } from "../Schema.ts";
import type { Instance } from "../Util/instance.ts";

export type AnyOperation = Operation<string, any, any, any>;

// TODO(sam): rename to Operation?
export interface Operation<
  Name extends string = string,
  Input extends AnyClass = AnyClass,
  Output extends AnyClass = AnyClass,
  Err extends AnyClass = never,
> extends Pipeable {
  type: "route";
  name: Name;
  input: Input;
  output: Output;
  errors: Err[];
  new (): Operation<Name, Input, Output, Err>;
  layer<Self, E = never, Req = never>(
    this: Self,
    eff: Effect.Effect<
      (
        input: Instance<Input>,
      ) => Effect.Effect<Instance<Output>, Instance<Err>>,
      E,
      Req
    >,
  ): Layer.Layer<Instance<Self>, E, Req>;
}

export interface OperationProps<
  Input extends AnyClass,
  Output extends AnyClass,
  Err extends AnyClass,
> {
  input: Input;
  output: Output;
  errors: Err[];
}

export declare const Operation: <
  Name extends string,
  Input extends AnyClass,
  Output extends AnyClass,
  Err extends AnyClass = never,
>(
  name: Name,
  props: OperationProps<Input, Output, Err>,
) => Operation<Name, Input, Output, Err>;
