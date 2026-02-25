import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export class MyService extends ServiceMap.Service<
  MyService,
  {
    foo(): Effect.Effect<void, never, never>;
  }
>()("MyService") {}

export interface CopyObjectRequest extends Omit<
  S3.CopyObjectRequest,
  "Bucket"
> {}

export const CopyObject = Effect.fn(function* <B extends Bucket>(bucket: B) {
  yield* bindCopyObject(bucket);
  // binds the bucketName to the Function environment
  const BucketName = yield* bucket.bucketName;
  // TODO(sam): get rid of AWS.withContext
  // const copyObject = yield* S3.copyObject;
  return yield* AWS.withContext(
    Effect.fn(function* (request: CopyObjectRequest) {
      return yield* S3.copyObject({
        ...request,
        // this accesses it
        Bucket: yield* BucketName,
      });
    }),
  );
});

export const bindCopyObject =
  Binding.fn<CopyObjectBinding>("AWS.S3.CopyObject");

export class CopyObjectBinding extends Binding.Service(
  "AWS.S3.CopyObject",
  Effect.fn(function* <B extends Bucket>(bucket: B) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "CopyObject",
            Effect: "Allow",
            Action: ["s3:PutObject", "s3:GetObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `CopyObjectBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
