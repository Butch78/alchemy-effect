import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface SendMessageBatchRequest extends Omit<
  sqs.SendMessageBatchRequest,
  "QueueUrl"
> {}

export const SendMessageBatch = Effect.fn(function* <Q extends Queue>(
  queue: Q,
) {
  yield* bindSendMessageBatch(queue);
  const QueueUrl = yield* queue.queueUrl;
  return yield* AWS.withContext(
    Effect.fn(function* (request: SendMessageBatchRequest) {
      return yield* sqs.sendMessageBatch({
        ...request,
        QueueUrl: yield* QueueUrl,
      });
    }),
  );
});

export const bindSendMessageBatch = Binding.fn<SendMessageBatchBinding>(
  "AWS.SQS.SendMessageBatch",
);

export class SendMessageBatchBinding extends Binding.Service(
  "AWS.SQS.SendMessageBatch",
  Effect.fn(function* <Q extends Queue>(queue: Q) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "SendMessageBatch",
            Effect: "Allow",
            Action: ["sqs:SendMessage"],
            Resource: [Output.interpolate`${queue.queueArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `SendMessageBatchBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
