import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { ScheduleGroup } from "@/AWS/Scheduler";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as scheduler from "@distilled.cloud/aws/scheduler";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule_ from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class GroupStillExists extends Data.TaggedError("GroupStillExists") {}
class GroupTagsNotReady extends Data.TaggedError("GroupTagsNotReady") {}

const assertGroupDeleted = Effect.fn(function* (groupName: string) {
  yield* scheduler
    .getScheduleGroup({ Name: groupName })
    .pipe(
      Effect.flatMap(() => Effect.fail(new GroupStillExists())),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      Effect.retry({
        while: (e) => (e as { _tag: string })._tag === "GroupStillExists",
        schedule: Schedule_.exponential(200).pipe(
          Schedule_.both(Schedule_.recurs(10)),
        ),
      }),
    );
});

const fetchGroupTags = Effect.fn(function* (arn: string) {
  const r = yield* scheduler.listTagsForResource({ ResourceArn: arn });
  return Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value]));
});

/** Poll until tag set on the group matches `expected` (subset match). */
const waitForTagsMatch = Effect.fn(function* (
  arn: string,
  expected: Record<string, string>,
) {
  yield* Effect.gen(function* () {
    const tags = yield* fetchGroupTags(arn);
    const ok = Object.entries(expected).every(([k, v]) => tags[k] === v);
    if (!ok) {
      return yield* Effect.fail(new GroupTagsNotReady());
    }
  }).pipe(
    Effect.retry({
      while: (e) => (e as { _tag: string })._tag === "GroupTagsNotReady",
      schedule: Schedule_.fixed("500 millis").pipe(
        Schedule_.both(Schedule_.recurs(40)),
      ),
    }),
  );
});

test.provider(
  "create and delete schedule group with default props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ScheduleGroup("DefaultGroup", {
            tags: { domain: "ops" },
          });
        }),
      );

      expect(group.scheduleGroupArn).toBeDefined();
      expect(group.scheduleGroupName).toBeDefined();

      const described = yield* scheduler.getScheduleGroup({
        Name: group.scheduleGroupName,
      });
      expect(described.Arn).toEqual(group.scheduleGroupArn);
      expect(described.State).toEqual("ACTIVE");

      const tags = yield* fetchGroupTags(group.scheduleGroupArn);
      expect(tags.domain).toEqual("ops");

      yield* stack.destroy();
      yield* assertGroupDeleted(group.scheduleGroupName);
    }),
  { timeout: 240_000 },
);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ScheduleGroup("IdempotentGroup", {
            tags: { layer: "ops" },
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ScheduleGroup("IdempotentGroup", {
            tags: { layer: "ops" },
          });
        }),
      );

      expect(second.scheduleGroupArn).toEqual(initial.scheduleGroupArn);
      expect(second.scheduleGroupName).toEqual(initial.scheduleGroupName);

      const tags = yield* fetchGroupTags(second.scheduleGroupArn);
      expect(tags.layer).toEqual("ops");

      yield* stack.destroy();
      yield* assertGroupDeleted(second.scheduleGroupName);
    }),
  { timeout: 240_000 },
);

test.provider(
  "reconcile resets tags mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ScheduleGroup("DriftGroup", {
            tags: { domain: "ops", env: "prod" },
          });
        }),
      );

      // Mutate tags out-of-band: drop `env`, change `domain`, add `intruder`.
      yield* scheduler.untagResource({
        ResourceArn: initial.scheduleGroupArn,
        TagKeys: ["env", "domain"],
      });
      yield* scheduler.tagResource({
        ResourceArn: initial.scheduleGroupArn,
        Tags: [
          { Key: "domain", Value: "drifted" },
          { Key: "intruder", Value: "yes" },
        ],
      });
      yield* waitForTagsMatch(initial.scheduleGroupArn, {
        domain: "drifted",
        intruder: "yes",
      });

      // Re-deploy with original props — reconcile must reset the tag set.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ScheduleGroup("DriftGroup", {
            tags: { domain: "ops", env: "prod" },
          });
        }),
      );

      expect(redeployed.scheduleGroupArn).toEqual(initial.scheduleGroupArn);

      const tags = yield* fetchGroupTags(initial.scheduleGroupArn);
      expect(tags.domain).toEqual("ops");
      expect(tags.env).toEqual("prod");
      expect(tags.intruder).toBeUndefined();

      yield* stack.destroy();
      yield* assertGroupDeleted(initial.scheduleGroupName);
    }),
  { timeout: 240_000 },
);

