import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface HeadObjectRequest extends Omit<
  S3.HeadObjectRequest,
  "Bucket"
> {}

export const HeadObject = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindHeadObject(bucket);
  const BucketName = yield* bucket.bucketName;
  return yield* AWS.withContext(
    Effect.fn(function* (request: HeadObjectRequest) {
      return yield* S3.headObject({
        ...request,
        Bucket: yield* BucketName,
      });
    }),
  );
});

export const bindHeadObject =
  Binding.fn<HeadObjectBinding>("AWS.S3.HeadObject");

export class HeadObjectBinding extends Binding.Service(
  "AWS.S3.HeadObject",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "HeadObject",
            Effect: "Allow",
            Action: ["s3:GetObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `HeadObjectBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
