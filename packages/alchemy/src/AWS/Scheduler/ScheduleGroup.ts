import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import * as Schedule_ from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface ScheduleGroupProps {
  /**
   * Schedule group name. If omitted, Alchemy generates a deterministic name.
   */
  name?: string;
  /**
   * User-defined tags for the schedule group.
   */
  tags?: Record<string, string>;
}

/**
 * An EventBridge Scheduler schedule group.
 *
 * Schedule groups provide a namespace for schedules so higher-level helpers can
 * organize recurring jobs separately from one-shot or operational schedules.
 *
 * Unlike individual schedules, schedule groups DO support tagging, so alchemy
 * brands its groups with internal tags and uses tag presence to decide whether
 * a foreign group can be adopted (with `--adopt`/`adopt(true)`).
 *
 * @section Creating Schedule Groups
 * @example Basic Group
 * ```typescript
 * const group = yield* ScheduleGroup("Operations", {
 *   tags: {
 *     domain: "ops",
 *   },
 * });
 * ```
 */
export interface ScheduleGroup extends Resource<
  "AWS.Scheduler.ScheduleGroup",
  ScheduleGroupProps,
  {
    scheduleGroupArn: string;
    scheduleGroupName: string;
    state: string | undefined;
  },
  never,
  Providers
> {}

export const ScheduleGroup = Resource<ScheduleGroup>(
  "AWS.Scheduler.ScheduleGroup",
);

/**
 * Bounded-retry on `ConflictException`. EventBridge Scheduler returns
 * `ConflictException` when a group is in the transient `DELETING` /
 * `CREATING` state or when a concurrent mutation is in flight; the API
 * itself does not classify the error as retryable, so the provider retries
 * locally rather than tagging the distilled error as `RetryableError`
 * (which would also cover genuine name-collision conflicts).
 */
const conflictRetry = <A, E extends { _tag: string }, R>(
  eff: Effect.Effect<A, E, R>,
) =>
  eff.pipe(
    Effect.retry({
      while: (e) => e._tag === "ConflictException",
      schedule: Schedule_.spaced("2 seconds").pipe(
        Schedule_.both(Schedule_.recurs(15)),
      ),
    }),
  );

export const ScheduleGroupProvider = () =>
  Provider.effect(
    ScheduleGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: ScheduleGroupProps) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 64 });

      return {
        stables: ["scheduleGroupArn", "scheduleGroupName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds)) !==
            (yield* toName(id, news as ScheduleGroupProps))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const scheduleGroupName =
            output?.scheduleGroupName ?? (yield* toName(id, olds));
          const described = yield* scheduler
            .getScheduleGroup({ Name: scheduleGroupName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!described?.Arn || !described.Name) {
            return undefined;
          }

          const attrs = {
            scheduleGroupArn: described.Arn,
            scheduleGroupName: described.Name,
            state: described.State,
          };

          // Probe tags. Schedule groups support tagging, so a foreign
          // group can be detected by absence of our internal brand. If
          // tagging is unavailable (rare — `ResourceNotFoundException`
          // race), conservatively treat as unowned.
          const tagsResp = yield* scheduler
            .listTagsForResource({ ResourceArn: described.Arn })
            .pipe(
              Effect.map((r) =>
                Object.fromEntries(
                  (r.Tags ?? []).map((t) => [t.Key, t.Value]),
                ),
              ),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({} as Record<string, string>),
              ),
            );

          return (yield* hasAlchemyTags(id, tagsResp))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const scheduleGroupName =
            output?.scheduleGroupName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live group; gracefully handle missing.
          const observed = yield* scheduler
            .getScheduleGroup({ Name: scheduleGroupName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // Ensure — create if missing. Bounded-retry `ConflictException`
          // because a concurrent destroy may have left the group in
          // `DELETING` and AWS rejects re-creation until the deletion
          // completes. After a `ConflictException` window expires, the
          // create attempt itself succeeds.
          let groupArn: string | undefined = observed?.Arn;
          if (!groupArn) {
            groupArn = yield* scheduler
              .createScheduleGroup({
                Name: scheduleGroupName,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                conflictRetry,
                Effect.map((r) => r.ScheduleGroupArn),
              );
          }

          if (!groupArn) {
            // Re-read in case the create response did not echo the ARN.
            const reread = yield* scheduler
              .getScheduleGroup({ Name: scheduleGroupName })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (!reread?.Arn) {
              return yield* Effect.fail(
                new Error(
                  `Failed to read created ScheduleGroup '${scheduleGroupName}'`,
                ),
              );
            }
            groupArn = reread.Arn;
          }

          // Sync tags — diff against observed cloud tags so adoption
          // rewrites ownership tags and out-of-band tag drift converges.
          const observedTagsResp = yield* scheduler
            .listTagsForResource({ ResourceArn: groupArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({ Tags: [] as scheduler.Tag[] }),
              ),
            );
          const observedTags = Object.fromEntries(
            (observedTagsResp.Tags ?? []).map((t) => [t.Key, t.Value]),
          );
          const { removed, upsert } = diffTags(observedTags, desiredTags);

          if (removed.length > 0) {
            yield* scheduler
              .untagResource({
                ResourceArn: groupArn,
                TagKeys: removed,
              })
              .pipe(conflictRetry);
          }
          if (upsert.length > 0) {
            yield* scheduler
              .tagResource({
                ResourceArn: groupArn,
                Tags: upsert,
              })
              .pipe(conflictRetry);
          }

          // Re-read final state so we return the cloud's authoritative
          // `State` (e.g. `ACTIVE`) rather than guess.
          const finalState = yield* scheduler
            .getScheduleGroup({ Name: scheduleGroupName })
            .pipe(
              Effect.map((r) => r.State),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          yield* session.note(groupArn);

          return {
            scheduleGroupArn: groupArn,
            scheduleGroupName,
            state: finalState,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* scheduler
            .deleteScheduleGroup({ Name: output.scheduleGroupName })
            .pipe(
              conflictRetry,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
