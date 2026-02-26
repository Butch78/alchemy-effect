import * as Lambda from "alchemy-effect/AWS/Lambda";
import * as S3 from "alchemy-effect/AWS/S3";
import * as SQS from "alchemy-effect/AWS/SQS";
import * as Http from "alchemy-effect/Http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { JobHttpEffect } from "./JobHttpApi.ts";
import { JobStorage, jobStorage } from "./JobStorage.ts";

export default Lambda.Function(
  "JobFunction",
  // @ts-expect-error
  Effect.gen(function* () {
    const { bucket, getJob } = yield* JobStorage;

    const queue = yield* SQS.Queue("JobsQueue");

    // Sink
    const sink = yield* SQS.sink(queue);

    // register a HTTP server in the Lambda Function runtime
    yield* Http.serve(yield* JobHttpEffect);
    // if you want to use RPC instead of HttpApi:
    // yield* Http.serve(yield* JobRpcHttpEffect);

    // register a SQS Event Handler in the Lambda Function runtime
    yield* S3.notifications(bucket).subscribe((stream) =>
      stream.pipe(
        Stream.flatMap((item) =>
          Stream.fromEffect(getJob(item.key).pipe(Effect.orDie)),
        ),
        Stream.map((msg) => JSON.stringify(msg)),
        Stream.tapSink(sink),
        Stream.runDrain,
      ),
    );

    // return the Function properties for this stage
    return {
      main: import.meta.filename,
      memory: 1024,
      url: true,
    } as const;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        jobStorage,
        Lambda.BucketEventSource,
        Http.lambdaHttpServer,
      ),
    ),
  ),
);
