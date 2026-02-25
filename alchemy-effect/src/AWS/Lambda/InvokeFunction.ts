import * as Lambda from "distilled-aws/lambda";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import type { Function } from "./Function.ts";
import * as LambdaModule from "./index.ts";

export interface InvokeRequest extends Omit<
  Lambda.InvocationRequest,
  "FunctionName"
> {}

export const InvokeFunction = Effect.fn(function* <F extends Function>(
  func: F,
) {
  yield* bindInvokeFunction(func);
  const FunctionArn = yield* func.functionArn;
  return yield* AWS.withContext(
    Effect.fn(function* (request?: InvokeRequest) {
      return yield* Lambda.invoke({
        ...request,
        FunctionName: yield* FunctionArn,
      });
    }),
  );
});

export const bindInvokeFunction = Binding.fn<InvokeFunctionBinding>(
  "AWS.Lambda.InvokeFunction",
);

export class InvokeFunctionBinding extends Binding.Service(
  "AWS.Lambda.InvokeFunction",
  Effect.fn(function* <F extends Function>(func: F) {
    const ctx = yield* ExecutionContext;
    if (LambdaModule.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "InvokeFunction",
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: [Output.interpolate`${func.functionArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `InvokeFunctionBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
