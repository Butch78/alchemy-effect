import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { SecurityGroup, Vpc } from "@/AWS/EC2";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const baseVpc = (logicalId: string, cidrBlock: string) =>
  Vpc(logicalId, { cidrBlock });

test.provider(
  "create, update, delete security group",
  (stack) =>
    Effect.gen(function* () {
      const sg = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.30.0.0/16");
          return yield* SecurityGroup("TestSg", {
            vpcId: vpc.vpcId,
            description: "Initial",
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 22,
                toPort: 22,
                cidrIpv4: "10.30.0.0/16",
                description: "ssh",
              },
            ],
          });
        }),
      );

      const observed = yield* EC2.describeSecurityGroups({
        GroupIds: [sg.groupId],
      });
      expect(observed.SecurityGroups?.[0]?.GroupId).toEqual(sg.groupId);
      expect(observed.SecurityGroups?.[0]?.Description).toEqual("Initial");

      yield* stack.destroy();
      yield* assertSgDeleted(sg.groupId);
    }).pipe(logLevel),
);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.31.0.0/16");
          return yield* SecurityGroup("IdempotentSg", {
            vpcId: vpc.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 80,
                toPort: 80,
                cidrIpv4: "0.0.0.0/0",
                description: "http",
              },
            ],
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.31.0.0/16");
          return yield* SecurityGroup("IdempotentSg", {
            vpcId: vpc.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 80,
                toPort: 80,
                cidrIpv4: "0.0.0.0/0",
                description: "http",
              },
            ],
          });
        }),
      );

      expect(second.groupId).toEqual(initial.groupId);
      expect(second.groupArn).toEqual(initial.groupArn);

      const rules = yield* EC2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [second.groupId] }],
      });
      const ingress = (rules.SecurityGroupRules ?? []).filter(
        (r) => !r.IsEgress,
      );
      expect(ingress).toHaveLength(1);
      expect(ingress[0]?.FromPort).toEqual(80);

      yield* stack.destroy();
      yield* assertSgDeleted(initial.groupId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets ingress + egress rules mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const sg = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.32.0.0/16");
          return yield* SecurityGroup("DriftRulesSg", {
            vpcId: vpc.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "0.0.0.0/0",
                description: "https",
              },
            ],
            egress: [
              {
                ipProtocol: "tcp",
                fromPort: 1024,
                toPort: 65535,
                cidrIpv4: "0.0.0.0/0",
                description: "ephemeral",
              },
            ],
          });
        }),
      );

      // Drift: revoke the desired ingress out-of-band and authorize an
      // unwanted one. Same for egress.
      const beforeRules = yield* EC2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [sg.groupId] }],
      });
      const ingressIds = (beforeRules.SecurityGroupRules ?? [])
        .filter((r) => !r.IsEgress)
        .map((r) => r.SecurityGroupRuleId!);
      if (ingressIds.length > 0) {
        yield* EC2.revokeSecurityGroupIngress({
          GroupId: sg.groupId,
          SecurityGroupRuleIds: ingressIds,
        });
      }
      yield* EC2.authorizeSecurityGroupIngress({
        GroupId: sg.groupId,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "drifted" }],
          },
        ],
      });

      // Re-deploy the original desired set; reconcile must converge.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.32.0.0/16");
          return yield* SecurityGroup("DriftRulesSg", {
            vpcId: vpc.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "0.0.0.0/0",
                description: "https",
              },
            ],
            egress: [
              {
                ipProtocol: "tcp",
                fromPort: 1024,
                toPort: 65535,
                cidrIpv4: "0.0.0.0/0",
                description: "ephemeral",
              },
            ],
          });
        }),
      );
      expect(redeployed.groupId).toEqual(sg.groupId);

      const finalRules = yield* EC2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [redeployed.groupId] }],
      });
      const finalIngress = (finalRules.SecurityGroupRules ?? []).filter(
        (r) => !r.IsEgress,
      );
      const finalEgress = (finalRules.SecurityGroupRules ?? []).filter(
        (r) => r.IsEgress,
      );
      expect(finalIngress).toHaveLength(1);
      expect(finalIngress[0]?.FromPort).toEqual(443);
      expect(finalEgress).toHaveLength(1);
      expect(finalEgress[0]?.FromPort).toEqual(1024);

      yield* stack.destroy();
      yield* assertSgDeleted(sg.groupId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a security group deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.33.0.0/16");
          return yield* SecurityGroup("RecreateSg", {
            vpcId: vpc.vpcId,
          });
        }),
      );

      yield* EC2.deleteSecurityGroup({ GroupId: initial.groupId });
      yield* assertSgDeleted(initial.groupId);

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.33.0.0/16");
          return yield* SecurityGroup("RecreateSg", {
            vpcId: vpc.vpcId,
          });
        }),
      );
      expect(recreated.groupId).not.toEqual(initial.groupId);

      yield* stack.destroy();
      yield* assertSgDeleted(recreated.groupId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "changing groupName triggers replace; old SG is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.34.0.0/16");
          return yield* SecurityGroup("ReplaceSg", {
            vpcId: vpc.vpcId,
            groupName: `alchemy-test-sg-a-${suffix}`,
          });
        }),
      );
      expect(a.groupName).toEqual(`alchemy-test-sg-a-${suffix}`);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.34.0.0/16");
          return yield* SecurityGroup("ReplaceSg", {
            vpcId: vpc.vpcId,
            groupName: `alchemy-test-sg-b-${suffix}`,
          });
        }),
      );
      expect(b.groupName).toEqual(`alchemy-test-sg-b-${suffix}`);
      expect(b.groupId).not.toEqual(a.groupId);

      yield* assertSgDeleted(a.groupId);

      yield* stack.destroy();
      yield* assertSgDeleted(b.groupId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "adding/removing/changing rules diffs against cloud state",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.35.0.0/16");
          return yield* SecurityGroup("RuleDiffSg", {
            vpcId: vpc.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 80,
                toPort: 80,
                cidrIpv4: "0.0.0.0/0",
                description: "http",
              },
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "0.0.0.0/0",
                description: "https",
              },
            ],
          });
        }),
      );
      expect(v1.groupId).toBeDefined();

      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.35.0.0/16");
          return yield* SecurityGroup("RuleDiffSg", {
            vpcId: vpc.vpcId,
            ingress: [
              // Drop port 80, keep 443, add 8080
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "0.0.0.0/0",
                description: "https",
              },
              {
                ipProtocol: "tcp",
                fromPort: 8080,
                toPort: 8080,
                cidrIpv4: "10.35.0.0/16",
                description: "metrics",
              },
            ],
          });
        }),
      );
      expect(v2.groupId).toEqual(v1.groupId);

      const rules = yield* EC2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [v2.groupId] }],
      });
      const ingress = (rules.SecurityGroupRules ?? [])
        .filter((r) => !r.IsEgress)
        .map((r) => r.FromPort)
        .sort((a, b) => (a ?? 0) - (b ?? 0));
      expect(ingress).toEqual([443, 8080]);

      yield* stack.destroy();
      yield* assertSgDeleted(v1.groupId);
    }).pipe(logLevel),
);

