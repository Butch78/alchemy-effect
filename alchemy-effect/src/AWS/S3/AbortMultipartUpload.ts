import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface AbortMultipartUploadRequest extends Omit<
  S3.AbortMultipartUploadRequest,
  "Bucket"
> {}

export const AbortMultipartUpload = Effect.fn(function* <B extends Bucket>(
  bucket: B,
) {
  yield* bindAbortMultipartUpload(bucket);
  const BucketName = yield* bucket.bucketName;
  return yield* AWS.withContext(
    Effect.fn(function* (request: AbortMultipartUploadRequest) {
      return yield* S3.abortMultipartUpload({
        ...request,
        Bucket: yield* BucketName,
      });
    }),
  );
});

export const bindAbortMultipartUpload = Binding.fn<AbortMultipartUploadBinding>(
  "AWS.S3.AbortMultipartUpload",
);

export class AbortMultipartUploadBinding extends Binding.Service(
  "AWS.S3.AbortMultipartUpload",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "AbortMultipartUpload",
            Effect: "Allow",
            Action: ["s3:AbortMultipartUpload"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `AbortMultipartUploadBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
