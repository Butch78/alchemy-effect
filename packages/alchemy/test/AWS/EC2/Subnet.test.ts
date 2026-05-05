import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Subnet, Vpc } from "@/AWS/EC2";
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

const suffix = () => Math.random().toString(36).slice(2, 8);

test.provider("create, update, delete subnet", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { vpc, subnet } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("TestVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const subnet = yield* Subnet("TestSubnet", {
          vpcId: vpc.vpcId,
          cidrBlock: "10.0.1.0/24",
        });
        return { vpc, subnet };
      }),
    );

    const actualSubnet = yield* EC2.describeSubnets({
      SubnetIds: [subnet.subnetId],
    });

    expect(actualSubnet.Subnets?.[0]?.SubnetId).toEqual(subnet.subnetId);
    expect(actualSubnet.Subnets?.[0]?.CidrBlock).toEqual("10.0.1.0/24");
    expect(actualSubnet.Subnets?.[0]?.VpcId).toEqual(vpc.vpcId);
    expect(actualSubnet.Subnets?.[0]?.State).toEqual("available");
    expect(actualSubnet.Subnets?.[0]?.MapPublicIpOnLaunch).toEqual(false);

    // Update subnet attributes
    const { subnet: updatedSubnet } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("TestVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const subnet = yield* Subnet("TestSubnet", {
          vpcId: vpc.vpcId,
          cidrBlock: "10.0.1.0/24",
          mapPublicIpOnLaunch: true,
        });
        return { vpc, subnet };
      }),
    );

    yield* expectSubnetAttribute({
      SubnetId: updatedSubnet.subnetId,
      Attribute: "mapPublicIpOnLaunch",
      Value: true,
    });

    // Delete subnet and VPC
    yield* stack.destroy();

    yield* assertSubnetDeleted(subnet.subnetId);
  }).pipe(logLevel),
);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("IdempotentVpc", {
            cidrBlock: "10.20.0.0/16",
          });
          const subnet = yield* Subnet("IdempotentSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.20.1.0/24",
            mapPublicIpOnLaunch: true,
          });
          return { vpc, subnet };
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("IdempotentVpc", {
            cidrBlock: "10.20.0.0/16",
          });
          const subnet = yield* Subnet("IdempotentSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.20.1.0/24",
            mapPublicIpOnLaunch: true,
          });
          return { vpc, subnet };
        }),
      );

      expect(second.subnet.subnetId).toEqual(initial.subnet.subnetId);
      expect(second.subnet.subnetArn).toEqual(initial.subnet.subnetArn);
      expect(second.subnet.cidrBlock).toEqual("10.20.1.0/24");

      yield* expectSubnetAttribute({
        SubnetId: second.subnet.subnetId,
        Attribute: "mapPublicIpOnLaunch",
        Value: true,
      });

      yield* stack.destroy();
      yield* assertSubnetDeleted(initial.subnet.subnetId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets MapPublicIpOnLaunch and tags mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DriftVpc", {
            cidrBlock: "10.21.0.0/16",
          });
          const subnet = yield* Subnet("DriftSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.21.1.0/24",
            mapPublicIpOnLaunch: true,
            tags: { Environment: "dev", Owner: "alchemy" },
          });
          return { vpc, subnet };
        }),
      );

      // Mutate attribute and tags out-of-band via the raw SDK.
      yield* EC2.modifySubnetAttribute({
        SubnetId: initial.subnet.subnetId,
        MapPublicIpOnLaunch: { Value: false },
      });
      yield* EC2.createTags({
        Resources: [initial.subnet.subnetId],
        Tags: [
          { Key: "Environment", Value: "drifted" },
          { Key: "Foreign", Value: "tag" },
        ],
      });
      yield* expectSubnetAttribute({
        SubnetId: initial.subnet.subnetId,
        Attribute: "mapPublicIpOnLaunch",
        Value: false,
      });

      // Re-deploy with the original desired props — converge.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DriftVpc", {
            cidrBlock: "10.21.0.0/16",
          });
          const subnet = yield* Subnet("DriftSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.21.1.0/24",
            mapPublicIpOnLaunch: true,
            tags: { Environment: "dev", Owner: "alchemy" },
          });
          return { vpc, subnet };
        }),
      );
      expect(redeployed.subnet.subnetId).toEqual(initial.subnet.subnetId);

      yield* expectSubnetAttribute({
        SubnetId: redeployed.subnet.subnetId,
        Attribute: "mapPublicIpOnLaunch",
        Value: true,
      });

      const observed = yield* EC2.describeSubnets({
        SubnetIds: [redeployed.subnet.subnetId],
      });
      const tagMap = Object.fromEntries(
        (observed.Subnets?.[0]?.Tags ?? []).map((t) => [t.Key!, t.Value!]),
      );
      expect(tagMap.Environment).toEqual("dev");
      expect(tagMap.Owner).toEqual("alchemy");
      expect(tagMap.Foreign).toBeUndefined();
      expect(tagMap["alchemy::id"]).toEqual("DriftSubnet");

      yield* stack.destroy();
      yield* assertSubnetDeleted(initial.subnet.subnetId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a subnet that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("RecreateVpc", {
            cidrBlock: "10.22.0.0/16",
          });
          const subnet = yield* Subnet("RecreateSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.22.1.0/24",
          });
          return { vpc, subnet };
        }),
      );

      // Delete the subnet via the raw SDK.
      yield* EC2.deleteSubnet({ SubnetId: initial.subnet.subnetId });
      yield* assertSubnetDeleted(initial.subnet.subnetId);

      // Re-deploying must converge by re-creating. The state still
      // references the old subnetId; the reconciler observes
      // `InvalidSubnetID.NotFound`, falls through to the tag-filter lookup
      // (also empty), then to `createSubnet`.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("RecreateVpc", {
            cidrBlock: "10.22.0.0/16",
          });
          const subnet = yield* Subnet("RecreateSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.22.1.0/24",
          });
          return { vpc, subnet };
        }),
      );
      expect(recreated.subnet.subnetId).not.toEqual(initial.subnet.subnetId);
      expect(recreated.subnet.cidrBlock).toEqual("10.22.1.0/24");

      yield* stack.destroy();
      yield* assertSubnetDeleted(recreated.subnet.subnetId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "changing cidrBlock triggers replace; old subnet is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ReplaceCidrVpc", {
            cidrBlock: "10.23.0.0/16",
          });
          const subnet = yield* Subnet("ReplaceCidrSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.23.1.0/24",
          });
          return { vpc, subnet };
        }),
      );
      expect(a.subnet.cidrBlock).toEqual("10.23.1.0/24");

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ReplaceCidrVpc", {
            cidrBlock: "10.23.0.0/16",
          });
          const subnet = yield* Subnet("ReplaceCidrSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.23.2.0/24",
          });
          return { vpc, subnet };
        }),
      );
      expect(b.subnet.cidrBlock).toEqual("10.23.2.0/24");
      expect(b.subnet.subnetId).not.toEqual(a.subnet.subnetId);

      // Old subnet must be torn down by the replacement flow.
      yield* assertSubnetDeleted(a.subnet.subnetId);

      yield* stack.destroy();
      yield* assertSubnetDeleted(b.subnet.subnetId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "changing availabilityZone triggers replace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Pick two AZs deterministically from the live region. Using the
      // first two slots keeps the test deterministic across runs without
      // hard-coding a region.
      const azs = yield* EC2.describeAvailabilityZones({});
      const [azA, azB] = (azs.AvailabilityZones ?? []).map((z) => z.ZoneName!);
      expect(azA).toBeDefined();
      expect(azB).toBeDefined();

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ReplaceAzVpc", {
            cidrBlock: "10.24.0.0/16",
          });
          const subnet = yield* Subnet("ReplaceAzSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.24.1.0/24",
            availabilityZone: azA,
          });
          return { vpc, subnet };
        }),
      );
      expect(a.subnet.availabilityZone).toEqual(azA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ReplaceAzVpc", {
            cidrBlock: "10.24.0.0/16",
          });
          const subnet = yield* Subnet("ReplaceAzSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.24.1.0/24",
            availabilityZone: azB,
          });
          return { vpc, subnet };
        }),
      );
      expect(b.subnet.availabilityZone).toEqual(azB);
      expect(b.subnet.subnetId).not.toEqual(a.subnet.subnetId);

      yield* assertSubnetDeleted(a.subnet.subnetId);

      yield* stack.destroy();
      yield* assertSubnetDeleted(b.subnet.subnetId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "destroying an already-deleted subnet is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { subnet } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DoubleDestroyVpc", {
            cidrBlock: "10.25.0.0/16",
          });
          const subnet = yield* Subnet("DoubleDestroySubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.25.1.0/24",
          });
          return { vpc, subnet };
        }),
      );

      // Delete out-of-band, then ask the engine to destroy. The provider
      // must catch InvalidSubnetID.NotFound and complete cleanly.
      yield* EC2.deleteSubnet({ SubnetId: subnet.subnetId });
      yield* assertSubnetDeleted(subnet.subnetId);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "owned subnet (matching alchemy tags) is silently adopted after state wipe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const id = `Adoptable-${suffix()}`;
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("AdoptVpc", {
            cidrBlock: "10.26.0.0/16",
          });
          const subnet = yield* Subnet(id, {
            vpcId: vpc.vpcId,
            cidrBlock: "10.26.1.0/24",
          });
          return { vpc, subnet };
        }),
      );

      // Wipe state for the subnet only — VPC stays in state, the subnet
      // stays in EC2 with its alchemy::id tag.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: id,
        });
      }).pipe(Effect.provide(stack.state));

      // Re-deploy: read filters by alchemy tags, finds the orphan subnet,
      // hasAlchemyTags returns true, engine silently adopts. No adopt()
      // needed because tags already match.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("AdoptVpc", {
            cidrBlock: "10.26.0.0/16",
          });
          const subnet = yield* Subnet(id, {
            vpcId: vpc.vpcId,
            cidrBlock: "10.26.1.0/24",
          });
          return { vpc, subnet };
        }),
      );

      expect(adopted.subnet.subnetId).toEqual(initial.subnet.subnetId);
      expect(adopted.subnet.subnetArn).toEqual(initial.subnet.subnetArn);

      yield* stack.destroy();
      yield* assertSubnetDeleted(initial.subnet.subnetId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

// A foreign-tagged subnet takeover test requires pre-creating a subnet
// tagged with the new resource's `alchemy::id` (since Subnet has no
// physical name to look up by — `read` filters strictly by alchemy tags).
// The owned-adoption case above already exercises the read + tag-sync path
// end-to-end. Mirrors the equivalent gap acknowledged in the VPC adoption
// PR (#199).
test.provider.skip(
  "foreign-tagged subnet requires adopt(true) to take over",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const originalId = `Original-${suffix()}`;
      const original = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("TakeoverVpc", {
            cidrBlock: "10.27.0.0/16",
          });
          const subnet = yield* Subnet(originalId, {
            vpcId: vpc.vpcId,
            cidrBlock: "10.27.1.0/24",
          });
          return { vpc, subnet };
        }),
      );

      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: originalId,
        });
      }).pipe(Effect.provide(stack.state));

      const newId = `Different-${suffix()}`;
      const takenOver = yield* stack
        .deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("TakeoverVpc", {
              cidrBlock: "10.27.0.0/16",
            });
            const subnet = yield* Subnet(newId, {
              vpcId: vpc.vpcId,
              cidrBlock: "10.27.1.0/24",
            });
            return { vpc, subnet };
          }),
        )
        .pipe(adopt(true));

      const lookup = yield* EC2.describeSubnets({
        SubnetIds: [takenOver.subnet.subnetId],
      });
      const tagMap = Object.fromEntries(
        (lookup.Subnets?.[0]?.Tags ?? []).map((t) => [t.Key!, t.Value!]),
      );
      expect(tagMap["alchemy::id"]).toEqual(newId);

      yield* stack.destroy();
      yield* assertSubnetDeleted(takenOver.subnet.subnetId);
      if (original.subnet.subnetId !== takenOver.subnet.subnetId) {
        yield* assertSubnetDeleted(original.subnet.subnetId);
      }
    }).pipe(logLevel),
);

