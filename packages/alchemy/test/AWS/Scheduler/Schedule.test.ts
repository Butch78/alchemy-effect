import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM";
import { Schedule } from "@/AWS/Scheduler";
import { Queue } from "@/AWS/SQS";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as scheduler from "@distilled.cloud/aws/scheduler";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule_ from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const assumeRolePolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "scheduler.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

const sendPolicy = (queueArn: unknown) => ({
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Action: ["sqs:SendMessage"],
      Resource: [queueArn] as any,
    },
  ],
});

class ScheduleStillExists extends Data.TaggedError("ScheduleStillExists") {}
class ScheduleAttrsNotReady extends Data.TaggedError("ScheduleAttrsNotReady") {}

const assertScheduleDeleted = Effect.fn(function* (
  scheduleName: string,
  groupName: string | undefined,
) {
  yield* scheduler
    .getSchedule({
      Name: scheduleName,
      GroupName: groupName !== "default" ? groupName : undefined,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new ScheduleStillExists())),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      Effect.retry({
        while: (e) =>
          (e as { _tag: string })._tag === "ScheduleStillExists",
        schedule: Schedule_.exponential(100).pipe(
          Schedule_.both(Schedule_.recurs(8)),
        ),
      }),
    );
});

/** Poll until GetSchedule reflects the requested state. */
const waitForScheduleMatch = Effect.fn(function* (
  scheduleName: string,
  expected: {
    ScheduleExpression?: string;
    State?: string;
    FlexibleTimeWindowMode?: string;
    Description?: string;
  },
) {
  yield* Effect.gen(function* () {
    const r = yield* scheduler.getSchedule({ Name: scheduleName });
    if (
      (expected.ScheduleExpression !== undefined &&
        r.ScheduleExpression !== expected.ScheduleExpression) ||
      (expected.State !== undefined && r.State !== expected.State) ||
      (expected.FlexibleTimeWindowMode !== undefined &&
        r.FlexibleTimeWindow?.Mode !== expected.FlexibleTimeWindowMode) ||
      (expected.Description !== undefined &&
        r.Description !== expected.Description)
    ) {
      return yield* Effect.fail(new ScheduleAttrsNotReady());
    }
  }).pipe(
    Effect.retry({
      while: (e) =>
        (e as { _tag: string })._tag === "ScheduleAttrsNotReady",
      schedule: Schedule_.fixed("500 millis").pipe(
        Schedule_.both(Schedule_.recurs(40)),
      ),
    }),
  );
});

const setupTarget = (id: string) =>
  Effect.gen(function* () {
    const queue = yield* Queue(`${id}Q`, {});
    const role = yield* Role(`${id}Role`, {
      assumeRolePolicyDocument: assumeRolePolicy,
      inlinePolicies: { Send: sendPolicy(queue.queueArn) },
    });
    return { queue, role };
  });

test.provider(
  "create and delete schedule with default props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const { queue, role } = yield* setupTarget("Default");
          const schedule = yield* Schedule("DefaultSchedule", {
            scheduleExpression: "rate(1 hour)",
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
          return { schedule, queue, role };
        }),
      );

      expect(result.schedule.scheduleArn).toBeDefined();
      expect(result.schedule.scheduleName).toBeDefined();
      expect(result.schedule.groupName).toEqual("default");

      const described = yield* scheduler.getSchedule({
        Name: result.schedule.scheduleName,
      });
      expect(described.ScheduleExpression).toEqual("rate(1 hour)");
      expect(described.FlexibleTimeWindow?.Mode).toEqual("OFF");

      yield* stack.destroy();
      yield* assertScheduleDeleted(result.schedule.scheduleName, "default");
    }),
  { timeout: 180_000 },
);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const { queue, role } = yield* setupTarget("Idem");
          const schedule = yield* Schedule("IdempotentSchedule", {
            scheduleExpression: "rate(2 hours)",
            description: "initial",
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
          return { schedule };
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const { queue, role } = yield* setupTarget("Idem");
          const schedule = yield* Schedule("IdempotentSchedule", {
            scheduleExpression: "rate(2 hours)",
            description: "initial",
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
          return { schedule };
        }),
      );

      expect(second.schedule.scheduleArn).toEqual(
        initial.schedule.scheduleArn,
      );
      expect(second.schedule.scheduleName).toEqual(
        initial.schedule.scheduleName,
      );

      const described = yield* scheduler.getSchedule({
        Name: second.schedule.scheduleName,
      });
      expect(described.ScheduleExpression).toEqual("rate(2 hours)");
      expect(described.Description).toEqual("initial");

      yield* stack.destroy();
      yield* assertScheduleDeleted(second.schedule.scheduleName, "default");
    }),
  { timeout: 180_000 },
);