test.provider(
  "destroying an already-deleted security group is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const sg = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.36.0.0/16");
          return yield* SecurityGroup("DoubleDestroySg", {
            vpcId: vpc.vpcId,
          });
        }),
      );

      yield* EC2.deleteSecurityGroup({ GroupId: sg.groupId });
      yield* assertSgDeleted(sg.groupId);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "foreign-tagged security group requires adopt(true) to take over",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const groupName = `alchemy-test-sg-takeover-${suffix}`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* baseVpc("SgVpc", "10.37.0.0/16");
          return yield* SecurityGroup("Original", {
            vpcId: vpc.vpcId,
            groupName,
          });
        }),
      );

      // Wipe the SG entry from state — SG remains in EC2.
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
            const vpc = yield* baseVpc("SgVpc", "10.37.0.0/16");
            return yield* SecurityGroup("Different", {
              vpcId: vpc.vpcId,
              groupName,
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.groupName).toEqual(groupName);
      expect(takenOver.groupId).toEqual(original.groupId);

      yield* stack.destroy();
      yield* assertSgDeleted(original.groupId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

class SgStillExists extends Data.TaggedError("SgStillExists") {}

export const assertSgDeleted = Effect.fn(function* (groupId: string) {
  yield* EC2.describeSecurityGroups({
    GroupIds: [groupId],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new SgStillExists())),
    Effect.retry({
      while: (e) => e._tag === "SgStillExists",
      schedule: Schedule.exponential(100).pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
    Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
  );
});
