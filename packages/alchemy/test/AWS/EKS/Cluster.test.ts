import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/EKS";
import { Network } from "@/AWS/EC2";
import { Role } from "@/AWS/IAM";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as eks from "@distilled.cloud/aws/eks";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// EKS clusters take 10-20 minutes to provision. These integration tests are
// skipped by default. Set `RUN_LIVE_EKS_TESTS=true` to opt in.
const live = process.env.RUN_LIVE_EKS_TESTS === "true";
const liveTest = live ? test.provider : test.provider.skip;

const TEST_TIMEOUT = 1_800_000; // 30 minutes

const CLUSTER_ROLE_TRUST_POLICY = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "eks.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

const clusterManagedPolicies = [
  "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
  "arn:aws:iam::aws:policy/AmazonEKSComputePolicy",
  "arn:aws:iam::aws:policy/AmazonEKSBlockStoragePolicy",
  "arn:aws:iam::aws:policy/AmazonEKSLoadBalancingPolicy",
  "arn:aws:iam::aws:policy/AmazonEKSNetworkingPolicy",
];

class ClusterStillExists extends Data.TaggedError("ClusterStillExists") {}
class ClusterNotConverged extends Data.TaggedError("ClusterNotConverged")<{
  readonly reason: string;
}> {}

const describe = (clusterName: string) =>
  eks
    .describeCluster({ name: clusterName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed({ cluster: undefined }),
      ),
    );

const assertClusterDeleted = Effect.fn(function* (clusterName: string) {
  yield* describe(clusterName).pipe(
    Effect.flatMap((res) =>
      res.cluster ? Effect.fail(new ClusterStillExists()) : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "ClusterStillExists",
      schedule: Schedule.exponential("3 seconds").pipe(
        Schedule.both(Schedule.recurs(120)),
      ),
    }),
  );
});

