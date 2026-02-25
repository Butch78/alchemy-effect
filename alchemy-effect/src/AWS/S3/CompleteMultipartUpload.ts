import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface CompleteMultipartUploadRequest extends Omit<
  S3.CompleteMultipartUploadRequest,
  "Bucket"
> {}

export const CompleteMultipartUpload = Effect.fn(function* <B extends Bucket>(
  bucket: B,
) {
  yield* bindCompleteMultipartUpload(bucket);
  const BucketName = yield* bucket.bucketName;
  return yield* AWS.withContext(
    Effect.fn(function* (request: CompleteMultipartUploadRequest) {
      return yield* S3.completeMultipartUpload({
        ...request,
        Bucket: yield* BucketName,
      });
    }),
  );
});

export const bindCompleteMultipartUpload =
  Binding.fn<CompleteMultipartUploadBinding>("AWS.S3.CompleteMultipartUpload");

export class CompleteMultipartUploadBinding extends Binding.Service(
  "AWS.S3.CompleteMultipartUpload",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "CompleteMultipartUpload",
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `CompleteMultipartUploadBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