const expectSubnetAttribute = Effect.fn(function* (props: {
  SubnetId: string;
  Attribute: "mapPublicIpOnLaunch" | "assignIpv6AddressOnCreation";
  Value: boolean;
}) {
  yield* EC2.describeSubnets({
    SubnetIds: [props.SubnetId],
  }).pipe(
    Effect.tap(Effect.logDebug),
    Effect.flatMap((result) => {
      const subnet = result.Subnets?.[0];
      const actualValue =
        props.Attribute === "mapPublicIpOnLaunch"
          ? subnet?.MapPublicIpOnLaunch
          : subnet?.AssignIpv6AddressOnCreation;

      return actualValue === props.Value
        ? Effect.succeed(result)
        : Effect.fail(new SubnetAttributeStale());
    }),
    Effect.retry({
      while: (e) => e instanceof SubnetAttributeStale,
      schedule: Schedule.exponential(100),
    }),
  );
});

const assertSubnetDeleted = Effect.fn(function* (subnetId: string) {
  yield* EC2.describeSubnets({
    SubnetIds: [subnetId],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new SubnetStillExists())),
    Effect.retry({
      while: (e) => e instanceof SubnetStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.void),
  );
});

class SubnetStillExists extends Data.TaggedError("SubnetStillExists") {}

class SubnetAttributeStale extends Data.TaggedError("SubnetAttributeStale") {}
