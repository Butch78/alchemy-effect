import * as SQS from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";

import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Queue } from "./Queue.ts";

export const sink = Effect.fn(function* <Q extends Queue>(queue: Q) {
  yield* Binding.fn<QueueSink>("AWS.SQS.QueueSink")(queue);
  const QueueUrl = yield* queue.queueUrl;
  const Context = yield* AWS.context();
  return Sink.forEachArray((messages: readonly string[]) =>
    Effect.gen(function* () {
      yield* SQS.sendMessageBatch({
        QueueUrl: yield* QueueUrl,
        Entries: messages.map((message, i) => ({
          Id: `${i}`,
          MessageBody: message,
        })),
      });
      // TODO(sam): handle errors, re-drive failed messages
    }).pipe(Effect.provide(Context), Effect.orDie),
  );
});

export class QueueSink extends Binding.Service(
  "AWS.SQS.QueueSink",
  Effect.fn(function* (queue: Queue) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "QueueSink",
            Effect: "Allow",
            Action: ["sqs:SendMessageBatch"],
            Resource: [Output.interpolate`${queue.queueArn}`],
          },
        ],
      });
    }
    return yield* Effect.die(
      `QueueSinkBinding does not support runtime '${ctx.type}'`,
    );
  }),
) {}
