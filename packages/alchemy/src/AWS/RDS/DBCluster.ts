import * as rds from "@distilled.cloud/aws/rds";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBClusterProps {
  /**
   * Cluster identifier. If omitted, Alchemy generates one.
   */
  dbClusterIdentifier?: string;
  /**
   * Aurora engine, such as `aurora-postgresql`.
   */
  engine: string;
  /**
   * Optional engine version.
   */
  engineVersion?: string;
  /**
   * Optional database name created with the cluster.
   */
  databaseName?: string;
  /**
   * Subnet group used by the cluster.
   */
  dbSubnetGroupName?: string;
  /**
   * Cluster parameter group name.
   */
  dbClusterParameterGroupName?: string;
  /**
   * Security groups attached to the cluster.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Optional listener port.
   */
  port?: number;
  /**
   * Enable IAM database authentication.
   */
  enableIAMDatabaseAuthentication?: boolean;
  /**
   * Enable Aurora Data API / HTTP endpoint support.
   */
  enableHttpEndpoint?: boolean;
  /**
   * Engine mode, for example `provisioned` or `serverless`.
   */
  engineMode?: string;
  /**
   * Serverless v2 scaling configuration.
   */
  serverlessV2ScalingConfiguration?: rds.ServerlessV2ScalingConfiguration;
  /**
   * Whether to copy tags to snapshots.
   */
  copyTagsToSnapshot?: boolean;
  /**
   * Whether to block accidental deletion.
   */
  deletionProtection?: boolean;
  /**
   * Whether the storage is encrypted.
   */
  storageEncrypted?: boolean;
  /**
   * Optional KMS key used for storage encryption.
   */
  kmsKeyId?: string;
  /**
   * Daily backup retention window in days.
   */
  backupRetentionPeriod?: number;
  /**
   * Preferred backup window in `hh24:mi-hh24:mi` UTC format.
   */
  preferredBackupWindow?: string;
  /**
   * Preferred weekly maintenance window in
   * `ddd:hh24:mi-ddd:hh24:mi` UTC format.
   */
  preferredMaintenanceWindow?: string;
  /**
   * Let RDS manage the master user password in Secrets Manager.
   */
  manageMasterUserPassword?: boolean;
  /**
   * Explicit master username when not deriving credentials from a secret.
   */
  masterUsername?: string;
  /**
   * Explicit master password when not deriving credentials from a secret.
   */
  masterUserPassword?: string;
  /**
   * Existing Secrets Manager secret ARN whose JSON payload contains
   * `username` and `password`.
   */
  masterUserSecretArn?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBCluster extends Resource<
  "AWS.RDS.DBCluster",
  DBClusterProps,
  {
    dbClusterIdentifier: string;
    dbClusterArn: string;
    dbSubnetGroupName: string | undefined;
    endpoint: string | undefined;
    readerEndpoint: string | undefined;
    port: number | undefined;
    engine: string;
    engineVersion: string | undefined;
    status: string | undefined;
    databaseName: string | undefined;
    masterUsername: string | undefined;
    masterUserSecretArn: string | undefined;
    vpcSecurityGroupIds: string[];
    httpEndpointEnabled: boolean | undefined;
    backupRetentionPeriod: number | undefined;
    preferredBackupWindow: string | undefined;
    preferredMaintenanceWindow: string | undefined;
    deletionProtection: boolean | undefined;
    copyTagsToSnapshot: boolean | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Aurora DB cluster.
 *
 * `DBCluster` owns the writer and reader endpoints, cluster-wide networking,
 * and Data API enablement. It can bootstrap master credentials directly or by
 * reading a Secrets Manager secret that contains `username` and `password`.
 */
export const DBCluster = Resource<DBCluster>("AWS.RDS.DBCluster");

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const resolveMasterCredentials = (props: DBClusterProps) =>
  Effect.gen(function* () {
    if (props.masterUserSecretArn) {
      const value = yield* secretsmanager.getSecretValue({
        SecretId: props.masterUserSecretArn,
      });
      const secretString = value.SecretString
        ? typeof value.SecretString === "string"
          ? value.SecretString
          : Redacted.value(value.SecretString)
        : undefined;
      const secret = secretString
        ? (JSON.parse(secretString) as {
            username?: string;
            password?: string;
          })
        : {};
      return {
        MasterUsername: props.masterUsername ?? secret.username,
        MasterUserPassword: props.masterUserPassword ?? secret.password,
      };
    }

    return {
      MasterUsername: props.masterUsername,
      MasterUserPassword: props.masterUserPassword,
    };
  });

const toAttrs = ({
  cluster,
  tags,
}: {
  cluster: rds.DBCluster;
  tags: Record<string, string>;
}): DBCluster["Attributes"] => ({
  dbClusterIdentifier: cluster.DBClusterIdentifier ?? "",
  dbClusterArn: cluster.DBClusterArn ?? "",
  dbSubnetGroupName: cluster.DBSubnetGroup,
  endpoint: cluster.Endpoint,
  readerEndpoint: cluster.ReaderEndpoint,
  port: cluster.Port,
  engine: cluster.Engine ?? "",
  engineVersion: cluster.EngineVersion,
  status: cluster.Status,
  databaseName: cluster.DatabaseName,
  masterUsername: cluster.MasterUsername,
  masterUserSecretArn: cluster.MasterUserSecret?.SecretArn,
  vpcSecurityGroupIds: (cluster.VpcSecurityGroups ?? []).flatMap((group) =>
    group.VpcSecurityGroupId ? [group.VpcSecurityGroupId] : [],
  ),
  httpEndpointEnabled: cluster.HttpEndpointEnabled,
  backupRetentionPeriod: cluster.BackupRetentionPeriod,
  preferredBackupWindow: cluster.PreferredBackupWindow,
  preferredMaintenanceWindow: cluster.PreferredMaintenanceWindow,
  deletionProtection: cluster.DeletionProtection,
  copyTagsToSnapshot: cluster.CopyTagsToSnapshot,
  tags,
});

// Status snapshot used to drive `waitForStableCluster`. The reconciler
// should only mutate or read attributes off a cluster that has reached
// one of these terminal-for-our-purposes states; otherwise control-plane
// calls fail with `InvalidDBClusterStateFault`.
const isStableClusterStatus = (status: string | undefined): boolean =>
  status === "available" ||
  status === "stopped" ||
  status === "incompatible-parameters" ||
  status === "incompatible-network" ||
  status === "failed";

class DBClusterUnreadable extends Data.TaggedError("DBClusterUnreadable")<{
  identifier: string;
  phase: "post-create" | "post-modify" | "wait-stable";
}> {}

class DBClusterNotStable extends Data.TaggedError("DBClusterNotStable")<{
  identifier: string;
  status: string | undefined;
}> {}

class DBClusterStillDeleting extends Data.TaggedError(
  "DBClusterStillDeleting",
)<{
  identifier: string;
}> {}

export const DBClusterProvider = () =>
  Provider.effect(
    DBCluster,
    Effect.gen(function* () {
      const toIdentifier = (id: string, props: DBClusterProps) =>
        props.dbClusterIdentifier
          ? Effect.succeed(props.dbClusterIdentifier)
          : createPhysicalName({ id, maxLength: 63 });

      const readCluster = Effect.fn(function* (clusterId: string) {
        const response = yield* rds
          .describeDBClusters({
            DBClusterIdentifier: clusterId,
          })
          .pipe(
            Effect.catchTag("DBClusterNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBClusters?.[0];
      });

      // Aurora cluster create / modify cycles run 5-15 minutes. Poll
      // every 10s for up to ~25 minutes — long enough for a serverless
      // v2 cluster + writer to converge while still bounded so a stuck
      // cluster surfaces instead of hanging forever.
      const stableStatePolicy = Schedule.fixed("10 seconds").pipe(
        Schedule.both(Schedule.recurs(150)),
      );

      // Modify-time control-plane retries: AWS returns
      // `InvalidDBClusterStateFault` when a cluster is mid-transition
      // (e.g. another modify is still applying). Ride that out with a
      // bounded retry so a transient race doesn't surface as failure.
      // `InvalidDBClusterStateFault` is context-dependent — we only
      // treat it as retryable here, where we know we're polling a
      // resource we expect to be transitioning.
      const controlPlaneRetryPolicy = Schedule.exponential("1 second").pipe(
        Schedule.both(Schedule.recurs(20)),
      );

      const isControlPlaneRetryable = (error: { _tag?: string }) =>
        error._tag === "InvalidDBClusterStateFault" ||
        error._tag === "DBClusterNotFoundFault";

      const retryControlPlane = <A, E extends { _tag?: string }, R>(
        effect: Effect.Effect<A, E, R>,
      ) =>
        effect.pipe(
          Effect.retry({
            while: isControlPlaneRetryable,
            schedule: controlPlaneRetryPolicy,
          }),
        );

      const waitForStableCluster = Effect.fn(function* (
        clusterId: string,
        session: { note: (msg: string) => Effect.Effect<void> },
      ) {
        return yield* Effect.gen(function* () {
          const cluster = yield* readCluster(clusterId);
          if (!cluster?.DBClusterArn) {
            yield* session.note(
              `DB cluster ${clusterId}: waiting for stable state, observed missing`,
            );
            return yield* Effect.fail(
              new DBClusterNotStable({
                identifier: clusterId,
                status: cluster?.Status,
              }),
            );
          }
          if (!isStableClusterStatus(cluster.Status)) {
            yield* session.note(
              `DB cluster ${clusterId}: waiting for stable state, observed ${cluster.Status ?? "UNKNOWN"}`,
            );
            return yield* Effect.fail(
              new DBClusterNotStable({
                identifier: clusterId,
                status: cluster.Status,
              }),
            );
          }
          return cluster;
        }).pipe(
          Effect.retry({
            while: (e) =>
              (e as { _tag?: string })._tag === "DBClusterNotStable",
            schedule: stableStatePolicy,
          }),
        );
      });

      const waitForClusterDeleted = Effect.fn(function* (clusterId: string) {
        return yield* readCluster(clusterId).pipe(
          Effect.flatMap((cluster) =>
            cluster
              ? Effect.fail(
                  new DBClusterStillDeleting({ identifier: clusterId }),
                )
              : Effect.void,
          ),
          Effect.retry({
            while: (e) => e._tag === "DBClusterStillDeleting",
            schedule: stableStatePolicy,
          }),
        );
      });

      // Compute the modify payload by diffing observed → desired. RDS
      // accepts a partial modify, so omitting fields whose desired value
      // matches observed avoids needlessly bumping
      // `PendingModifiedValues` and accidentally re-applying a stale
      // value the user fixed out-of-band. Returns `undefined` when
      // nothing has drifted, which signals the caller to skip
      // `modifyDBCluster` entirely.
      const computeModifyPayload = (
        observed: rds.DBCluster,
        news: DBClusterProps,
        masterUserPassword: string | Redacted.Redacted<string> | undefined,
      ): rds.ModifyDBClusterMessage | undefined => {
        const payload: rds.ModifyDBClusterMessage = {
          DBClusterIdentifier: observed.DBClusterIdentifier!,
          ApplyImmediately: true,
        };
        let dirty = false;
        const set = <K extends keyof rds.ModifyDBClusterMessage>(
          key: K,
          value: rds.ModifyDBClusterMessage[K],
        ) => {
          payload[key] = value;
          dirty = true;
        };
        if (
          news.engineVersion !== undefined &&
          news.engineVersion !== observed.EngineVersion
        ) {
          set("EngineVersion", news.engineVersion);
          set("AllowMajorVersionUpgrade", true);
        }
        if (news.dbClusterParameterGroupName !== undefined) {
          const observedGroup = observed.DBClusterParameterGroup;
          if (news.dbClusterParameterGroupName !== observedGroup) {
            set("DBClusterParameterGroupName", news.dbClusterParameterGroupName);
          }
        }
        if (news.vpcSecurityGroupIds !== undefined) {
          const observedSGs = (observed.VpcSecurityGroups ?? [])
            .flatMap((sg) =>
              sg.VpcSecurityGroupId ? [sg.VpcSecurityGroupId] : [],
            )
            .sort();
          const desiredSGs = [...news.vpcSecurityGroupIds].sort();
          if (
            observedSGs.length !== desiredSGs.length ||
            observedSGs.some((id, i) => id !== desiredSGs[i])
          ) {
            set("VpcSecurityGroupIds", news.vpcSecurityGroupIds);
          }
        }
        if (news.port !== undefined && news.port !== observed.Port) {
          set("Port", news.port);
        }
        if (
          news.enableIAMDatabaseAuthentication !== undefined &&
          news.enableIAMDatabaseAuthentication !==
            observed.IAMDatabaseAuthenticationEnabled
        ) {
          set(
            "EnableIAMDatabaseAuthentication",
            news.enableIAMDatabaseAuthentication,
          );
        }
        if (
          news.enableHttpEndpoint !== undefined &&
          news.enableHttpEndpoint !== observed.HttpEndpointEnabled
        ) {
          set("EnableHttpEndpoint", news.enableHttpEndpoint);
        }
        if (news.serverlessV2ScalingConfiguration !== undefined) {
          const observedScaling = observed.ServerlessV2ScalingConfiguration;
          if (
            !observedScaling ||
            observedScaling.MinCapacity !==
              news.serverlessV2ScalingConfiguration.MinCapacity ||
            observedScaling.MaxCapacity !==
              news.serverlessV2ScalingConfiguration.MaxCapacity
          ) {
            set(
              "ServerlessV2ScalingConfiguration",
              news.serverlessV2ScalingConfiguration,
            );
          }
        }
        if (
          news.copyTagsToSnapshot !== undefined &&
          news.copyTagsToSnapshot !== observed.CopyTagsToSnapshot
        ) {
          set("CopyTagsToSnapshot", news.copyTagsToSnapshot);
        }
        if (
          news.deletionProtection !== undefined &&
          news.deletionProtection !== observed.DeletionProtection
        ) {
          set("DeletionProtection", news.deletionProtection);
        }
        if (
          news.backupRetentionPeriod !== undefined &&
          news.backupRetentionPeriod !== observed.BackupRetentionPeriod
        ) {
          set("BackupRetentionPeriod", news.backupRetentionPeriod);
        }
        if (
          news.preferredBackupWindow !== undefined &&
          news.preferredBackupWindow !== observed.PreferredBackupWindow
        ) {
          set("PreferredBackupWindow", news.preferredBackupWindow);
        }
        if (
          news.preferredMaintenanceWindow !== undefined &&
          news.preferredMaintenanceWindow !==
            observed.PreferredMaintenanceWindow
        ) {
          set("PreferredMaintenanceWindow", news.preferredMaintenanceWindow);
        }
        if (masterUserPassword !== undefined) {
          // Always apply when a fresh password is materialised — RDS
          // doesn't expose the current password to compare against.
          set("MasterUserPassword", masterUserPassword);
        }
        return dirty ? payload : undefined;
      };

      return {
        stables: ["dbClusterArn", "dbClusterIdentifier"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toIdentifier(id, olds ?? ({} as DBClusterProps))) !==
            (yield* toIdentifier(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if (olds?.engine !== news.engine) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.dbClusterIdentifier ??
            (yield* toIdentifier(
              id,
              olds ?? ({ engine: "" } as DBClusterProps),
            ));
          const cluster = yield* readCluster(identifier);
          if (!cluster?.DBClusterArn) {
            return undefined;
          }
          return toAttrs({
            cluster,
            tags: toTagRecord(cluster.TagList),
          });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const identifier =
            output?.dbClusterIdentifier ?? (yield* toIdentifier(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const credentials = yield* resolveMasterCredentials(news);

          // Observe — fetch live cluster state. We never trust `output`
          // blindly: the cluster may have been deleted out-of-band, or
          // this may be a first-time reconcile after adoption.
          let observed = yield* readCluster(identifier);

          // Ensure — create the cluster if it's missing. Tolerate
          // `DBClusterAlreadyExistsFault` as a race with a peer
          // reconciler (e.g. retry after state-persistence failure).
          if (!observed?.DBClusterArn) {
            yield* rds
              .createDBCluster({
                DBClusterIdentifier: identifier,
                Engine: news.engine,
                EngineVersion: news.engineVersion,
                DatabaseName: news.databaseName,
                DBSubnetGroupName: news.dbSubnetGroupName,
                DBClusterParameterGroupName: news.dbClusterParameterGroupName,
                VpcSecurityGroupIds: news.vpcSecurityGroupIds,
                Port: news.port,
                EnableIAMDatabaseAuthentication:
                  news.enableIAMDatabaseAuthentication,
                EnableHttpEndpoint: news.enableHttpEndpoint,
                EngineMode: news.engineMode,
                ServerlessV2ScalingConfiguration:
                  news.serverlessV2ScalingConfiguration,
                CopyTagsToSnapshot: news.copyTagsToSnapshot,
                DeletionProtection: news.deletionProtection,
                StorageEncrypted: news.storageEncrypted,
                KmsKeyId: news.kmsKeyId,
                ManageMasterUserPassword: news.manageMasterUserPassword,
                BackupRetentionPeriod: news.backupRetentionPeriod,
                PreferredBackupWindow: news.preferredBackupWindow,
                PreferredMaintenanceWindow: news.preferredMaintenanceWindow,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
                ...credentials,
              })
              .pipe(
                Effect.catchTag(
                  "DBClusterAlreadyExistsFault",
                  () => Effect.void,
                ),
              );

            observed = yield* waitForStableCluster(identifier, session);
            if (!observed?.DBClusterArn) {
              return yield* Effect.fail(
                new DBClusterUnreadable({
                  identifier,
                  phase: "post-create",
                }),
              );
            }
          } else {
            // We observed an existing cluster. If it's mid-transition
            // (creating/modifying/backing-up/etc.), wait for a stable
            // status before issuing modify so we don't trip
            // `InvalidDBClusterStateFault`.
            if (!isStableClusterStatus(observed.Status)) {
              yield* session.note(
                `DB cluster ${identifier}: observed in ${observed.Status ?? "UNKNOWN"} state, waiting for stable before sync`,
              );
              observed = yield* waitForStableCluster(identifier, session);
            }

            // Sync mutable cluster config — only call modify when
            // observed config drifts from desired. Otherwise the call
            // is a no-op that still triggers a `modifying` transition.
            const modifyPayload = computeModifyPayload(
              observed,
              news,
              credentials.MasterUserPassword,
            );
            if (modifyPayload) {
              yield* retryControlPlane(rds.modifyDBCluster(modifyPayload));
              observed = yield* waitForStableCluster(identifier, session);
              if (!observed?.DBClusterArn) {
                return yield* Effect.fail(
                  new DBClusterUnreadable({
                    identifier,
                    phase: "post-modify",
                  }),
                );
              }
            }
          }

          const dbClusterArn = observed.DBClusterArn ?? "";

          // Sync tags — diff observed cloud tags against desired so the
          // reconciler converges regardless of what was on the resource
          // before (initial create, adoption, or drift).
          const observedTags = toTagRecord(observed.TagList);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbClusterArn) {
            yield* retryControlPlane(
              rds.addTagsToResource({
                ResourceName: dbClusterArn,
                Tags: upsert,
              }),
            );
          }
          if (removed.length > 0 && dbClusterArn) {
            yield* retryControlPlane(
              rds.removeTagsFromResource({
                ResourceName: dbClusterArn,
                TagKeys: removed,
              }),
            );
          }

          yield* session.note(dbClusterArn || identifier);
          return toAttrs({ cluster: observed, tags: desiredTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          // Tolerate concurrent or already-issued deletes by retrying
          // through `InvalidDBClusterStateFault` (cluster still
          // transitioning into a delete-eligible state) up to the same
          // bounded budget the reconciler uses.
          yield* rds
            .deleteDBCluster({
              DBClusterIdentifier: output.dbClusterIdentifier,
              SkipFinalSnapshot: true,
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "InvalidDBClusterStateFault",
                schedule: controlPlaneRetryPolicy,
              }),
              Effect.catchTag("DBClusterNotFoundFault", () => Effect.void),
            );

          // Wait for the cluster to actually leave RDS — otherwise a
          // subsequent reconcile (or a replace) races against the
          // `deleting` state and fails with InvalidDBClusterStateFault.
          yield* waitForClusterDeleted(output.dbClusterIdentifier);
        }),
      };
    }),
  );
