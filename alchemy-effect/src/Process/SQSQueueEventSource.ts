import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SQS from "../AWS/SQS/index.ts";
import { ProcessRuntime } from "./Runtime.ts";

export const isSQSEvent = (event: any): event is lambda.SQSEvent =>
  Array.isArray(event?.Records) &&
  event.Records.length > 0 &&
  event.Records[0].eventSource === "aws:sqs";

export const SQSQueueEventSource = Layer.effect(
  SQS.QueueEventSource,
  Effect.gen(function* () {
    const ctx = yield* ProcessRuntime;
    const Policy = yield* QueueEventSourcePolicy;
    const ReceiveMessage = yield* SQS.ReceiveMessage;
    const DeleteMessageBatch = yield* SQS.DeleteMessageBatch;

    return Effect.fn(function* <StreamReq = never, Req = never>(
      queue: SQS.Queue,
      props: SQS.QueueEventSourceProps,
      process: (
        stream: Stream.Stream<SQS.SQSRecord, never, StreamReq>,
      ) => Effect.Effect<void, never, Req | StreamReq>,
    ) {
      yield* Policy(queue, props);

      const QueueArn = yield* queue.queueArn;

      const receiveMessage = yield* ReceiveMessage(queue);
      const deleteMessageBatch = yield* DeleteMessageBatch(queue);

      yield* ctx.run(
        Effect.forever(
          Effect.gen(function* () {
            const queueArn = yield* QueueArn;
            const result = yield* receiveMessage({
              MaxNumberOfMessages: props.maxNumberOfMessages ?? 10,
              WaitTimeSeconds: props.waitTimeSeconds ?? 20,
            });

            const messages = result.Messages ?? [];
            if (messages.length === 0) return;

            const records = messages.map((msg) => toSQSRecord(msg, queueArn));

            yield* process(Stream.fromArray(records)).pipe(Effect.orDie);

            // TODO(sam): only delete messages that were successfully processed
            yield* deleteMessageBatch({
              Entries: messages.map((msg, i) => ({
                Id: msg.MessageId ?? String(i),
                ReceiptHandle: msg.ReceiptHandle!,
              })),
            });
          }),
        ).pipe(Effect.orDie),
      );
    }) as SQS.QueueEventSourceService;
  }),
);
