import { Region } from "@distilled.cloud/aws/Region";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { AlarmArn } from "./Alarm.ts";
import {
  createName,
  readResourceTags,
  retryConcurrent,
  updateResourceTags,
} from "./common.ts";

export type CompositeAlarmName = string;

export interface CompositeAlarmProps extends Omit<
  cloudwatch.PutCompositeAlarmInput,
  "AlarmName" | "Tags"
> {
  /**
   * Name of the composite alarm. If omitted, a unique name is generated.
   */
  name?: CompositeAlarmName;
  /**
   * Optional tags to apply to the composite alarm.
   */
  tags?: Record<string, string>;
}

export interface CompositeAlarm extends Resource<
  "AWS.CloudWatch.CompositeAlarm",
  CompositeAlarmProps,
  {
    alarmName: CompositeAlarmName;
    alarmArn: AlarmArn;
    stateValue: cloudwatch.StateValue | undefined;
    stateReason: string | undefined;
    compositeAlarm: cloudwatch.CompositeAlarm;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch composite alarm.
 *
 * @section Creating Composite Alarms
 * @example Composite Rule
 * ```typescript
 * const composite = yield* CompositeAlarm("HighSeverity", {
 *   AlarmRule: 'ALARM("HighErrors") OR ALARM("HighLatency")',
 * });
 * ```
 */
export const CompositeAlarm = Resource<CompositeAlarm>(
  "AWS.CloudWatch.CompositeAlarm",
);

export const CompositeAlarmProvider = () =>
  Provider.effect(
    CompositeAlarm,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

      const createAlarmName = (id: string, props: { name?: string } = {}) =>
        createName(id, props.name, 255);

      const alarmArn = (alarmName: string) =>
        `arn:aws:cloudwatch:${region}:${accountId}:alarm:${alarmName}` as AlarmArn;

      const readCompositeAlarm = Effect.fn(function* (alarmName: string) {
        const described = yield* cloudwatch.describeAlarms({
          AlarmNames: [alarmName],
          AlarmTypes: ["CompositeAlarm"],
        });
        const compositeAlarm = described.CompositeAlarms?.find(
          (candidate) => candidate.AlarmName === alarmName,
        );

        if (!compositeAlarm?.AlarmName || !compositeAlarm.AlarmArn) {
          return undefined;
        }

        const tags = yield* readResourceTags(compositeAlarm.AlarmArn).pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({}),
          ),
        );

        return {
          alarmName: compositeAlarm.AlarmName,
          alarmArn: compositeAlarm.AlarmArn as AlarmArn,
          stateValue: compositeAlarm.StateValue,
          stateReason: compositeAlarm.StateReason,
          compositeAlarm,
          tags,
        };
      });

      return {
        stables: ["alarmName", "alarmArn"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createAlarmName(id, olds);
          const newName = yield* createAlarmName(id, news);

          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.alarmName ?? (yield* createAlarmName(id, olds ?? {}));
          const state = yield* readCompositeAlarm(name);
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags))
            ? state
            : Unowned(state);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // Observe — pin the physical name from `output` if present so we
          // never rename an existing alarm; otherwise derive from desired
          // props. We never trust `output` blindly: if the alarm was
          // deleted out-of-band, `existing` is undefined and the upsert
          // recreates.
          const name = output?.alarmName ?? (yield* createAlarmName(id, news));
          const existing = yield* readCompositeAlarm(name);

          // Ensure — `putCompositeAlarm` is an upsert. We always send the
          // full desired config so the cloud converges to `news` whether
          // the alarm pre-existed (greenfield, drifted, or
          // out-of-band-deleted).
          yield* retryConcurrent(
            cloudwatch.putCompositeAlarm({
              ...news,
              AlarmName: name,
            }),
          );

          // Sync tags — diff OBSERVED cloud tags against desired so
          // adoption (foreign user tags) and out-of-band tag mutations
          // both converge correctly. `olds` is never the source of truth.
          const tags = yield* updateResourceTags({
            id,
            resourceArn: alarmArn(name),
            olds: existing?.tags,
            news: news.tags,
          });

          yield* session.note(alarmArn(name));

          const state = yield* readCompositeAlarm(name);
          if (!state) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled composite alarm '${name}'`),
            );
          }

          return {
            ...state,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // `DeleteAlarms` returns `ResourceNotFound` if the alarm is
          // already gone. Treat it as success so destroy is idempotent.
          yield* retryConcurrent(
            cloudwatch.deleteAlarms({
              AlarmNames: [output.alarmName],
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFound", () => Effect.void),
          );
        }),
      };
    }),
  );
