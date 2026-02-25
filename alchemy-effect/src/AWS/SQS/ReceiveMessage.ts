import * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export interface ReceiveMessageRequest extends Omit<
  sqs.ReceiveMessageRequest,
  "QueueUrl"
> {}

export const ReceiveMessage = Effect.fn(function* <Q extends Queue>(queue: Q) {
  const QueueUrl = yield* queue.queueUrl;
  return yield* AWS.withContext(
    Effect.fn(function* (request: ReceiveMessageRequest = {}) {
      return yield* sqs.receiveMessage({
        ...request,
        QueueUrl: yield* QueueUrl,
      });
    }),
  );
});

export const bindReceiveMessage = Binding.fn<ReceiveMessageBinding>(
  "AWS.SQS.ReceiveMessage",
);

export class ReceiveMessageBinding extends Binding.Service(
  "AWS.SQS.ReceiveMessage",
  Effect.fn(function* <Q extends Queue>(queue: Q) {
    const platform = yield* ExecutionContext;
    if (Lambda.isFunction(platform)) {
      yield* platform.bind({
        policyStatements: [
          {
            Sid: "ReceiveMessage",
            Effect: "Allow",
            Action: ["sqs:ReceiveMessage"],
            Resource: [Output.interpolate`${queue.queueArn}`],
          },
        ],
      });
    }
  }),
) {}
