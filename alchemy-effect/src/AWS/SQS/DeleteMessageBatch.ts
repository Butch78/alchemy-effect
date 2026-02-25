import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface DeleteMessageBatchRequest extends Omit<
  sqs.DeleteMessageBatchRequest,
  "QueueUrl"
> {}

export const DeleteMessageBatch = Effect.fn(function* <Q extends Queue>(
  queue: Q,
) {
  yield* bindDeleteMessageBatch(queue);
  const QueueUrl = yield* queue.queueUrl;
  return yield* AWS.withContext(
    Effect.fn(function* (request: DeleteMessageBatchRequest) {
      return yield* sqs.deleteMessageBatch({
        ...request,
        QueueUrl: yield* QueueUrl,
      });
    }),
  );
});

export const bindDeleteMessageBatch = Binding.fn<DeleteMessageBatchBinding>(
  "AWS.SQS.DeleteMessageBatch",
);

export class DeleteMessageBatchBinding extends Binding.Service(
  "AWS.SQS.DeleteMessageBatch",
  Effect.fn(function* <Q extends Queue>(queue: Q) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
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
        `DeleteMessageBatchBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