test.provider(
  "reconcile re-creates a schedule group deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const groupName = `alchemy-test-grp-recreate-${suffix}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ScheduleGroup("RecreateGroup", {
            name: groupName,
            tags: { layer: "ops" },
          });
        }),
      );
      expect(initial.scheduleGroupName).toEqual(groupName);

      // Delete out-of-band. The group enters `DELETING` and removal is
      // eventually consistent.
      yield* scheduler.deleteScheduleGroup({ Name: groupName });
      yield* assertGroupDeleted(groupName);

      // Re-deploy. The reconciler must create a fresh group with the
      // same name, riding the bounded `ConflictException` retry through
      // any residual `DELETING` window.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ScheduleGroup("RecreateGroup", {
            name: groupName,
            tags: { layer: "ops" },
          });
        }),
      );

      expect(recreated.scheduleGroupName).toEqual(groupName);
      const described = yield* scheduler.getScheduleGroup({ Name: groupName });
      expect(described.Arn).toBeDefined();
      const tags = yield* fetchGroupTags(described.Arn!);
      expect(tags.layer).toEqual("ops");

      yield* stack.destroy();
      yield* assertGroupDeleted(groupName);
    }),
  { timeout: 360_000 },
);

test.provider(
  "changing schedule group name triggers replace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-grp-replace-a-${suffix}`;
      const nameB = `alchemy-test-grp-replace-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ScheduleGroup("RenameGroup", { name: nameA });
        }),
      );
      expect(a.scheduleGroupName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ScheduleGroup("RenameGroup", { name: nameB });
        }),
      );
      expect(b.scheduleGroupName).toEqual(nameB);
      expect(b.scheduleGroupArn).not.toEqual(a.scheduleGroupArn);

      yield* assertGroupDeleted(nameA);

      yield* stack.destroy();
      yield* assertGroupDeleted(nameB);
    }),
  { timeout: 360_000 },
);

test.provider(
  "destroying an already-deleted schedule group is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ScheduleGroup("DoubleDestroyGroup", {});
        }),
      );

      // Delete out-of-band, then ask the engine to destroy the stack.
      yield* scheduler.deleteScheduleGroup({
        Name: result.scheduleGroupName,
      });
      yield* assertGroupDeleted(result.scheduleGroupName);

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);

test.provider(
  "foreign-tagged schedule group requires adopt(true) to take over",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const groupName = `alchemy-test-grp-adopt-${suffix}`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ScheduleGroup("Original", {
            name: groupName,
            tags: { phase: "before" },
          });
        }),
      );

      // Wipe engine state — group remains in AWS with the old logical
      // ID's internal tags. A subsequent deploy under a different
      // logical ID has no engine-state record and the tags don't match,
      // so adoption requires `adopt(true)`.
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
            return yield* ScheduleGroup("Different", {
              name: groupName,
              tags: { phase: "after" },
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.scheduleGroupName).toEqual(groupName);
      expect(takenOver.scheduleGroupArn).toEqual(original.scheduleGroupArn);

      // Adoption must rewrite the internal alchemy::id tag and the user
      // tag set so the group is now branded for the new logical ID.
      yield* waitForTagsMatch(takenOver.scheduleGroupArn, {
        phase: "after",
        "alchemy::id": "Different",
      });

      yield* stack.destroy();
      yield* assertGroupDeleted(groupName);
    }),
  { timeout: 360_000 },
);
