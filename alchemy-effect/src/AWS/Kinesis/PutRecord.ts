import * as Kinesis from "distilled-aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../ExecutionContext.ts";
import * as Output from "../../Output.ts";
import * as AWS from "../index.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordRequest extends Omit<
  Kinesis.PutRecordInput,
  "StreamName"
> {}

export const PutRecord = Effect.fn(function* <S extends Stream>(stream: S) {
  yield* bindPutRecord(stream);
  const StreamName = yield* stream.streamName;
  return yield* AWS.withContext(
    Effect.fn(function* (request: PutRecordRequest) {
      return yield* Kinesis.putRecord({
        ...request,
        StreamName: yield* StreamName,
      });
    }),
  );
});

export const bindPutRecord = Binding.fn<PutRecordBinding>(
  "AWS.Kinesis.PutRecord",
);

export class PutRecordBinding extends Binding.Service(
  "AWS.Kinesis.PutRecord",
  Effect.fn(function* <S extends Stream>(stream: S) {
    const ctx = yield* ExecutionContext;
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "PutRecord",
            Effect: "Allow",
            Action: ["kinesis:PutRecord"],
            Resource: [Output.interpolate`${stream.streamArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `PutRecordBinding does not support runtime '${ctx.type}'`,
      );
    }
  }),
) {}
