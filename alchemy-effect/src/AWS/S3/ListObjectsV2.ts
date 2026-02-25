import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface ListObjectsV2Request extends Omit<
  S3.ListObjectsV2Request,
  "Bucket"
> {}

export const ListObjectsV2 = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindListObjectsV2(bucket);
  const BucketName = yield* bucket.bucketName;
  return yield* AWS.withContext(
    Effect.fn(function* (request?: ListObjectsV2Request) {
      return yield* S3.listObjectsV2({
        ...request,
        Bucket: yield* BucketName,
      });
    }),
  );
});

export const bindListObjectsV2 = Binding.fn<ListObjectsV2Binding>(
  "AWS.S3.ListObjectsV2",
);

export class ListObjectsV2Binding extends Binding.Service(
  "AWS.S3.ListObjectsV2",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "ListObjectsV2",
            Effect: "Allow",
            Action: ["s3:ListBucket"],
            Resource: [Output.interpolate`${bucket.bucketArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `ListObjectsV2Binding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
