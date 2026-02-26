import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface DeleteMessageBatchRequest extends Omit<
  sqs.DeleteMessageBatchRequest,
  "QueueUrl"
> {}

export class DeleteMessageBatch extends Binding.Service<
  DeleteMessageBatch,
  (
    queue: Queue,
  ) => Effect.Effect<
    (request: DeleteMessageBatchRequest) => Effect.Effect<any, any, any>
  >
>()("AWS.SQS.DeleteMessageBatch") {}

export const DeleteMessageBatchLive = Layer.effect(
  DeleteMessageBatch,
  // @ts-expect-error
  Effect.gen(function* () {
    const Policy = yield* DeleteMessageBatchPolicy;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      yield* Policy(queue);
      return Effect.fn(function* (request: DeleteMessageBatchRequest) {
        return yield* sqs.deleteMessageBatch({
          ...request,
          QueueUrl: yield* QueueUrl,
        });
      });
    });
  }),
);

export class DeleteMessageBatchPolicy extends Binding.Policy<
  DeleteMessageBatchPolicy,
  (queue: Queue) => Effect.Effect<void>
>()("AWS.SQS.DeleteMessageBatch") {}

export const DeleteMessageBatchPolicyLive = Layer.effect(
  DeleteMessageBatchPolicy,
  Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    return Effect.fn(function* (queue: Queue) {
      if (Lambda.isFunction(ctx)) {
        return yield* ctx.bind({
          policyStatements: [
            {
              Sid: "DeleteMessageBatch",
              Effect: "Allow",
              Action: ["sqs:DeleteMessage"],
              Resource: [Output.interpolate`${queue.queueArn}`],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `DeleteMessageBatchPolicy does not support runtime '${ctx.type}'`,
        );
      }
    });
  }),
);
