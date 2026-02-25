import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface DeleteMessageRequest extends Omit<
  sqs.DeleteMessageRequest,
  "QueueUrl"
> {}

export const DeleteMessage = Effect.fn(function* <Q extends Queue>(queue: Q) {
  yield* bindDeleteMessage(queue);
  const QueueUrl = yield* queue.queueUrl;
  return yield* AWS.withContext(
    Effect.fn(function* (request: DeleteMessageRequest) {
      return yield* sqs.deleteMessage({
        ...request,
        QueueUrl: yield* QueueUrl,
      });
    }),
  );
});

export const bindDeleteMessage = Binding.fn<DeleteMessageBinding>(
  "AWS.SQS.DeleteMessage",
);

export class DeleteMessageBinding extends Binding.Service(
  "AWS.SQS.DeleteMessage",
  Effect.fn(function* <Q extends Queue>(queue: Q) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "DeleteMessage",
            Effect: "Allow",
            Action: ["sqs:DeleteMessage"],
            Resource: [Output.interpolate`${queue.queueArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `DeleteMessageBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
