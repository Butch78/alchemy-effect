import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { LogGroup } from "@/AWS/Logs";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class LogGroupStillExists extends Data.TaggedError("LogGroupStillExists") {}
class LogGroupRetentionMismatch extends Data.TaggedError(
  "LogGroupRetentionMismatch",
) {}

const describeLogGroup = (logGroupName: string) =>
  logs
    .describeLogGroups({ logGroupNamePrefix: logGroupName, limit: 1 })
    .pipe(
      Effect.map((r) =>
        (r.logGroups ?? []).find(
          (group) => group.logGroupName === logGroupName,
        ),
      ),
    );

const assertLogGroupDeleted = Effect.fn(function* (logGroupName: string) {
  yield* Effect.gen(function* () {
    const match = yield* describeLogGroup(logGroupName);
    if (match) {
      return yield* Effect.fail(new LogGroupStillExists());
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "LogGroupStillExists",
      schedule: Schedule.exponential("100 millis").pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );
});

/** CloudWatch reads can lag write-through; poll until retention reflects desired. */
const waitForRetentionMatch = Effect.fn(function* (
  logGroupName: string,
  expected: number | undefined,
) {
  yield* Effect.gen(function* () {
    const match = yield* describeLogGroup(logGroupName);
    if (match?.retentionInDays !== expected) {
      return yield* Effect.fail(new LogGroupRetentionMismatch());
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "LogGroupRetentionMismatch",
      schedule: Schedule.fixed("500 millis").pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );
});

describe("AWS.Logs.LogGroup", () => {
  test.provider("create and delete log group with default props", (stack) =>
    Effect.gen(function* () {
      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* LogGroup("DefaultLogGroup");
        }),
      );

      expect(group.logGroupName).toBeDefined();
      expect(group.logGroupArn).toBeDefined();

      const observed = yield* describeLogGroup(group.logGroupName);
      expect(observed?.arn).toEqual(group.logGroupArn);

      yield* stack.destroy();
      yield* assertLogGroupDeleted(group.logGroupName);
    }),
  );

  test.provider(
    "redeploy with same props is a no-op (reconcile is idempotent)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("IdempotentGroup", {
              retentionInDays: 7,
            });
          }),
        );

        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("IdempotentGroup", {
              retentionInDays: 7,
            });
          }),
        );
        expect(second.logGroupArn).toEqual(initial.logGroupArn);
        expect(second.logGroupName).toEqual(initial.logGroupName);

        const observed = yield* describeLogGroup(initial.logGroupName);
        expect(observed?.retentionInDays).toEqual(7);

        yield* stack.destroy();
        yield* assertLogGroupDeleted(initial.logGroupName);
      }),
  );

  test.provider(
    "reconcile resets retention mutated out-of-band via the raw SDK",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("DriftRetentionGroup", {
              retentionInDays: 7,
            });
          }),
        );

        // Mutate retention out-of-band.
        yield* logs.putRetentionPolicy({
          logGroupName: initial.logGroupName,
          retentionInDays: 90,
        });
        yield* waitForRetentionMatch(initial.logGroupName, 90);

        // Re-deploy with the same desired props — reconcile must reset.
        const redeployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("DriftRetentionGroup", {
              retentionInDays: 7,
            });
          }),
        );
        expect(redeployed.logGroupArn).toEqual(initial.logGroupArn);

        yield* waitForRetentionMatch(initial.logGroupName, 7);

        // And dropping retention entirely should remove the policy.
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("DriftRetentionGroup");
          }),
        );
        yield* waitForRetentionMatch(initial.logGroupName, undefined);

        yield* stack.destroy();
        yield* assertLogGroupDeleted(initial.logGroupName);
      }),
  );

  test.provider(
    "reconcile re-creates a log group that was deleted out-of-band",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const logGroupName = `alchemy-test-logs-recreate-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("RecreateGroup", { logGroupName });
          }),
        );

        // Delete the log group out of band.
        yield* logs.deleteLogGroup({ logGroupName });
        yield* assertLogGroupDeleted(logGroupName);

        // Re-deploy must converge by re-creating.
        const recreated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("RecreateGroup", { logGroupName });
          }),
        );
        expect(recreated.logGroupName).toEqual(logGroupName);
        expect(recreated.logGroupArn).toEqual(initial.logGroupArn);

        const observed = yield* describeLogGroup(logGroupName);
        expect(observed?.arn).toEqual(initial.logGroupArn);

        yield* stack.destroy();
        yield* assertLogGroupDeleted(logGroupName);
      }),
  );

  test.provider(
    "changing logGroupName triggers replace, old group is deleted",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const suffix = Math.random().toString(36).slice(2, 8);
        const nameA = `alchemy-test-logs-replace-a-${suffix}`;
        const nameB = `alchemy-test-logs-replace-b-${suffix}`;

        const a = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("RenameGroup", { logGroupName: nameA });
          }),
        );
        expect(a.logGroupName).toEqual(nameA);

        const b = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("RenameGroup", { logGroupName: nameB });
          }),
        );
        expect(b.logGroupName).toEqual(nameB);
        expect(b.logGroupArn).not.toEqual(a.logGroupArn);

        // Old group must be gone after replace.
        yield* assertLogGroupDeleted(nameA);

        yield* stack.destroy();
        yield* assertLogGroupDeleted(nameB);
      }),
  );

  test.provider(
    "destroying an already-deleted log group is a no-op",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const group = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("DoubleDestroyGroup");
          }),
        );

        // Delete out of band, then ask the engine to destroy. Provider's
        // `delete` must catch ResourceNotFoundException and complete cleanly.
        yield* logs.deleteLogGroup({ logGroupName: group.logGroupName });
        yield* assertLogGroupDeleted(group.logGroupName);

        yield* stack.destroy();
      }),
  );

  test.provider(
    "owned log group (matching alchemy tags) is silently adopted without --adopt",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const logGroupName = `alchemy-test-logs-adopt-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("AdoptableGroup", { logGroupName });
          }),
        );
        expect(initial.logGroupName).toEqual(logGroupName);

        // Wipe state — log group stays in CloudWatch.
        yield* Effect.gen(function* () {
          const state = yield* State;
          yield* state.delete({
            stack: stack.name,
            stage: "test",
            fqn: "AdoptableGroup",
          });
        }).pipe(Effect.provide(stack.state));

        const adopted = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("AdoptableGroup", { logGroupName });
          }),
        );

        expect(adopted.logGroupArn).toEqual(initial.logGroupArn);
        expect(adopted.logGroupName).toEqual(initial.logGroupName);

        yield* stack.destroy();
        yield* assertLogGroupDeleted(logGroupName);
      }),
  );

  test.provider(
    "foreign-tagged log group requires adopt(true) to take over and gets re-tagged",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const logGroupName = `alchemy-test-logs-takeover-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        const original = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* LogGroup("Original", { logGroupName });
          }),
        );

        // Drop alchemy state AND swap the alchemy ownership tags for a
        // foreign tag, simulating a group created by another tool.
        yield* Effect.gen(function* () {
          const state = yield* State;
          yield* state.delete({
            stack: stack.name,
            stage: "test",
            fqn: "Original",
          });
        }).pipe(Effect.provide(stack.state));
        const observedTags = yield* logs
          .listTagsForResource({ resourceArn: original.logGroupArn })
          .pipe(Effect.map((r) => r.tags ?? {}));
        const alchemyTagKeys = Object.keys(observedTags).filter((key) =>
          key.startsWith("alchemy:"),
        );
        if (alchemyTagKeys.length > 0) {
          yield* logs.untagResource({
            resourceArn: original.logGroupArn,
            tagKeys: alchemyTagKeys,
          });
        }
        yield* logs.tagResource({
          resourceArn: original.logGroupArn,
          tags: { foreign: "yes" },
        });

        const takenOver = yield* stack
          .deploy(
            Effect.gen(function* () {
              return yield* LogGroup("Different", { logGroupName });
            }),
          )
          .pipe(adopt(true));

        expect(takenOver.logGroupName).toEqual(logGroupName);
        expect(takenOver.logGroupArn).toEqual(original.logGroupArn);

        // Adoption with `adopt(true)` should rewrite the alchemy ownership
        // tags so subsequent runs route through silent adoption.
        const tagsAfter = yield* logs
          .listTagsForResource({ resourceArn: original.logGroupArn })
          .pipe(Effect.map((r) => r.tags ?? {}));
        expect(tagsAfter["alchemy:fqn"]).toBeDefined();
        expect(tagsAfter["alchemy:stage"]).toBeDefined();

        yield* stack.destroy();
        yield* assertLogGroupDeleted(logGroupName);
      }),
  );
});
