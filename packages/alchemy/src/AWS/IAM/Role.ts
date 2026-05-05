import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyDocument } from "./Policy.ts";
import {
  parsePolicyDocument,
  stringifyPolicyDocument,
  toTagRecord,
} from "./common.ts";

/**
 * IAM control-plane errors that are safe to retry. `ConcurrentModification`
 * is documented as transient — IAM serializes mutations to a role and
 * surfaces this when two writes overlap. `EntityTemporarilyUnmodifiable`
 * appears during cross-region propagation right after a `createRole`.
 */
const isRetryableIamControlPlaneError = (error: { _tag?: string }) =>
  error._tag === "ConcurrentModificationException" ||
  error._tag === "EntityTemporarilyUnmodifiableException";

/**
 * Retry an IAM mutation against `ConcurrentModification` /
 * `EntityTemporarilyUnmodifiable`. Capped so a service that stays in this
 * state surfaces instead of looping forever.
 */
const retryIamMutation = <A, E extends { _tag?: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: isRetryableIamControlPlaneError,
      schedule: Schedule.exponential(250).pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );

/**
 * IAM is eventually consistent globally. Right after `createRole` the
 * subsequent attach/put/tag calls can briefly hit `NoSuchEntity` because
 * they land on an IAM host that hasn't seen the create yet. Retry that
 * narrow window with a short bounded schedule.
 */
const retryNoSuchEntityAfterCreate = <A, E extends { _tag?: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) =>
        e._tag === "NoSuchEntityException" ||
        isRetryableIamControlPlaneError(e),
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );

export type RoleName = string;
export type RoleArn = `arn:aws:iam::${AccountID}:role/${RoleName}`;

export interface RoleProps {
  /**
   * Name of the role. If omitted, a unique name will be generated.
   */
  roleName?: string;
  /**
   * Optional IAM path prefix for the role.
   * @default "/"
   */
  path?: string;
  /**
   * IAM trust policy for the role.
   */
  assumeRolePolicyDocument: PolicyDocument;
  /**
   * Managed policy ARNs to attach to the role.
   */
  managedPolicyArns?: string[];
  /**
   * Inline policies keyed by policy name.
   */
  inlinePolicies?: Record<string, PolicyDocument>;
  /**
   * Optional description for the role.
   */
  description?: string;
  /**
   * Maximum session duration in seconds.
   */
  maxSessionDuration?: number;
  /**
   * Optional managed policy ARN used as the permissions boundary.
   */
  permissionsBoundary?: string;
  /**
   * User-defined tags to apply to the role.
   */
  tags?: Record<string, string>;
}

