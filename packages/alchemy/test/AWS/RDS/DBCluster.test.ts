import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Vpc } from "@/AWS/EC2";
import { SecurityGroup } from "@/AWS/EC2/SecurityGroup";
import { Subnet } from "@/AWS/EC2/Subnet";
import {
  DBCluster,
  type DBClusterProps,
  DBSubnetGroup,
} from "@/AWS/RDS";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as RDS from "@distilled.cloud/aws/rds";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Aurora cluster provisioning is slow and expensive — these tests are
// skipped in CI and intended to be unskipped by hand against an
// isolated test account when verifying the reconciler. Each timeout is
// 25 minutes, which is enough for an Aurora Serverless v2 cluster to
// reach `available`, plus headroom for the modify and delete phases.

const RDS_TIMEOUT = 1_500_000;

describe("AWS.RDS.DBCluster", () => {
  // ── Lifecycle convergence ────────────────────────────────────────────
  //
  // Each test runs `destroy → deploy → ... → destroy` and asserts that
  // the reconciler converges every step regardless of starting state.
  // Together they cover: idempotency, drift recovery via
  // `modifyDBCluster`, replace on stable-prop change, in-place engine
  // version upgrade, double-destroy idempotency, and tag re-write on
  // adopt(true) takeover.

  test.provider.skip(
    "redeploy with same props is a no-op (reconcile is idempotent)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const network = networkFixture();
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* serverlessCluster("Idempotent", {});
          }),
        );

        const second = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* serverlessCluster("Idempotent", {});
          }),
        );
        expect(second.dbClusterArn).toEqual(initial.dbClusterArn);
        expect(second.dbClusterIdentifier).toEqual(initial.dbClusterIdentifier);

        const described = yield* RDS.describeDBClusters({
          DBClusterIdentifier: second.dbClusterIdentifier,
        });
        expect(described.DBClusters?.[0]?.Status).toEqual("available");

        yield* stack.destroy();
        yield* assertDBClusterDeleted(initial.dbClusterIdentifier);
      }),
    { timeout: RDS_TIMEOUT },
  );

  test.provider.skip(
    "reconcile resets backupRetentionPeriod / preferredBackupWindow mutated out-of-band",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const network = networkFixture();
        const cluster = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* serverlessCluster("Drift", {
              backupRetentionPeriod: 1,
              preferredBackupWindow: "03:00-04:00",
              copyTagsToSnapshot: true,
            });
          }),
        );

        // Mutate every reconciled aspect out-of-band via the raw RDS SDK.
        yield* RDS.modifyDBCluster({
          DBClusterIdentifier: cluster.dbClusterIdentifier,
          BackupRetentionPeriod: 7,
          PreferredBackupWindow: "10:00-11:00",
          CopyTagsToSnapshot: false,
          ApplyImmediately: true,
        });
        yield* RDS.removeTagsFromResource({
          ResourceName: cluster.dbClusterArn,
          TagKeys: ["alchemy::id"],
        });
        yield* RDS.addTagsToResource({
          ResourceName: cluster.dbClusterArn,
          Tags: [{ Key: "Owner", Value: "stolen" }],
        });
        yield* waitForDBClusterAvailable(cluster.dbClusterIdentifier);

        // Re-deploy with the original desired props — reconcile should
        // converge each aspect back, including the alchemy internal tag.
        const redeployed = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* serverlessCluster("Drift", {
              backupRetentionPeriod: 1,
              preferredBackupWindow: "03:00-04:00",
              copyTagsToSnapshot: true,
            });
          }),
        );
        expect(redeployed.dbClusterArn).toEqual(cluster.dbClusterArn);
        expect(redeployed.backupRetentionPeriod).toEqual(1);
        expect(redeployed.preferredBackupWindow).toEqual("03:00-04:00");
        expect(redeployed.tags["alchemy::id"]).toEqual("Drift");

        yield* stack.destroy();
        yield* assertDBClusterDeleted(cluster.dbClusterIdentifier);
      }),
    { timeout: RDS_TIMEOUT },
  );

  test.provider.skip(
    "changing dbClusterIdentifier triggers replace, old cluster is deleted",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const suffix = Math.random().toString(36).slice(2, 8);
        const idA = `alchemy-test-rds-cluster-replace-a-${suffix}`;
        const idB = `alchemy-test-rds-cluster-replace-b-${suffix}`;

        const network = networkFixture();
        const a = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* serverlessCluster("Replaceable", {
              dbClusterIdentifier: idA,
            });
          }),
        );
        expect(a.dbClusterIdentifier).toEqual(idA);

        const b = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* serverlessCluster("Replaceable", {
              dbClusterIdentifier: idB,
            });
          }),
        );
        expect(b.dbClusterIdentifier).toEqual(idB);
        expect(b.dbClusterArn).not.toEqual(a.dbClusterArn);
        yield* assertDBClusterDeleted(idA);

        yield* stack.destroy();
        yield* assertDBClusterDeleted(idB);
      }),
    { timeout: RDS_TIMEOUT },
  );

  test.provider.skip(
    "in-place modification of engineVersion (minor) updates the cluster",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const network = networkFixture();
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* serverlessCluster("EngineUpgrade", {
              engineVersion: "15.4",
            });
          }),
        );
        expect(initial.engineVersion).toEqual("15.4");

        const upgraded = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* serverlessCluster("EngineUpgrade", {
              engineVersion: "15.5",
            });
          }),
        );
        expect(upgraded.dbClusterArn).toEqual(initial.dbClusterArn);
        yield* waitForEngineVersion(upgraded.dbClusterIdentifier, "15.5");

        yield* stack.destroy();
        yield* assertDBClusterDeleted(initial.dbClusterIdentifier);
      }),
    { timeout: RDS_TIMEOUT },
  );

  test.provider.skip(
    "destroying an already-deleted cluster is a no-op",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const network = networkFixture();
        const cluster = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* serverlessCluster("DoubleDestroy", {});
          }),
        );

        // Delete out-of-band and wait for deletion, then ask the engine
        // to destroy. Provider's `delete` must catch
        // DBClusterNotFoundFault and complete cleanly.
        yield* RDS.deleteDBCluster({
          DBClusterIdentifier: cluster.dbClusterIdentifier,
          SkipFinalSnapshot: true,
        });
        yield* assertDBClusterDeleted(cluster.dbClusterIdentifier);

        yield* stack.destroy();
      }),
    { timeout: RDS_TIMEOUT },
  );

  test.provider.skip(
    "foreign-tagged cluster requires adopt(true) to take over and re-tag",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const dbClusterIdentifier = `alchemy-test-rds-cluster-adopt-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        const network = networkFixture();

        const original = yield* stack.deploy(
          Effect.gen(function* () {
            yield* network;
            return yield* serverlessCluster("Original", {
              dbClusterIdentifier,
            });
          }),
        );

        // Wipe state — the cluster stays in RDS — and remove our
        // ownership tags so it appears foreign on next read.
        yield* RDS.removeTagsFromResource({
          ResourceName: original.dbClusterArn,
          TagKeys: ["alchemy::app", "alchemy::stage", "alchemy::id"],
        });

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
              yield* network;
              return yield* serverlessCluster("Different", {
                dbClusterIdentifier,
              });
            }),
          )
          .pipe(adopt(true));

        expect(takenOver.dbClusterIdentifier).toEqual(dbClusterIdentifier);
        expect(takenOver.dbClusterArn).toEqual(original.dbClusterArn);
        expect(takenOver.tags["alchemy::id"]).toEqual("Different");

        yield* stack.destroy();
        yield* assertDBClusterDeleted(takenOver.dbClusterIdentifier);
      }),
    { timeout: RDS_TIMEOUT },
  );
});

// ── Test fixtures ─────────────────────────────────────────────────────

/**
 * Build a minimal RDS-ready VPC: 2 subnets across AZs (RDS DB subnet
 * groups require ≥2), a SG that lets the cluster talk to itself, and a
 * `DBSubnetGroup` referencing them. Returns the names/ids the cluster
 * needs.
 */
const networkFixture = () =>
  Effect.gen(function* () {
    const vpc = yield* Vpc("RdsClusterTestVpc", {
      cidrBlock: "10.43.0.0/16",
      enableDnsSupport: true,
      enableDnsHostnames: true,
    });
    const subnetA = yield* Subnet("RdsClusterTestSubnetA", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.43.1.0/24",
      availabilityZone: "us-east-1a",
    });
    const subnetB = yield* Subnet("RdsClusterTestSubnetB", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.43.2.0/24",
      availabilityZone: "us-east-1b",
    });
    const sg = yield* SecurityGroup("RdsClusterTestSG", {
      vpcId: vpc.vpcId,
      groupName: "alchemy-test-rds-cluster-sg",
      description: "Test SG for RDS cluster hardening",
    });
    const subnetGroup = yield* DBSubnetGroup("RdsClusterTestSubnetGroup", {
      subnetIds: [subnetA.subnetId, subnetB.subnetId],
    });
    return {
      dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
      vpcSecurityGroupIds: [sg.groupId],
    };
  });

const serverlessCluster = (
  id: string,
  overrides: Partial<DBClusterProps>,
) =>
  Effect.gen(function* () {
    return yield* DBCluster(id, {
      engine: "aurora-postgresql",
      engineMode: "provisioned",
      manageMasterUserPassword: true,
      masterUsername: "alchemy",
      serverlessV2ScalingConfiguration: {
        MinCapacity: 0.5,
        MaxCapacity: 1,
      },
      ...overrides,
    });
  });

// ── Polling helpers ──────────────────────────────────────────────────

class DBClusterNotAvailable extends Data.TaggedError(
  "DBClusterNotAvailable",
)<{ status: string | undefined }> {}

class DBClusterEngineVersionStale extends Data.TaggedError(
  "DBClusterEngineVersionStale",
)<{ observed: string | undefined; expected: string }> {}

class DBClusterStillExists extends Data.TaggedError("DBClusterStillExists") {}

const stableStateSchedule = Schedule.fixed("10 seconds").pipe(
  Schedule.both(Schedule.recurs(150)),
);

const waitForDBClusterAvailable = Effect.fn(function* (identifier: string) {
  yield* RDS.describeDBClusters({ DBClusterIdentifier: identifier }).pipe(
    Effect.flatMap((r) => {
      const status = r.DBClusters?.[0]?.Status;
      return status === "available"
        ? Effect.void
        : Effect.fail(new DBClusterNotAvailable({ status }));
    }),
    Effect.retry({
      while: (e) => e._tag === "DBClusterNotAvailable",
      schedule: stableStateSchedule,
    }),
  );
});

const waitForEngineVersion = Effect.fn(function* (
  identifier: string,
  expected: string,
) {
  yield* RDS.describeDBClusters({ DBClusterIdentifier: identifier }).pipe(
    Effect.flatMap((r) => {
      const observed = r.DBClusters?.[0]?.EngineVersion;
      return observed === expected
        ? Effect.void
        : Effect.fail(
            new DBClusterEngineVersionStale({ observed, expected }),
          );
    }),
    Effect.retry({
      while: (e) => e._tag === "DBClusterEngineVersionStale",
      schedule: stableStateSchedule,
    }),
  );
});

const assertDBClusterDeleted = Effect.fn(function* (identifier: string) {
  yield* RDS.describeDBClusters({ DBClusterIdentifier: identifier }).pipe(
    Effect.flatMap(() => Effect.fail(new DBClusterStillExists())),
    Effect.retry({
      while: (e) => e._tag === "DBClusterStillExists",
      schedule: stableStateSchedule,
    }),
    Effect.catchTag("DBClusterNotFoundFault", () => Effect.void),
  );
});
