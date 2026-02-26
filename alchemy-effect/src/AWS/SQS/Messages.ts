import type * as lambda from "aws-lambda";
import type * as sqs from "distilled-aws/sqs";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { DeleteMessageBatch } from "./DeleteMessageBatch.ts";
import type { Queue } from "./Queue.ts";
import {
  QueueEventSource,
  type QueueEventSourceProps,
} from "./QueueEventSource.ts";
import { ReceiveMessage } from "./ReceiveMessage.ts";

export type SQSRecord = lambda.SQSRecord;

export interface MessagesProps extends QueueEventSourceProps {
  /**
   * Time in seconds for long polling when using the process (run) path.
   * @default 20
   */
  waitTimeSeconds?: number;
  /**
   * Maximum number of messages to receive per poll when using the process (run) path.
   * @default 10
   */
  maxNumberOfMessages?: number;
}

const isSQSEvent = (event: any): event is lambda.SQSEvent =>
  Array.isArray(event?.Records) &&
  event.Records.length > 0 &&
  event.Records[0].eventSource === "aws:sqs";

export const messages = <Q extends Queue>(
  queue: Q,
  props: MessagesProps = {},
) => ({
  subscribe: Effect.fn(function* <Req = never>(
    process: (
      stream: Stream.Stream<SQSRecord>,
    ) => Effect.Effect<void, never, Req>,
  ) {
    yield* (yield* QueueEventSource)(queue, props, process);

    if (ctx.listen) {
      // Function

      yield* ctx.listen(
        Effect.gen(function* () {
          const queueArn = yield* QueueArn;
          return (event: any) => {
            if (isSQSEvent(event)) {
              const records = event.Records.filter(
                (record) =>
                  record.eventSource === "aws:sqs" &&
                  record.eventSourceARN === queueArn,
              );
              if (records.length > 0) {
                // TODO(sam): support feeding back failed records to SQS
                return process(Stream.fromArray(records)).pipe(Effect.orDie);
              }
            }
          };
        }),
      );
    } else {
      // Process
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
    }
  }),
});

function toSQSRecord(
  msg: sqs.Message,
  eventSourceARN: string,
): lambda.SQSRecord {
  return {
    // TODO(sam): empty strings is bad, what should we do?
    messageId: msg.MessageId ?? "",
    receiptHandle: msg.ReceiptHandle ?? "",
    body: msg.Body ?? "",
    attributes: {
      ApproximateReceiveCount: msg.Attributes?.ApproximateReceiveCount ?? "0",
      SentTimestamp: msg.Attributes?.SentTimestamp ?? "0",
      SenderId: msg.Attributes?.SenderId ?? "",
      ApproximateFirstReceiveTimestamp:
        msg.Attributes?.ApproximateFirstReceiveTimestamp ?? "0",
    },
    messageAttributes: {},
    md5OfBody: msg.MD5OfBody ?? "",
    eventSource: "aws:sqs",
    eventSourceARN,
    awsRegion: "",
  };
}
