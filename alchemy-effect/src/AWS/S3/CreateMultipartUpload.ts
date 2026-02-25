import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface CreateMultipartUploadRequest extends Omit<
  S3.CreateMultipartUploadRequest,
  "Bucket"
> {}

export const CreateMultipartUpload = Effect.fn(function* <B extends Bucket>(
  bucket: B,
) {
  yield* bindCreateMultipartUpload(bucket);
  const BucketName = yield* bucket.bucketName;
  return yield* AWS.withContext(
    Effect.fn(function* (request: CreateMultipartUploadRequest) {
      return yield* S3.createMultipartUpload({
        ...request,
        Bucket: yield* BucketName,
      });
    }),
  );
});

export const bindCreateMultipartUpload =
  Binding.fn<CreateMultipartUploadBinding>("AWS.S3.CreateMultipartUpload");

export class CreateMultipartUploadBinding extends Binding.Service(
  "AWS.S3.CreateMultipartUpload",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "CreateMultipartUpload",
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `CreateMultipartUploadBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
