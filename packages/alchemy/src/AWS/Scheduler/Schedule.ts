import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import * as Schedule_ from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ScheduleProps {
  /**
   * Schedule name. If omitted, Alchemy generates a deterministic name.
   */
  name?: string;
  /**
   * Optional schedule group. Defaults to the AWS default group.
   */
  groupName?: Input<string>;
  /**
   * Required schedule expression, such as `rate(5 minutes)` or `cron(...)`.
   */
  scheduleExpression: string;
  /**
   * Optional start date.
   */
  startDate?: Date;
  /**
   * Optional end date.
   */
  endDate?: Date;
  /**
   * Optional description.
   */
  description?: string;
  /**
   * Optional timezone for cron or at expressions.
   */
  scheduleExpressionTimezone?: string;
  /**
   * Desired schedule state.
   */
  state?: string;
  /**
   * Optional KMS key ARN.
   */
  kmsKeyArn?: Input<string>;
  /**
   * Scheduler target configuration.
   */
  target: Input<scheduler.Target>;
  /**
   * Flexible time window configuration.
   */
  flexibleTimeWindow?: Input<scheduler.FlexibleTimeWindow>;
  /**
   * Action after a one-time schedule completes.
   */
  actionAfterCompletion?: string;
}

/**
 * An EventBridge Scheduler schedule.
 *
 * `Schedule` is the canonical time-based delivery primitive. High-level helpers
 * like `every`, `cron`, and `at` can synthesize the target role and scheduler
 * target configuration on top of this resource.
 *
 * EventBridge Scheduler does not support tagging individual schedules — only
 * schedule groups. Ownership of a `Schedule` is therefore identified by its
 * deterministic `(GroupName, Name)` tuple. Use a dedicated `ScheduleGroup` to
 * isolate alchemy-managed schedules from foreign schedules sharing the same
 * AWS account.
 *
 * @section Creating Schedules
 * @example Hourly Schedule
 * ```typescript
 * const schedule = yield* Schedule("HourlyJob", {
 *   scheduleExpression: "rate(1 hour)",
 *   target: {
 *     Arn: fn.functionArn,
 *     RoleArn: role.roleArn,
 *   },
 *   flexibleTimeWindow: {
 *     Mode: "OFF",
 *   },
 * });
 * ```
 */
export interface Schedule extends Resource<
  "AWS.Scheduler.Schedule",
  ScheduleProps,
  {
    scheduleArn: string;
    scheduleName: string;
    groupName: string;
    state: string | undefined;
  },
  never,
  Providers
> {}

export const Schedule = Resource<Schedule>("AWS.Scheduler.Schedule");

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

export const ScheduleProvider = () =>
  Provider.effect(
    Schedule,
    Effect.gen(function* () {
      const toName = (id: string, props: ScheduleProps) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 64 });

      return {
        stables: ["scheduleArn", "scheduleName", "groupName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }

          if ((olds.groupName ?? "default") !== (news.groupName ?? "default")) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const scheduleName =
            output?.scheduleName ?? (yield* toName(id, olds));
          const groupName =
            output?.groupName ??
            (olds.groupName as string | undefined) ??
            "default";
          const described = yield* scheduler
            .getSchedule({
              Name: scheduleName,
              GroupName: groupName !== "default" ? groupName : undefined,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!described?.Arn || !described.Name) {
            return undefined;
          }

          const attrs = {
            scheduleArn: described.Arn,
            scheduleName: described.Name,
            groupName: described.GroupName ?? groupName,
            state: described.State,
          };

          // EventBridge Scheduler does not support per-schedule tags, so
          // ownership cannot be confirmed via tag presence. If the engine has
          // never touched this schedule before (`output === undefined`),
          // require explicit `--adopt`/`adopt(true)` before claiming it.
          // Subsequent reconciles trust the persisted output and adopt.
          return output === undefined ? Unowned(attrs) : attrs;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const scheduleName =
            output?.scheduleName ?? (yield* toName(id, news));
          const groupName =
            output?.groupName ??
            (news.groupName as string | undefined) ??
            "default";
          const groupNameParam =
            groupName !== "default" ? groupName : undefined;

          const desiredConfig = {
            ScheduleExpression: news.scheduleExpression,
            StartDate: news.startDate,
            EndDate: news.endDate,
            Description: news.description,
            ScheduleExpressionTimezone: news.scheduleExpressionTimezone,
            State: news.state,
            KmsKeyArn: news.kmsKeyArn as string | undefined,
            Target: news.target as scheduler.Target,
            FlexibleTimeWindow: (news.flexibleTimeWindow as
              | scheduler.FlexibleTimeWindow
              | undefined) ?? {
              Mode: "OFF" as const,
            },
            ActionAfterCompletion: news.actionAfterCompletion,
          };

          // Observe — fetch live schedule. Cloud is authoritative; do not
          // trust `output` blindly because the schedule could have been
          // deleted out-of-band.
          const observed = yield* scheduler
            .getSchedule({ Name: scheduleName, GroupName: groupNameParam })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // Ensure / Sync — `createSchedule` and `updateSchedule` are both
          // full PUTs, so a single full-config call lands the desired state
          // either way. `ConflictException` from createSchedule is the AWS
          // signal that the name is taken; if we already had `output` we
          // know it's our schedule and fall through to update. From
          // updateSchedule, `ConflictException` indicates a concurrent
          // operation is in flight — bounded-retry rides it out.
          const arn = observed?.Arn
            ? yield* conflictRetry(
                scheduler.updateSchedule({
                  Name: scheduleName,
                  GroupName: groupNameParam,
                  ...desiredConfig,
                }),
              ).pipe(Effect.map((r) => r.ScheduleArn))
            : yield* scheduler
                .createSchedule({
                  Name: scheduleName,
                  GroupName: groupNameParam,
                  ...desiredConfig,
                })
                .pipe(
                  conflictRetry,
                  Effect.map((r) => r.ScheduleArn),
                );

          yield* session.note(arn);

          // Re-read final state so we return the cloud's authoritative State
          // rather than the request value.
          const finalState = yield* scheduler
            .getSchedule({ Name: scheduleName, GroupName: groupNameParam })
            .pipe(
              Effect.map((r) => r.State),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(news.state),
              ),
            );

          return {
            scheduleArn: arn,
            scheduleName,
            groupName,
            state: finalState,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* scheduler
            .deleteSchedule({
              Name: output.scheduleName,
              GroupName:
                output.groupName !== "default" ? output.groupName : undefined,
            })
            .pipe(
              conflictRetry,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
