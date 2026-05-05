import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Alarm } from "@/AWS/CloudWatch";
import { Topic } from "@/AWS/SNS";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const baseAlarmProps = {
  MetricName: "Errors",
  Namespace: "AWS/Lambda",
  Statistic: "Sum" as const,
  Period: 60,
  EvaluationPeriods: 1,
  Threshold: 1,
  ComparisonOperator: "GreaterThanOrEqualToThreshold" as const,
  TreatMissingData: "notBreaching",
};

class AlarmStillExists extends Data.TaggedError("AlarmStillExists") {}
class AlarmAttrNotReady extends Data.TaggedError("AlarmAttrNotReady") {}

/** Read a metric alarm by name; returns undefined if it doesn't exist. */
const describeMetricAlarm = (alarmName: string) =>
  cloudwatch
    .describeAlarms({
      AlarmNames: [alarmName],
      AlarmTypes: ["MetricAlarm"],
    })
    .pipe(
      Effect.map((r) =>
        r.MetricAlarms?.find((a) => a.AlarmName === alarmName),
      ),
    );

/** Wait until describeAlarms reports the requested attribute values. */
const waitForAlarmAttrs = Effect.fn(function* (
  alarmName: string,
  expected: Partial<{
    Threshold: number;
    EvaluationPeriods: number;
    AlarmDescription: string;
    AlarmActions: string[];
  }>,
) {
  yield* Effect.gen(function* () {
    const alarm = yield* describeMetricAlarm(alarmName);
    if (!alarm) {
      return yield* Effect.fail(new AlarmAttrNotReady());
    }
    if (
      expected.Threshold !== undefined &&
      alarm.Threshold !== expected.Threshold
    ) {
      return yield* Effect.fail(new AlarmAttrNotReady());
    }
    if (
      expected.EvaluationPeriods !== undefined &&
      alarm.EvaluationPeriods !== expected.EvaluationPeriods
    ) {
      return yield* Effect.fail(new AlarmAttrNotReady());
    }
    if (
      expected.AlarmDescription !== undefined &&
      alarm.AlarmDescription !== expected.AlarmDescription
    ) {
      return yield* Effect.fail(new AlarmAttrNotReady());
    }
    if (expected.AlarmActions !== undefined) {
      const actual = [...(alarm.AlarmActions ?? [])].sort();
      const want = [...expected.AlarmActions].sort();
      if (
        actual.length !== want.length ||
        actual.some((v, i) => v !== want[i])
      ) {
        return yield* Effect.fail(new AlarmAttrNotReady());
      }
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "AlarmAttrNotReady",
      schedule: Schedule.fixed("500 millis").pipe(
        Schedule.both(Schedule.recurs(40)),
      ),
    }),
  );
});

const assertAlarmDeleted = Effect.fn(function* (alarmName: string) {
  yield* Effect.gen(function* () {
    const alarm = yield* describeMetricAlarm(alarmName);
    if (alarm) {
      return yield* Effect.fail(new AlarmStillExists());
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "AlarmStillExists",
      schedule: Schedule.exponential(100).pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );
});

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Alarm("IdempotentAlarm", {
            ...baseAlarmProps,
            AlarmDescription: "alchemy idempotent test",
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Alarm("IdempotentAlarm", {
            ...baseAlarmProps,
            AlarmDescription: "alchemy idempotent test",
          });
        }),
      );
      expect(second.alarmName).toEqual(initial.alarmName);
      expect(second.alarmArn).toEqual(initial.alarmArn);

      const fresh = yield* describeMetricAlarm(second.alarmName);
      expect(fresh?.Threshold).toEqual(1);
      expect(fresh?.AlarmDescription).toEqual("alchemy idempotent test");

      yield* stack.destroy();
      yield* assertAlarmDeleted(initial.alarmName);
    }),
);

test.provider(
  "reconcile resets attributes mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const alarm = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Alarm("DriftAlarm", {
            ...baseAlarmProps,
            Threshold: 1,
            EvaluationPeriods: 1,
            AlarmDescription: "desired-description",
          });
        }),
      );

      // Mutate the alarm out-of-band via the raw CloudWatch SDK.
      yield* cloudwatch.putMetricAlarm({
        ...baseAlarmProps,
        AlarmName: alarm.alarmName,
        Threshold: 999,
        EvaluationPeriods: 5,
        AlarmDescription: "drifted-description",
      });
      yield* waitForAlarmAttrs(alarm.alarmName, {
        Threshold: 999,
        EvaluationPeriods: 5,
        AlarmDescription: "drifted-description",
      });

      // Re-deploy with the same desired props — reconcile should reset
      // the drifted attributes back to the desired values.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Alarm("DriftAlarm", {
            ...baseAlarmProps,
            Threshold: 1,
            EvaluationPeriods: 1,
            AlarmDescription: "desired-description",
          });
        }),
      );
      expect(redeployed.alarmArn).toEqual(alarm.alarmArn);

      yield* waitForAlarmAttrs(alarm.alarmName, {
        Threshold: 1,
        EvaluationPeriods: 1,
        AlarmDescription: "desired-description",
      });

      yield* stack.destroy();
      yield* assertAlarmDeleted(alarm.alarmName);
    }),
);

