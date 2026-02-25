import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface UploadPartRequest extends Omit<
  S3.UploadPartRequest,
  "Bucket"
> {}

export const UploadPart = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindUploadPart(bucket);
  const BucketName = yield* bucket.bucketName;
  return yield* AWS.withContext(
    Effect.fn(function* (request: UploadPartRequest) {
      return yield* S3.uploadPart({
        ...request,
        Bucket: yield* BucketName,
      });
    }),
  );
});

export const bindUploadPart =
  Binding.fn<UploadPartBinding>("AWS.S3.UploadPart");

export class UploadPartBinding extends Binding.Service(
  "AWS.S3.UploadPart",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "UploadPart",
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `UploadPartBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
