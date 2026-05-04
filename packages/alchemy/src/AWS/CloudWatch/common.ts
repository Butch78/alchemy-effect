import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";

export type CloudWatchTags = Record<string, string>;

export const createName = (
  id: string,
  providedName: string | undefined,
  maxLength: number,
) =>
  providedName
    ? Effect.succeed(providedName)
    : createPhysicalName({
        id,
        maxLength,
      });

export const toTagRecord = (
  tags: cloudwatch.Tag[] | undefined,
): CloudWatchTags =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

export const createManagedTags = Effect.fn(function* (
  id: string,
  tags: Record<string, string> | undefined,
) {
  return {
    ...(yield* createInternalTags(id)),
    ...(tags ?? {}),
  };
});

/**
 * Brands the given attrs with {@link Unowned} when the resource's tags don't
 * match this stack/stage/logical-id. Use at the end of `read` so the engine
 * can route adoption decisions centrally.
 */
export const brandOwnership = Effect.fn(function* <T extends object>(
  id: string,
  attrs: T,
  tags: CloudWatchTags,
) {
  return Unowned.unless(yield* hasAlchemyTags(id, tags), attrs);
});

export const updateResourceTags = Effect.fn(function* ({
  id,
  resourceArn,
  olds,
  news,
}: {
  id: string;
  resourceArn: string;
  olds: Record<string, string> | undefined;
  news: Record<string, string> | undefined;
}) {
  const oldTags = olds ? yield* createManagedTags(id, olds) : {};
  const newTags = yield* createManagedTags(id, news);
  const { removed, upsert } = diffTags(oldTags, newTags);

  if (removed.length > 0) {
    yield* cloudwatch.untagResource({
      ResourceARN: resourceArn,
      TagKeys: removed,
    });
  }

  if (upsert.length > 0) {
    yield* cloudwatch.tagResource({
      ResourceARN: resourceArn,
      Tags: upsert,
    });
  }

  return newTags;
});

export const readResourceTags = (resourceArn: string) =>
  cloudwatch
    .listTagsForResource({
      ResourceARN: resourceArn,
    })
    .pipe(Effect.map((response) => toTagRecord(response.Tags)));

export const createTagList = (tags: Record<string, string>) =>
  createTagsList(tags);

export const retryConcurrent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (error: any) =>
        error?._tag === "ConcurrentModificationException" ||
        error?._tag === "ConflictException" ||
        error?._tag === "LimitExceededException",
      schedule: Schedule.exponential(200).pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );

const normalizeDimensions = (dimensions: cloudwatch.Dimension[] | undefined) =>
  [...(dimensions ?? [])].sort((a, b) =>
    `${a.Name ?? ""}:${a.Value ?? ""}`.localeCompare(
      `${b.Name ?? ""}:${b.Value ?? ""}`,
    ),
  );

const normalizeSingleMetricDetector = (
  input: Pick<
    cloudwatch.PutAnomalyDetectorInput,
    | "Namespace"
    | "MetricName"
    | "Dimensions"
    | "Stat"
    | "SingleMetricAnomalyDetector"
  >,
) => {
  const singleMetric = input.SingleMetricAnomalyDetector;
  return {
    Namespace: singleMetric?.Namespace ?? input.Namespace,
    MetricName: singleMetric?.MetricName ?? input.MetricName,
    Dimensions: normalizeDimensions(
      singleMetric?.Dimensions ?? input.Dimensions,
    ),
    Stat: singleMetric?.Stat ?? input.Stat,
  };
};

export const detectorIdentity = (
  input: Pick<
    cloudwatch.PutAnomalyDetectorInput,
    | "Namespace"
    | "MetricName"
    | "Dimensions"
    | "Stat"
    | "SingleMetricAnomalyDetector"
    | "MetricMathAnomalyDetector"
  >,
) =>
  JSON.stringify({
    SingleMetric: normalizeSingleMetricDetector(input),
    MetricMathAnomalyDetector: input.MetricMathAnomalyDetector,
  });

export const matchesDetectorIdentity = (
  detector: cloudwatch.AnomalyDetector,
  input: cloudwatch.PutAnomalyDetectorInput,
) => detectorIdentity(detector) === detectorIdentity(input);

export const sortByLogicalId = <T extends { LogicalId: string }>(items: T[]) =>
  [...items].sort((a, b) => a.LogicalId.localeCompare(b.LogicalId));
