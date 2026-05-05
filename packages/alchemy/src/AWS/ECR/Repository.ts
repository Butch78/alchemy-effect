import * as ecr from "@distilled.cloud/aws/ecr";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type RepositoryName = string;
export type RepositoryArn =
  `arn:aws:ecr:${RegionID}:${AccountID}:repository/${RepositoryName}`;
export type RepositoryUri =
  `${AccountID}.dkr.ecr.${RegionID}.amazonaws.com/${RepositoryName}`;

export interface RepositoryProps {
  /**
   * Name of the repository. If omitted, a unique name is generated.
   */
  repositoryName?: string;
  /**
   * Image tag mutability setting.
   * @default "MUTABLE"
   */
  imageTagMutability?: ecr.ImageTagMutability;
  /**
   * Whether enhanced image scanning should run on push.
   */
  scanOnPush?: boolean;
  /**
   * Optional lifecycle policy document JSON.
   */
  lifecyclePolicyText?: string;
  /**
   * User-defined tags to apply to the repository.
   */
  tags?: Record<string, string>;
  /**
   * If `true`, deleting the repository will also delete all of its images.
   * Without this flag, ECR will return `RepositoryNotEmptyException` when
   * the repository still contains images.
   * @default false
   */
  forceDelete?: boolean;
}

