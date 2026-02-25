import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Lambda from "../Lambda/index.ts";
import * as SQS from "../SQS/index.ts";
import type { S3EventType } from "./S3Event.ts";
import type * as S3 from "./index.ts";

export const BucketEventSource = Binding.fn<BucketEventSourceBinding>(
  "AWS.S3.BindEventSource",
);

export class BucketEventSourceBinding extends Binding.Service(
  "AWS.S3.BindEventSource",
  Effect.fn(function* (
    bucket: S3.Bucket,
    {
      queue,
      events: Events = ["s3:ObjectCreated:*"],
    }: {
      queue?: SQS.Queue;
      events?: S3EventType[];
    } = {},
  ) {
    const ctx = yield* ExecutionContext;

    if (Lambda.isFunction(ctx)) {
      yield* Lambda.Permission("Permission", {
        action: "lambda.InvokeFunction",
        functionName: yield* ctx.functionName,
        principal: "s3.amazonaws.com",
        sourceArn: yield* bucket.bucketArn,
      });
      yield* bucket.bind({
        notificationConfiguration: {
          LambdaFunctionConfigurations: [
            {
              LambdaFunctionArn: yield* ctx.functionArn,
              Events,
            },
          ],
        },
      });
    } else if (queue) {
      const q = queue ?? (yield* SQS.Queue(`${bucket.id}-BucketEvents`));
      yield* q.bind({
        policyStatements: [
          {
            Sid: `AllowS3EventsFrom${bucket.id}`,
            Effect: "Allow",
            Action: ["sqs:SendMessage"],
            Resource: [yield* q.queueArn],
            Condition: {
              ArnEquals: {
                "aws:SourceArn": yield* bucket.bucketArn,
              },
            },
          },
        ],
      });
      yield* bucket.bind({
        notificationConfiguration: {
          QueueConfigurations: [
            {
              QueueArn: yield* q.queueArn,
              Events,
            },
          ],
        },
      });
      return q;
    } else {
      return yield* Effect.die(
        `S3 Notifications are not supported in runtime '${ctx.type}'`,
      );
    }
  }),
) {}
