import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export type OrganizationsTags = Record<string, string>;

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
  tags: organizations.Tag[] | undefined,
): OrganizationsTags =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

export const collectPages = <Page extends { NextToken?: string }, Item, E, R>(
  fetch: (nextToken?: string) => Effect.Effect<Page, E, R>,
  select: (page: Page) => ReadonlyArray<Item> | undefined,
) =>
  Effect.gen(function* () {
    const items: Item[] = [];
    let nextToken: string | undefined;

    do {
      const page = yield* fetch(nextToken);
      items.push(...(select(page) ?? []));
      nextToken = page.NextToken;
    } while (nextToken);

    return items;
  });

/**
 * The Organizations control plane serializes mutating calls per-org and
 * surfaces a small set of genuinely transient errors when two writes overlap
 * or the org is mid-finalize. Anything in this list is safe to retry without
 * additional context.
 */
const isRetryableOrganizationsError = (error: any) =>
  error?._tag === "ConcurrentModificationException" ||
  error?._tag === "TooManyRequestsException" ||
  error?._tag === "ServiceException" ||
  error?._tag === "FinalizingOrganizationException" ||
  error?._tag === "PolicyChangesInProgressException";

export const retryOrganizations = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: isRetryableOrganizationsError,
      schedule: Schedule.exponential(250).pipe(
        Schedule.both(Schedule.recurs(12)),
      ),
    }),
  );

/**
 * Bounded retry for delete-time "container is not empty" errors. After the
 * engine deletes child resources, the parent delete can still see them for a
 * short eventual-consistency window. We cap the retry so a genuine, persistent
 * dependency surfaces as a real error instead of hanging indefinitely.
 */
export const retryDeleteEmptiness = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (error: any) =>
        isRetryableOrganizationsError(error) ||
        error?._tag === "OrganizationNotEmptyException" ||
        error?._tag === "OrganizationalUnitNotEmptyException" ||
        error?._tag === "PolicyInUseException",
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

/**
 * Deterministic JSON stringifier for comparing policy documents. Object key
 * order isn't preserved by AWS round-trips, so the naive `JSON.stringify`
 * comparison can flap and trigger needless `updatePolicy` calls (or, worse,
 * mask real drift in the other direction).
 */
export const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(
            (value as Record<string, unknown>)[key],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const createManagedTags = Effect.fn(function* (
  id: string,
  tags: Record<string, string> | undefined,
) {
  return {
    ...(yield* createInternalTags(id)),
    ...(tags ?? {}),
  };
});

export const readResourceTags = (resourceId: string) =>
  collectPages(
    (NextToken) =>
      organizations.listTagsForResource({ ResourceId: resourceId, NextToken }),
    (page) => page.Tags,
  ).pipe(Effect.map(toTagRecord));

export const updateResourceTags = Effect.fn(function* ({
  id,
  resourceId,
  olds,
  news,
}: {
  id: string;
  resourceId: string;
  olds: Record<string, string> | undefined;
  news: Record<string, string> | undefined;
}) {
  const oldTags = yield* createManagedTags(id, olds);
  const newTags = yield* createManagedTags(id, news);
  const { removed, upsert } = diffTags(oldTags, newTags);

  if (removed.length > 0) {
    yield* retryOrganizations(
      organizations.untagResource({
        ResourceId: resourceId,
        TagKeys: removed,
      }),
    );
  }

  if (upsert.length > 0) {
    yield* retryOrganizations(
      organizations.tagResource({
        ResourceId: resourceId,
        Tags: upsert,
      }),
    );
  }

  return newTags;
});
