import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface PutObjectRequest extends Omit<S3.PutObjectRequest, "Bucket"> {}

export const PutObject = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindPutObject(bucket);
  const BucketName = yield* bucket.bucketName;
  return yield* AWS.withContext(
    Effect.fn(function* (request: PutObjectRequest) {
      return yield* S3.putObject({
        ...request,
        Bucket: yield* BucketName,
      });
    }),
  );
});

export const bindPutObject = Binding.fn<PutObjectBinding>("AWS.S3.PutObject");

export class PutObjectBinding extends Binding.Service(
  "AWS.S3.PutObject",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "PutObject",
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `PutObjectBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
