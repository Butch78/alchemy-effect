import { Region } from "distilled-aws/Region";
import * as eventbridge from "distilled-aws/eventbridge";
import * as Effect from "effect/Effect";

import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import { Account, type AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type {
  IncludeDetail,
  Level,
  LogConfig,
} from "distilled-aws/eventbridge";

export interface EventBusDeadLetterConfig {
  /** ARN of the SQS queue used as the dead-letter queue. */
  Arn?: Input<string>;
}

export interface EventBusProps {
  /**
   * Name of the event bus. Must match [/\.\-_A-Za-z0-9]+, 1-256 characters.
   * If omitted, a unique name will be generated.
   * Cannot be "default" — use the default event bus by omitting eventBusName on rules.
   */
  name?: string;

  /**
   * The partner event source to associate with this event bus.
   * Only used when creating a partner event bus.
   */
  eventSourceName?: string;

  /**
   * Description of the event bus.
   */
  description?: string;

  /**
   * The identifier of the KMS customer managed key for EventBridge to use
   * to encrypt events on this event bus.
   */
  kmsKeyIdentifier?: Input<string>;

  /**
   * Dead-letter queue configuration for undeliverable events.
   */
  deadLetterConfig?: EventBusDeadLetterConfig;

  /**
   * Logging configuration for the event bus.
   */
  logConfig?: eventbridge.LogConfig;

  /**
   * Tags to assign to the event bus.
   */
  tags?: Record<string, Input<string>>;
}

export interface EventBusAttrs<Props extends EventBusProps = EventBusProps> {
  /** The name of the event bus. */
  eventBusName: Props["name"] extends string ? Props["name"] : string;
  /** The ARN of the event bus. */
  eventBusArn: `arn:aws:events:${RegionID}:${AccountID}:event-bus/${string}`;
  /** Description of the event bus, if set. */
  description?: string;
}

/**
 * An Amazon EventBridge event bus for receiving and routing events.
 *
 * @section Creating Event Buses
 * @example Custom Event Bus
 * ```typescript
 * const bus = yield* EventBus("MyAppEvents", {
 *   description: "Custom event bus for my application",
 * });
 * ```
 *
 * @example Event Bus with Dead Letter Queue
 * ```typescript
 * const bus = yield* EventBus("ReliableBus", {
 *   deadLetterConfig: {
 *     Arn: yield* dlq.queueArn,
 *   },
 * });
 * ```
 *
 * @example Event Bus with KMS Encryption
 * ```typescript
 * const bus = yield* EventBus("EncryptedBus", {
 *   kmsKeyIdentifier: yield* key.keyArn(),
 * });
 * ```
 */
export const EventBus = Resource<{
  <const ID extends string, const Props extends EventBusProps = EventBusProps>(
    id: ID,
    props?: Props,
  ): Effect.Effect<EventBus<ID, Props>>;
}>("AWS.EventBridge.EventBus");

export interface EventBus<
  ID extends string = string,
  Props extends EventBusProps = EventBusProps,
> extends Resource<
  EventBus,
  "AWS.EventBridge.EventBus",
  ID,
  Props,
  EventBusAttrs<Input.Resolve<Props>>
> {}

export const EventBusProvider = () =>
  EventBus.provider.effect(
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;

      const createEventBusName = (id: string, props: { name?: string }) =>
        Effect.gen(function* () {
          if (props.name) {
            return props.name;
          }
          return yield* createPhysicalName({
            id,
            maxLength: 256,
          });
        });

      return {
        stables: ["eventBusName", "eventBusArn"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          const oldName = yield* createEventBusName(id, olds);
          const newName = yield* createEventBusName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if ((olds.eventSourceName ?? "") !== (news.eventSourceName ?? "")) {
            return { action: "replace" } as const;
          }
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const eventBusName = yield* createEventBusName(id, news);
          const internalTags = yield* createInternalTags(id);
          const allTags = {
            ...internalTags,
            ...(news.tags as Record<string, string> | undefined),
          };

          const eventBusArn =
            `arn:aws:events:${region}:${accountId}:event-bus/${eventBusName}` as const;

          yield* eventbridge
            .createEventBus({
              Name: eventBusName,
              EventSourceName: news.eventSourceName,
              Description: news.description,
              KmsKeyIdentifier: news.kmsKeyIdentifier as string | undefined,
              DeadLetterConfig: news.deadLetterConfig
                ? { Arn: news.deadLetterConfig.Arn as string | undefined }
                : undefined,
              LogConfig: news.logConfig,
              Tags: createTagsList(allTags),
            })
            .pipe(
              Effect.catchTag("ResourceAlreadyExistsException", () =>
                Effect.gen(function* () {
                  const { Tags } = yield* eventbridge.listTagsForResource({
                    ResourceARN: eventBusArn,
                  });
                  if (!(yield* hasAlchemyTags(id, Tags ?? []))) {
                    return yield* Effect.fail(
                      new eventbridge.ResourceAlreadyExistsException({
                        message: `Event bus '${eventBusName}' already exists and is not managed by alchemy`,
                      }),
                    );
                  }
                }),
              ),
            );

          yield* session.note(eventBusArn);

          return {
            eventBusName,
            eventBusArn,
            description: news.description,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const eventBusName = output.eventBusName;

          yield* eventbridge.updateEventBus({
            Name: eventBusName,
            Description: news.description,
            KmsKeyIdentifier: news.kmsKeyIdentifier as string | undefined,
            DeadLetterConfig: news.deadLetterConfig
              ? { Arn: news.deadLetterConfig.Arn as string | undefined }
              : undefined,
            LogConfig: news.logConfig,
          });

          const internalTags = yield* createInternalTags(id);
          const oldTags = {
            ...internalTags,
            ...(olds.tags as Record<string, string> | undefined),
          };
          const newTags = {
            ...internalTags,
            ...(news.tags as Record<string, string> | undefined),
          };
          const { removed, upsert } = diffTags(oldTags, newTags);

          if (removed.length > 0) {
            yield* eventbridge.untagResource({
              ResourceARN: output.eventBusArn,
              TagKeys: removed,
            });
          }

          if (upsert.length > 0) {
            yield* eventbridge.tagResource({
              ResourceARN: output.eventBusArn,
              Tags: upsert,
            });
          }

          yield* session.note(output.eventBusArn);
          return {
            ...output,
            description: news.description,
          };
        }),
        delete: Effect.fn(function* (input) {
          yield* eventbridge.deleteEventBus({
            Name: input.output.eventBusName,
          });
        }),
      };
    }),
  );