export interface Role extends Resource<
  "AWS.IAM.Role",
  RoleProps,
  {
    roleArn: RoleArn;
    roleName: RoleName;
    roleId: string | undefined;
    path: string | undefined;
    assumeRolePolicyDocument: PolicyDocument;
    managedPolicyArns: string[];
    inlinePolicies: Record<string, PolicyDocument>;
    description: string | undefined;
    maxSessionDuration: number | undefined;
    permissionsBoundary: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An IAM role for AWS services and runtimes.
 *
 * @section Creating Roles
 * @example ECS Task Role
 * ```typescript
 * const role = yield* Role("TaskRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "ecs-tasks.amazonaws.com" },
 *       Action: ["sts:AssumeRole"],
 *     }],
 *   },
 * });
 * ```
 */
export const Role = Resource<Role>("AWS.IAM.Role");

export const RoleProvider = () =>
  Provider.effect(
    Role,
    Effect.gen(function* () {
      yield* AWSEnvironment;

      const toRoleName = (id: string, props: { roleName?: string } = {}) =>
        props.roleName
          ? Effect.succeed(props.roleName)
          : createPhysicalName({ id, maxLength: 64 });

      const readInlinePolicies = Effect.fn(function* (roleName: string) {
        const listed = yield* iam.listRolePolicies({
          RoleName: roleName,
        });
        const entries = yield* Effect.all(
          (listed.PolicyNames ?? []).map((policyName) =>
            iam
              .getRolePolicy({
                RoleName: roleName,
                PolicyName: policyName,
              })
              .pipe(
                Effect.map(
                  (response) =>
                    [
                      policyName,
                      parsePolicyDocument(response.PolicyDocument),
                    ] as const,
                ),
                Effect.catchTag("NoSuchEntityException", () =>
                  Effect.succeed([policyName, undefined] as const),
                ),
              ),
          ),
        );
        return Object.fromEntries(
          entries.filter(
            (entry): entry is [string, PolicyDocument] =>
              entry[1] !== undefined,
          ),
        );
      });

      const readManagedPolicies = Effect.fn(function* (roleName: string) {
        const listed = yield* iam.listAttachedRolePolicies({
          RoleName: roleName,
        });
        return (listed.AttachedPolicies ?? [])
          .map((policy) => policy.PolicyArn)
          .filter(
            (policyArn): policyArn is string => typeof policyArn === "string",
          );
      });

      const readTags = Effect.fn(function* (roleName: string) {
        const listed = yield* iam.listRoleTags({
          RoleName: roleName,
        });
        return toTagRecord(listed.Tags);
      });

      const syncManagedPolicies = Effect.fn(function* ({
        roleName,
        olds,
        news,
        justCreated,
      }: {
        roleName: string;
        olds: string[];
        news: string[];
        justCreated: boolean;
      }) {
        const oldSet = new Set(olds);
        const newSet = new Set(news);

        for (const policyArn of news) {
          if (!oldSet.has(policyArn)) {
            const attach = iam.attachRolePolicy({
              RoleName: roleName,
              PolicyArn: policyArn,
            });
            yield* justCreated
              ? retryNoSuchEntityAfterCreate(attach)
              : retryIamMutation(attach);
          }
        }

        for (const policyArn of olds) {
          if (!newSet.has(policyArn)) {
            yield* retryIamMutation(
              iam.detachRolePolicy({
                RoleName: roleName,
                PolicyArn: policyArn,
              }),
            ).pipe(
              Effect.catchTag("NoSuchEntityException", () => Effect.void),
            );
          }
        }
      });

      const syncInlinePolicies = Effect.fn(function* ({
        roleName,
        olds,
        news,
        justCreated,
      }: {
        roleName: string;
        olds: Record<string, PolicyDocument>;
        news: Record<string, PolicyDocument>;
        justCreated: boolean;
      }) {
        for (const [policyName, document] of Object.entries(news)) {
          if (
            JSON.stringify(olds[policyName] ?? null) !==
            JSON.stringify(document)
          ) {
            const put = iam.putRolePolicy({
              RoleName: roleName,
              PolicyName: policyName,
              PolicyDocument: stringifyPolicyDocument(document),
            });
            yield* justCreated
              ? retryNoSuchEntityAfterCreate(put)
              : retryIamMutation(put);
          }
        }

        for (const policyName of Object.keys(olds)) {
          if (!(policyName in news)) {
            yield* retryIamMutation(
              iam.deleteRolePolicy({
                RoleName: roleName,
                PolicyName: policyName,
              }),
            ).pipe(
              Effect.catchTag("NoSuchEntityException", () => Effect.void),
            );
          }
        }
      });

      return {
        stables: ["roleArn", "roleName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toRoleName(id, olds ?? {})) !==
            (yield* toRoleName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if ((olds?.path ?? "/") !== (news.path ?? "/")) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const roleName =
            output?.roleName ?? (yield* toRoleName(id, olds ?? {}));
          const role = yield* iam
            .getRole({
              RoleName: roleName,
            })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!role?.Role) {
            return undefined;
          }

          const [managedPolicyArns, inlinePolicies, tags] = yield* Effect.all([
            readManagedPolicies(roleName),
            readInlinePolicies(roleName),
            readTags(roleName),
          ]);

          const assumeRolePolicyDocument =
            parsePolicyDocument(role.Role.AssumeRolePolicyDocument) ??
            output?.assumeRolePolicyDocument;
          if (!assumeRolePolicyDocument) {
            return undefined;
          }

          const attrs = {
            roleArn: role.Role.Arn as RoleArn,
            roleName: role.Role.RoleName,
            roleId: role.Role.RoleId,
            path: role.Role.Path,
            assumeRolePolicyDocument,
            managedPolicyArns,
            inlinePolicies,
            description: role.Role.Description,
            maxSessionDuration: role.Role.MaxSessionDuration,
            permissionsBoundary:
              role.Role.PermissionsBoundary?.PermissionsBoundaryArn,
            tags,
          };
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const roleName = output?.roleName ?? (yield* toRoleName(id, news));
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — read the role from IAM. Absence is signalled by
          // `NoSuchEntityException`; ownership has already been verified
          // upstream so adopting a `Unowned` role is the engine's call.
          let observedRole = yield* iam
            .getRole({ RoleName: roleName })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );

          // Ensure — create the role when missing. A peer reconciler may
          // have created it concurrently; tolerate that race by reading
          // the existing role.
          let justCreated = false;
          if (!observedRole?.Role) {
            observedRole = yield* iam
              .createRole({
                Path: news.path,
                RoleName: roleName,
                AssumeRolePolicyDocument: stringifyPolicyDocument(
                  news.assumeRolePolicyDocument,
                ),
                Description: news.description,
                MaxSessionDuration: news.maxSessionDuration,
                PermissionsBoundary: news.permissionsBoundary,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("EntityAlreadyExistsException", () =>
                  iam.getRole({ RoleName: roleName }),
                ),
              );
            justCreated = true;
          }

          const observedAssumePolicy = parsePolicyDocument(
            observedRole.Role?.AssumeRolePolicyDocument,
          );
          const observedDescription = observedRole.Role?.Description;
          const observedMaxSessionDuration =
            observedRole.Role?.MaxSessionDuration;
          const observedPermissionsBoundary =
            observedRole.Role?.PermissionsBoundary?.PermissionsBoundaryArn;

          // Sync assume-role policy — only call updateAssumeRolePolicy
          // when the document actually differs.
          if (
            JSON.stringify(observedAssumePolicy ?? null) !==
            JSON.stringify(news.assumeRolePolicyDocument)
          ) {
            yield* retryIamMutation(
              iam.updateAssumeRolePolicy({
                RoleName: roleName,
                PolicyDocument: stringifyPolicyDocument(
                  news.assumeRolePolicyDocument,
                ),
              }),
            );
          }

          // Sync description / maxSessionDuration via updateRole.
          if (
            observedDescription !== news.description ||
            observedMaxSessionDuration !== news.maxSessionDuration
          ) {
            yield* retryIamMutation(
              iam.updateRole({
                RoleName: roleName,
                Description: news.description,
                MaxSessionDuration: news.maxSessionDuration,
              }),
            );
          }

          // Sync permissions boundary — put when desired, delete when
          // cleared, no-op when unchanged.
          if (news.permissionsBoundary !== observedPermissionsBoundary) {
            if (news.permissionsBoundary) {
              yield* retryIamMutation(
                iam.putRolePermissionsBoundary({
                  RoleName: roleName,
                  PermissionsBoundary: news.permissionsBoundary,
                }),
              );
            } else if (observedPermissionsBoundary) {
              yield* retryIamMutation(
                iam.deleteRolePermissionsBoundary({
                  RoleName: roleName,
                }),
              ).pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
            }
          }

          // Sync managed and inline policies — observe the live state
          // and apply only the delta. This is robust to manual edits in
          // the AWS console and to adoption.
          const [observedManagedPolicies, observedInlinePolicies] =
            yield* Effect.all([
              readManagedPolicies(roleName),
              readInlinePolicies(roleName),
            ]);
          yield* syncManagedPolicies({
            roleName,
            olds: observedManagedPolicies,
            news: news.managedPolicyArns ?? [],
            justCreated,
          });
          yield* syncInlinePolicies({
            roleName,
            olds: observedInlinePolicies,
            news: news.inlinePolicies ?? {},
            justCreated,
          });

          // Sync tags against the cloud's actual tags so adoption /
          // out-of-band tag changes converge.
          const observedTags = yield* readTags(roleName);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* retryIamMutation(
              iam.tagRole({
                RoleName: roleName,
                Tags: upsert,
              }),
            );
          }
          if (removed.length > 0) {
            yield* retryIamMutation(
              iam.untagRole({
                RoleName: roleName,
                TagKeys: removed,
              }),
            );
          }

          // Re-read for fresh attributes after all mutations.
          const liveRole = yield* iam.getRole({ RoleName: roleName });
          const roleArn = (liveRole.Role?.Arn ??
            observedRole.Role?.Arn ??
            `arn:aws:iam::${(yield* AWSEnvironment).accountId}:role/${roleName}`) as RoleArn;

          yield* session.note(roleArn);
          return {
            roleArn,
            roleName: liveRole.Role?.RoleName ?? roleName,
            roleId: liveRole.Role?.RoleId ?? observedRole.Role?.RoleId,
            path:
              liveRole.Role?.Path ??
              observedRole.Role?.Path ??
              news.path ??
              "/",
            assumeRolePolicyDocument: news.assumeRolePolicyDocument,
            managedPolicyArns: news.managedPolicyArns ?? [],
            inlinePolicies: news.inlinePolicies ?? {},
            description: liveRole.Role?.Description ?? news.description,
            maxSessionDuration:
              liveRole.Role?.MaxSessionDuration ?? news.maxSessionDuration,
            permissionsBoundary:
              liveRole.Role?.PermissionsBoundary?.PermissionsBoundaryArn ??
              news.permissionsBoundary,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryIamMutation(
            iam.deleteRolePermissionsBoundary({
              RoleName: output.roleName,
            }),
          ).pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));

          yield* iam
            .listRolePolicies({ RoleName: output.roleName })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed({ PolicyNames: [] as string[] }),
              ),
            )
            .pipe(
              Effect.flatMap((policies) =>
                Effect.all(
                  (policies.PolicyNames ?? []).map((policyName) =>
                    retryIamMutation(
                      iam.deleteRolePolicy({
                        RoleName: output.roleName,
                        PolicyName: policyName,
                      }),
                    ).pipe(
                      Effect.catchTag(
                        "NoSuchEntityException",
                        () => Effect.void,
                      ),
                    ),
                  ),
                ),
              ),
            );

          yield* iam
            .listAttachedRolePolicies({ RoleName: output.roleName })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed({ AttachedPolicies: [] }),
              ),
            )
            .pipe(
              Effect.flatMap((policies) =>
                Effect.all(
                  (policies.AttachedPolicies ?? []).map((policy) =>
                    retryIamMutation(
                      iam.detachRolePolicy({
                        RoleName: output.roleName,
                        PolicyArn: policy.PolicyArn!,
                      }),
                    ).pipe(
                      Effect.catchTag(
                        "NoSuchEntityException",
                        () => Effect.void,
                      ),
                    ),
                  ),
                ),
              ),
            );

          // `DeleteConflict` happens when something still references the
          // role (e.g. an instance profile that hasn't finished detaching).
          // It usually clears within a few seconds — bound the retry so a
          // genuine, persistent reference surfaces.
          yield* iam
            .deleteRole({
              RoleName: output.roleName,
            })
            .pipe(
              Effect.retry({
                while: (e) =>
                  e._tag === "DeleteConflictException" ||
                  isRetryableIamControlPlaneError(e),
                schedule: Schedule.exponential(500).pipe(
                  Schedule.both(Schedule.recurs(10)),
                ),
              }),
              Effect.catchTag("NoSuchEntityException", () => Effect.void),
            );
        }),
      };
    }),
  );
