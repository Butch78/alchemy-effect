import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface DeleteObjectRequest extends Omit<
  S3.DeleteObjectRequest,
  "Bucket"
> {}

export const DeleteObject = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindDeleteObject(bucket);
  const BucketName = yield* bucket.bucketName;
  return yield* AWS.withContext(
    Effect.fn(function* (request: DeleteObjectRequest) {
      return yield* S3.deleteObject({
        ...request,
        Bucket: yield* BucketName,
      });
    }),
  );
});

export const bindDeleteObject = Binding.fn<DeleteObjectBinding>(
  "AWS.S3.DeleteObject",
);

export class DeleteObjectBinding extends Binding.Service(
  "AWS.S3.DeleteObject",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "DeleteObject",
            Effect: "Allow",
            Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `DeleteObjectBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
