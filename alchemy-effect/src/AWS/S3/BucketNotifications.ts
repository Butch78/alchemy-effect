import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ExecutionContext } from "../../ExecutionContext.ts";
import * as SQS from "../SQS/index.ts";
import type { Bucket } from "./Bucket.ts";
import { BucketEventSource } from "./BucketEventSource.ts";
import type { S3EventType } from "./S3Event.ts";

export type BucketNotification = {
  type: S3EventType;
  bucket: string;
  key: string;
  size: number;
  eTag: string;
};

export const isS3Event = (event: any): event is lambda.S3Event =>
  Array.isArray(event.Records) &&
  event.Records.some((record: any) => record.s3);

export interface NotificationsProps<Events extends S3EventType[]> {
  events?: Events;
}

export const notifications = <
  B extends Bucket,
  const Events extends S3EventType[] = S3EventType[],
>(
  bucket: B,
  props: NotificationsProps<Events> = {},
) => ({
  subscribe: Effect.fn(function* <Req = never, StreamReq = never>(
    process: (
      stream: Stream.Stream<BucketNotification, never, StreamReq>,
    ) => Effect.Effect<void, never, Req>,
  ) {
    // Bind the Bucket's bucketName Output to `this` environment
    const BucketName = yield* bucket.bucketName;

    const ctx = yield* ExecutionContext;

    const parseEvent = (record: lambda.S3EventRecord) => ({
      type: record.eventName as S3EventType,
      bucket: record.s3.bucket.name,
      key: record.s3.object.key,
      size: record.s3.object.size,
      eTag: record.s3.object.eTag,
    });

    if (ctx.listen) {
      yield* BucketEventSource(bucket, {
        events: props.events,
      });

      yield* ctx.listen(
        Effect.gen(function* () {
          const bucketName = yield* BucketName;
          return (event: any) => {
            if (isS3Event(event)) {
              const events = event.Records.filter(
                (record) => record.s3.bucket.name === bucketName,
              );
              if (events.length > 0) {
                return process(Stream.fromArray(events.map(parseEvent))).pipe(
                  Effect.orDie,
                );
              }
            }
          };
        }),
      );
    } else {
      // if we're running outside a Lambda Function, we need to put messages in SQS queue
      // and then consume from it. Lambda can be invoked directly by S3 which is handy.
      const queue = yield* SQS.Queue(`${bucket.id}-BucketEvents`);

      yield* BucketEventSource(bucket, {
        queue,
        events: props.events,
      });

      yield* SQS.messages(queue).subscribe((stream) =>
        stream.pipe(
          Stream.flatMap((record) =>
            Stream.fromArray(
              (JSON.parse(record.body) as lambda.S3Event).Records,
            ),
          ),
          Stream.map(parseEvent),
          process,
        ),
      );
    }
  }),
});
