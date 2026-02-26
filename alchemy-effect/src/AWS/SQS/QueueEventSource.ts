//
import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import type { MessagesProps, SQSRecord } from "./Messages.ts";
import type { Queue } from "./Queue.ts";

export class QueueEventSource extends ServiceMap.Service<
  QueueEventSource,
  QueueEventSourceService
>()("AWS.SQS.QueueEventSource") {}

export interface QueueEventSourceProps {
  /**
   * The maximum number of records in each batch that Lambda pulls from the queue.
   * @default 10
   */
  batchSize?: number;
  /**
   * The maximum amount of time, in seconds, that Lambda spends gathering records before invoking the function.
   * @default 0
   */
  maximumBatchingWindowInSeconds?: number;
}

export type QueueEventSourceService = <Req = never>(
  bucket: Queue,
  props: MessagesProps,
  process: (
    stream: Stream.Stream<SQSRecord>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;