test.provider(
  "reconcile resets AlarmActions mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Stand up two SNS topics so we have real, valid alarm action ARNs.
      const { desiredArn, driftedArn } = yield* stack.deploy(
        Effect.gen(function* () {
          const desired = yield* Topic("ActionsAlarmTargetA");
          const drifted = yield* Topic("ActionsAlarmTargetB");
          return {
            desiredArn: desired.topicArn,
            driftedArn: drifted.topicArn,
          };
        }),
      );

      const alarm = yield* stack.deploy(
        Effect.gen(function* () {
          // Re-create the topics so the engine carries them through.
          yield* Topic("ActionsAlarmTargetA");
          yield* Topic("ActionsAlarmTargetB");
          return yield* Alarm("ActionsAlarm", {
            ...baseAlarmProps,
            AlarmActions: [desiredArn],
          });
        }),
      );
      yield* waitForAlarmAttrs(alarm.alarmName, {
        AlarmActions: [desiredArn],
      });

      // Drift the actions out-of-band.
      yield* cloudwatch.putMetricAlarm({
        ...baseAlarmProps,
        AlarmName: alarm.alarmName,
        AlarmActions: [driftedArn],
      });
      yield* waitForAlarmAttrs(alarm.alarmName, {
        AlarmActions: [driftedArn],
      });

      // Re-deploy: reconcile must reset to desired actions.
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Topic("ActionsAlarmTargetA");
          yield* Topic("ActionsAlarmTargetB");
          return yield* Alarm("ActionsAlarm", {
            ...baseAlarmProps,
            AlarmActions: [desiredArn],
          });
        }),
      );
      yield* waitForAlarmAttrs(alarm.alarmName, {
        AlarmActions: [desiredArn],
      });

      yield* stack.destroy();
      yield* assertAlarmDeleted(alarm.alarmName);
    }),
);

test.provider(
  "reconcile re-creates an alarm that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const alarmName = `alchemy-test-cw-recreate-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Alarm("RecreateAlarm", {
            ...baseAlarmProps,
            name: alarmName,
          });
        }),
      );

      // Delete the alarm out of band.
      yield* cloudwatch.deleteAlarms({ AlarmNames: [initial.alarmName] });
      yield* assertAlarmDeleted(initial.alarmName);

      // Re-deploying must converge by re-creating.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Alarm("RecreateAlarm", {
            ...baseAlarmProps,
            name: alarmName,
          });
        }),
      );

      expect(recreated.alarmName).toEqual(alarmName);
      const fresh = yield* describeMetricAlarm(recreated.alarmName);
      expect(fresh).toBeDefined();
      expect(fresh?.Threshold).toEqual(1);

      yield* stack.destroy();
      yield* assertAlarmDeleted(recreated.alarmName);
    }),
);

test.provider(
  "changing alarmName triggers replace, old alarm is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-cw-replace-a-${suffix}`;
      const nameB = `alchemy-test-cw-replace-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Alarm("RenameAlarm", {
            ...baseAlarmProps,
            name: nameA,
          });
        }),
      );
      expect(a.alarmName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Alarm("RenameAlarm", {
            ...baseAlarmProps,
            name: nameB,
          });
        }),
      );
      expect(b.alarmName).toEqual(nameB);
      expect(b.alarmArn).not.toEqual(a.alarmArn);

      // The old alarm must be gone after replace.
      yield* assertAlarmDeleted(a.alarmName);

      yield* stack.destroy();
      yield* assertAlarmDeleted(b.alarmName);
    }),
);

test.provider(
  "destroying an already-deleted alarm is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const alarm = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Alarm("DoubleDestroyAlarm", baseAlarmProps);
        }),
      );

      // Delete out-of-band, then ask the engine to destroy. The provider's
      // `delete` must catch ResourceNotFound and complete cleanly.
      yield* cloudwatch.deleteAlarms({ AlarmNames: [alarm.alarmName] });
      yield* assertAlarmDeleted(alarm.alarmName);

      yield* stack.destroy();
    }),
);

test.provider(
  "foreign-tagged alarm requires adopt(true) to take over and is retagged",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const alarmName = `alchemy-test-cw-takeover-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Alarm("Original", {
            ...baseAlarmProps,
            name: alarmName,
          });
        }),
      );

      // Wipe state but leave the alarm in CloudWatch.
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
            return yield* Alarm("Different", {
              ...baseAlarmProps,
              name: alarmName,
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.alarmName).toEqual(alarmName);
      expect(takenOver.alarmArn).toEqual(original.alarmArn);

      // adopt(true) must retag the alarm with internal alchemy tags so
      // subsequent runs route through silent adoption.
      const tags = yield* cloudwatch.listTagsForResource({
        ResourceARN: takenOver.alarmArn,
      });
      const tagMap = Object.fromEntries(
        (tags.Tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""]),
      );
      expect(tagMap["alchemy:fqn"]).toBeDefined();
      expect(tagMap["alchemy:stage"]).toBeDefined();

      yield* stack.destroy();
      yield* assertAlarmDeleted(takenOver.alarmName);
    }),
);