test.provider(
  "reconcile resets schedule mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const { queue, role } = yield* setupTarget("Drift");
          const schedule = yield* Schedule("DriftSchedule", {
            scheduleExpression: "rate(1 hour)",
            description: "managed",
            state: "ENABLED",
            flexibleTimeWindow: { Mode: "OFF" },
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
          return { schedule, queue, role };
        }),
      );

      // Mutate ScheduleExpression / State / FlexibleTimeWindow / Description
      // out-of-band via the raw SDK. UpdateSchedule is a full PUT, so we
      // must echo Target/RoleArn here.
      const live = yield* scheduler.getSchedule({
        Name: initial.schedule.scheduleName,
      });
      yield* scheduler.updateSchedule({
        Name: initial.schedule.scheduleName,
        ScheduleExpression: "rate(7 hours)",
        State: "DISABLED",
        Description: "drifted",
        FlexibleTimeWindow: {
          Mode: "FLEXIBLE",
          MaximumWindowInMinutes: 5,
        },
        Target: live.Target!,
      });
      yield* waitForScheduleMatch(initial.schedule.scheduleName, {
        ScheduleExpression: "rate(7 hours)",
        State: "DISABLED",
        FlexibleTimeWindowMode: "FLEXIBLE",
        Description: "drifted",
      });

      // Re-deploy with original props — reconcile must reset cloud state.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          const { queue, role } = yield* setupTarget("Drift");
          const schedule = yield* Schedule("DriftSchedule", {
            scheduleExpression: "rate(1 hour)",
            description: "managed",
            state: "ENABLED",
            flexibleTimeWindow: { Mode: "OFF" },
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
          return { schedule };
        }),
      );

      expect(redeployed.schedule.scheduleArn).toEqual(
        initial.schedule.scheduleArn,
      );
      yield* waitForScheduleMatch(initial.schedule.scheduleName, {
        ScheduleExpression: "rate(1 hour)",
        State: "ENABLED",
        FlexibleTimeWindowMode: "OFF",
        Description: "managed",
      });

      yield* stack.destroy();
      yield* assertScheduleDeleted(initial.schedule.scheduleName, "default");
    }),
  { timeout: 180_000 },
);

test.provider(
  "reconcile re-creates a schedule that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const scheduleName = `alchemy-test-sched-recreate-${suffix}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const { queue, role } = yield* setupTarget("Recreate");
          const schedule = yield* Schedule("RecreateSchedule", {
            name: scheduleName,
            scheduleExpression: "rate(1 hour)",
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
          return { schedule };
        }),
      );

      // Delete the schedule out-of-band.
      yield* scheduler.deleteSchedule({ Name: scheduleName });
      yield* assertScheduleDeleted(scheduleName, "default");

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          const { queue, role } = yield* setupTarget("Recreate");
          const schedule = yield* Schedule("RecreateSchedule", {
            name: scheduleName,
            scheduleExpression: "rate(1 hour)",
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
          return { schedule };
        }),
      );

      expect(recreated.schedule.scheduleName).toEqual(scheduleName);
      const described = yield* scheduler.getSchedule({ Name: scheduleName });
      expect(described.ScheduleExpression).toEqual("rate(1 hour)");

      yield* stack.destroy();
      yield* assertScheduleDeleted(scheduleName, "default");
    }),
  { timeout: 180_000 },
);

test.provider(
  "changing schedule name triggers replace, old schedule is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-sched-replace-a-${suffix}`;
      const nameB = `alchemy-test-sched-replace-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          const { queue, role } = yield* setupTarget("Rename");
          const schedule = yield* Schedule("RenameSchedule", {
            name: nameA,
            scheduleExpression: "rate(1 hour)",
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
          return { schedule };
        }),
      );
      expect(a.schedule.scheduleName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          const { queue, role } = yield* setupTarget("Rename");
          const schedule = yield* Schedule("RenameSchedule", {
            name: nameB,
            scheduleExpression: "rate(1 hour)",
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
          return { schedule };
        }),
      );
      expect(b.schedule.scheduleName).toEqual(nameB);
      expect(b.schedule.scheduleArn).not.toEqual(a.schedule.scheduleArn);

      yield* assertScheduleDeleted(nameA, "default");

      yield* stack.destroy();
      yield* assertScheduleDeleted(nameB, "default");
    }),
  { timeout: 180_000 },
);

test.provider(
  "destroying an already-deleted schedule is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const { queue, role } = yield* setupTarget("Double");
          const schedule = yield* Schedule("DoubleDestroySchedule", {
            scheduleExpression: "rate(1 hour)",
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
          return { schedule };
        }),
      );

      // Delete the schedule out-of-band, then ask the engine to destroy
      // the stack. The provider's `delete` must catch
      // `ResourceNotFoundException` and complete cleanly.
      yield* scheduler.deleteSchedule({
        Name: result.schedule.scheduleName,
      });
      yield* assertScheduleDeleted(result.schedule.scheduleName, "default");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

test.provider(
  "foreign schedule (no engine state) requires adopt(true) to take over",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const scheduleName = `alchemy-test-sched-adopt-${suffix}`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          const { queue, role } = yield* setupTarget("Adopt");
          const schedule = yield* Schedule("Original", {
            name: scheduleName,
            scheduleExpression: "rate(1 hour)",
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
          return { schedule };
        }),
      );

      // Wipe engine state — schedule remains in AWS. A subsequent deploy
      // with a different logical ID and the same physical name must
      // require `adopt(true)` because Scheduler doesn't support tags so
      // the engine has no ownership signal beyond the persisted output.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "Original",
        });
      }).pipe(Effect.provide(stack.state));

      const takenOver = yield* stack
        .deploy(
          Effect.gen(function* () {
            const { queue, role } = yield* setupTarget("Adopt");
            const schedule = yield* Schedule("Different", {
              name: scheduleName,
              scheduleExpression: "rate(2 hours)",
              target: { Arn: queue.queueArn, RoleArn: role.roleArn },
            });
            return { schedule };
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.schedule.scheduleName).toEqual(scheduleName);
      expect(takenOver.schedule.scheduleArn).toEqual(
        original.schedule.scheduleArn,
      );
      yield* waitForScheduleMatch(scheduleName, {
        ScheduleExpression: "rate(2 hours)",
      });

      yield* stack.destroy();
      yield* assertScheduleDeleted(scheduleName, "default");
    }),
  { timeout: 180_000 },
);