export interface Repository extends Resource<
  "AWS.ECR.Repository",
  RepositoryProps,
  {
    repositoryName: RepositoryName;
    repositoryArn: RepositoryArn;
    repositoryUri: RepositoryUri;
    registryId: string;
    imageTagMutability: ecr.ImageTagMutability;
    scanOnPush: boolean;
    lifecyclePolicyText?: string;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon ECR repository for container images.
 *
 * @section Creating Repositories
 * @example Task Image Repository
 * ```typescript
 * const repo = yield* Repository("TaskRepository", {
 *   scanOnPush: true,
 * });
 * ```
 */
export const Repository = Resource<Repository>("AWS.ECR.Repository");

export const RepositoryProvider = () =>
  Provider.effect(
    Repository,
    Effect.gen(function* () {
      const toRepositoryName = (
        id: string,
        props: { repositoryName?: string } = {},
      ) =>
        props.repositoryName
          ? Effect.succeed(props.repositoryName)
          : createPhysicalName({
              id,
              maxLength: 256,
              lowercase: true,
            });

      const fetchRepository = (repositoryName: string) =>
        ecr
          .describeRepositories({ repositoryNames: [repositoryName] })
          .pipe(
            Effect.map((res) => res.repositories?.[0]),
            Effect.catchTag("RepositoryNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const fetchLifecyclePolicy = (repositoryName: string) =>
        ecr
          .getLifecyclePolicy({ repositoryName })
          .pipe(
            Effect.map((r) => r.lifecyclePolicyText),
            Effect.catchTag("LifecyclePolicyNotFoundException", () =>
              Effect.succeed<string | undefined>(undefined),
            ),
            Effect.catchTag("RepositoryNotFoundException", () =>
              Effect.succeed<string | undefined>(undefined),
            ),
          );

      const fetchObservedTags = (repositoryArn: string) =>
        ecr
          .listTagsForResource({ resourceArn: repositoryArn })
          .pipe(
            Effect.map((res) =>
              Object.fromEntries(
                (res.tags ?? [])
                  .filter(
                    (t): t is { Key: string; Value: string } =>
                      typeof t.Key === "string" && typeof t.Value === "string",
                  )
                  .map((t) => [t.Key, t.Value]),
              ),
            ),
            Effect.catchTag("RepositoryNotFoundException", () =>
              Effect.succeed({} as Record<string, string>),
            ),
          );

      return {
        stables: [
          "repositoryArn",
          "repositoryName",
          "repositoryUri",
          "registryId",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toRepositoryName(id, olds ?? {})) !==
            (yield* toRepositoryName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const repositoryName =
            output?.repositoryName ?? (yield* toRepositoryName(id, olds ?? {}));
          const repository = yield* fetchRepository(repositoryName);
          if (!repository?.repositoryArn || !repository.repositoryUri) {
            return undefined;
          }
          const repositoryArn = repository.repositoryArn as RepositoryArn;
          const observedTags = yield* fetchObservedTags(repositoryArn);
          const lifecyclePolicyText =
            yield* fetchLifecyclePolicy(repositoryName);
          const attrs = {
            repositoryName,
            repositoryArn,
            repositoryUri: repository.repositoryUri as RepositoryUri,
            registryId: repository.registryId!,
            imageTagMutability:
              repository.imageTagMutability ??
              output?.imageTagMutability ??
              "MUTABLE",
            scanOnPush:
              repository.imageScanningConfiguration?.scanOnPush ??
              output?.scanOnPush ??
              false,
            lifecyclePolicyText,
            tags: observedTags,
          };
          return (yield* hasAlchemyTags(
            id,
            Object.entries(observedTags).map(([Key, Value]) => ({
              Key,
              Value,
            })),
          ))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const repositoryName = yield* toRepositoryName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredScanOnPush = news.scanOnPush ?? false;
          const desiredImageTagMutability =
            news.imageTagMutability ?? "MUTABLE";

          // Observe — fetch live cloud state. We never trust prior `output`
          // blindly: the repository may have been deleted out-of-band.
          let repository = yield* fetchRepository(repositoryName);

          // Ensure — create the repository if missing. Tolerate
          // `RepositoryAlreadyExistsException` as a race with a peer
          // reconciler: re-describe and continue with the sync path. The
          // re-describe itself can race with peer deletion, so swallow
          // `RepositoryNotFoundException` there too and let the next
          // reconcile loop recreate.
          if (!repository?.repositoryArn || !repository.repositoryUri) {
            const created = yield* ecr
              .createRepository({
                repositoryName,
                imageTagMutability: desiredImageTagMutability,
                imageScanningConfiguration: {
                  scanOnPush: desiredScanOnPush,
                },
                tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.map((res) => res.repository),
                Effect.catchTag("RepositoryAlreadyExistsException", () =>
                  fetchRepository(repositoryName),
                ),
              );
            repository = created;
            if (!repository?.repositoryArn || !repository.repositoryUri) {
              return yield* Effect.fail(
                new Error(
                  `Failed to create or read repository ${repositoryName}`,
                ),
              );
            }
          }

          const repositoryArn = repository.repositoryArn as RepositoryArn;

          // Sync image tag mutability — observed ↔ desired.
          if (
            (repository.imageTagMutability ?? "MUTABLE") !==
            desiredImageTagMutability
          ) {
            yield* ecr.putImageTagMutability({
              repositoryName,
              imageTagMutability: desiredImageTagMutability,
            });
          }

          // Sync image scanning configuration — observed ↔ desired.
          const observedScanOnPush =
            repository.imageScanningConfiguration?.scanOnPush ?? false;
          if (observedScanOnPush !== desiredScanOnPush) {
            yield* ecr.putImageScanningConfiguration({
              repositoryName,
              imageScanningConfiguration: { scanOnPush: desiredScanOnPush },
            });
          }

          // Sync lifecycle policy — diff observed cloud policy against
          // desired. Apply, leave, or delete as needed.
          const observedLifecyclePolicy =
            yield* fetchLifecyclePolicy(repositoryName);
          if (news.lifecyclePolicyText) {
            if (observedLifecyclePolicy !== news.lifecyclePolicyText) {
              yield* ecr.putLifecyclePolicy({
                repositoryName,
                lifecyclePolicyText: news.lifecyclePolicyText,
              });
            }
          } else if (observedLifecyclePolicy !== undefined) {
            yield* ecr
              .deleteLifecyclePolicy({ repositoryName })
              .pipe(
                Effect.catchTag("LifecyclePolicyNotFoundException", () =>
                  Effect.void,
                ),
              );
          }

          // Sync tags — diff observed cloud tags against desired so
          // adoption and out-of-band drift converge correctly.
          const observedTags = yield* fetchObservedTags(repositoryArn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* ecr.tagResource({
              resourceArn: repositoryArn,
              tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* ecr.untagResource({
              resourceArn: repositoryArn,
              tagKeys: removed,
            });
          }

          yield* session.note(repositoryArn);
          return {
            repositoryName,
            repositoryArn,
            repositoryUri: repository.repositoryUri as RepositoryUri,
            registryId: repository.registryId!,
            imageTagMutability: desiredImageTagMutability,
            scanOnPush: desiredScanOnPush,
            lifecyclePolicyText: news.lifecyclePolicyText,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          yield* ecr
            .deleteRepository({
              repositoryName: output.repositoryName,
              force: olds?.forceDelete ?? false,
            })
            .pipe(
              Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