const waitForLogging = Effect.fn(function* (
  clusterName: string,
  predicate: (logging: eks.Logging | undefined) => boolean,
) {
  yield* describe(clusterName).pipe(
    Effect.flatMap((res) =>
      predicate(res.cluster?.logging)
        ? Effect.void
        : Effect.fail(
            new ClusterNotConverged({ reason: "logging mismatch" }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "ClusterNotConverged",
      schedule: Schedule.fixed("5 seconds").pipe(
        Schedule.both(Schedule.recurs(120)),
      ),
    }),
  );
});

// Build a network + cluster role we can reuse across deploys within a single
// test. Keeping this in the deploy block ensures it lives and dies with the
// stack lifecycle.
const buildClusterFixtures = (suffix: string) =>
  Effect.gen(function* () {
    const network = yield* Network("ClusterNetwork", {
      cidrBlock: "10.99.0.0/16",
      availabilityZones: 2,
      nat: "single",
    });
    const role = yield* Role("ClusterRole", {
      roleName: `alchemy-test-eks-cluster-${suffix}`,
      assumeRolePolicyDocument: CLUSTER_ROLE_TRUST_POLICY,
      managedPolicyArns: clusterManagedPolicies,
    });
    return { network, role };
  });

liveTest(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const clusterName = `alchemy-test-eks-idem-${suffix}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const { network, role } = yield* buildClusterFixtures(suffix);
          return yield* Cluster("IdempotentCluster", {
            clusterName,
            roleArn: role.roleArn,
            resourcesVpcConfig: {
              subnetIds: network.privateSubnetIds,
              endpointPublicAccess: true,
              endpointPrivateAccess: true,
            },
          });
        }),
      );
      expect(initial.clusterName).toEqual(clusterName);
      expect(initial.status).toEqual("ACTIVE");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const { network, role } = yield* buildClusterFixtures(suffix);
          return yield* Cluster("IdempotentCluster", {
            clusterName,
            roleArn: role.roleArn,
            resourcesVpcConfig: {
              subnetIds: network.privateSubnetIds,
              endpointPublicAccess: true,
              endpointPrivateAccess: true,
            },
          });
        }),
      );
      expect(second.clusterArn).toEqual(initial.clusterArn);
      expect(second.clusterName).toEqual(clusterName);

      yield* stack.destroy();
      yield* assertClusterDeleted(clusterName);
    }),
  { timeout: TEST_TIMEOUT },
);

liveTest(
  "reconcile resets logging mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const clusterName = `alchemy-test-eks-drift-${suffix}`;
      const desiredLogging: eks.Logging = {
        clusterLogging: [{ types: ["api", "audit"], enabled: true }],
      };

      const cluster = yield* stack.deploy(
        Effect.gen(function* () {
          const { network, role } = yield* buildClusterFixtures(suffix);
          return yield* Cluster("DriftCluster", {
            clusterName,
            roleArn: role.roleArn,
            resourcesVpcConfig: {
              subnetIds: network.privateSubnetIds,
              endpointPublicAccess: true,
              endpointPrivateAccess: true,
            },
            logging: desiredLogging,
          });
        }),
      );
      expect(cluster.status).toEqual("ACTIVE");

      // Mutate logging out-of-band: turn audit logs OFF.
      yield* eks.updateClusterConfig({
        name: clusterName,
        logging: {
          clusterLogging: [
            { types: ["api"], enabled: true },
            { types: ["audit"], enabled: false },
          ],
        },
      });

      // Re-deploy with original logging — reconcile must re-enable audit.
      yield* stack.deploy(
        Effect.gen(function* () {
          const { network, role } = yield* buildClusterFixtures(suffix);
          return yield* Cluster("DriftCluster", {
            clusterName,
            roleArn: role.roleArn,
            resourcesVpcConfig: {
              subnetIds: network.privateSubnetIds,
              endpointPublicAccess: true,
              endpointPrivateAccess: true,
            },
            logging: desiredLogging,
          });
        }),
      );

      yield* waitForLogging(clusterName, (logging) => {
        const api = logging?.clusterLogging?.find((entry) =>
          entry.types?.includes("api"),
        );
        const audit = logging?.clusterLogging?.find((entry) =>
          entry.types?.includes("audit"),
        );
        return Boolean(api?.enabled) && Boolean(audit?.enabled);
      });

      yield* stack.destroy();
      yield* assertClusterDeleted(clusterName);
    }),
  { timeout: TEST_TIMEOUT },
);

liveTest(
  "reconcile resets endpointPublicAccess mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const clusterName = `alchemy-test-eks-vpc-${suffix}`;

      const cluster = yield* stack.deploy(
        Effect.gen(function* () {
          const { network, role } = yield* buildClusterFixtures(suffix);
          return yield* Cluster("VpcDriftCluster", {
            clusterName,
            roleArn: role.roleArn,
            resourcesVpcConfig: {
              subnetIds: network.privateSubnetIds,
              endpointPublicAccess: true,
              endpointPrivateAccess: true,
            },
          });
        }),
      );
      expect(cluster.resourcesVpcConfig.endpointPublicAccess).toBe(true);

      // Flip endpointPublicAccess off out-of-band.
      yield* eks.updateClusterConfig({
        name: clusterName,
        resourcesVpcConfig: {
          endpointPublicAccess: false,
          endpointPrivateAccess: true,
        },
      });

      // Re-deploy with original config — reconcile must restore public.
      const restored = yield* stack.deploy(
        Effect.gen(function* () {
          const { network, role } = yield* buildClusterFixtures(suffix);
          return yield* Cluster("VpcDriftCluster", {
            clusterName,
            roleArn: role.roleArn,
            resourcesVpcConfig: {
              subnetIds: network.privateSubnetIds,
              endpointPublicAccess: true,
              endpointPrivateAccess: true,
            },
          });
        }),
      );
      expect(restored.resourcesVpcConfig.endpointPublicAccess).toBe(true);

      yield* stack.destroy();
      yield* assertClusterDeleted(clusterName);
    }),
  { timeout: TEST_TIMEOUT },
);

liveTest(
  "changing clusterName triggers replace, old cluster is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-eks-rep-a-${suffix}`;
      const nameB = `alchemy-test-eks-rep-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          const { network, role } = yield* buildClusterFixtures(suffix);
          return yield* Cluster("Renamed", {
            clusterName: nameA,
            roleArn: role.roleArn,
            resourcesVpcConfig: {
              subnetIds: network.privateSubnetIds,
              endpointPublicAccess: true,
              endpointPrivateAccess: true,
            },
          });
        }),
      );
      expect(a.clusterName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          const { network, role } = yield* buildClusterFixtures(suffix);
          return yield* Cluster("Renamed", {
            clusterName: nameB,
            roleArn: role.roleArn,
            resourcesVpcConfig: {
              subnetIds: network.privateSubnetIds,
              endpointPublicAccess: true,
              endpointPrivateAccess: true,
            },
          });
        }),
      );
      expect(b.clusterName).toEqual(nameB);
      expect(b.clusterArn).not.toEqual(a.clusterArn);

      // The old cluster must be gone after replacement.
      yield* assertClusterDeleted(nameA);

      yield* stack.destroy();
      yield* assertClusterDeleted(nameB);
    }),
  { timeout: TEST_TIMEOUT * 2 },
);

liveTest(
  "destroying an already-deleted cluster is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const clusterName = `alchemy-test-eks-dd-${suffix}`;

      const cluster = yield* stack.deploy(
        Effect.gen(function* () {
          const { network, role } = yield* buildClusterFixtures(suffix);
          return yield* Cluster("DoubleDestroy", {
            clusterName,
            roleArn: role.roleArn,
            resourcesVpcConfig: {
              subnetIds: network.privateSubnetIds,
              endpointPublicAccess: true,
              endpointPrivateAccess: true,
            },
          });
        }),
      );

      // Delete the cluster out-of-band, then destroy via the engine.
      // Provider's `delete` must catch ResourceNotFoundException +
      // ResourceInUseException and complete cleanly.
      yield* eks
        .deleteCluster({ name: cluster.clusterName })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          Effect.catchTag("ResourceInUseException", () => Effect.void),
        );
      yield* assertClusterDeleted(clusterName);

      yield* stack.destroy();
    }),
  { timeout: TEST_TIMEOUT },
);

liveTest(
  "adopt(true) re-tags a foreign cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const clusterName = `alchemy-test-eks-adopt-${suffix}`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          const { network, role } = yield* buildClusterFixtures(suffix);
          return yield* Cluster("Original", {
            clusterName,
            roleArn: role.roleArn,
            resourcesVpcConfig: {
              subnetIds: network.privateSubnetIds,
              endpointPublicAccess: true,
              endpointPrivateAccess: true,
            },
          });
        }),
      );

      // Wipe state — cluster stays in EKS.
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
            const { network, role } = yield* buildClusterFixtures(suffix);
            return yield* Cluster("Different", {
              clusterName,
              roleArn: role.roleArn,
              resourcesVpcConfig: {
                subnetIds: network.privateSubnetIds,
                endpointPublicAccess: true,
                endpointPrivateAccess: true,
              },
            });
          }),
        )
        .pipe(adopt(true));
      expect(takenOver.clusterArn).toEqual(original.clusterArn);

      const tags = yield* eks.listTagsForResource({
        resourceArn: takenOver.clusterArn,
      });
      expect(tags.tags?.["alchemy:fqn"]).toBeDefined();
      expect(tags.tags?.["alchemy:stage"]).toBeDefined();

      yield* stack.destroy();
      yield* assertClusterDeleted(clusterName);
    }),
  { timeout: TEST_TIMEOUT * 2 },
);
