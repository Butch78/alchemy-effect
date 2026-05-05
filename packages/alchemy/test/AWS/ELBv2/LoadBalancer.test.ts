import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Subnet, Vpc } from "@/AWS/EC2";
import { LoadBalancer } from "@/AWS/ELBv2";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as ELBv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
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

class LoadBalancerStillExists extends Data.TaggedError(
  "LoadBalancerStillExists",
)<{ arn: string }> {}

const assertLoadBalancerDeleted = (arn: string) =>
  Effect.gen(function* () {
    const result = yield* ELBv2.describeLoadBalancers({
      LoadBalancerArns: [arn],
    }).pipe(
      Effect.catchTag("LoadBalancerNotFoundException", () =>
        Effect.succeed({ LoadBalancers: [] as unknown[] }),
      ),
    );
    if ((result.LoadBalancers ?? []).length > 0) {
      return yield* new LoadBalancerStillExists({ arn });
    }
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof LoadBalancerStillExists,
      schedule: Schedule.fixed(2000).pipe(Schedule.both(Schedule.recurs(30))),
    }),
  );

const minimalNetwork = Effect.fn(function* (suffix: string) {
  const azResult = yield* EC2.describeAvailabilityZones({});
  const availableAzs =
    azResult.AvailabilityZones?.filter((az) => az.State === "available") ?? [];
  const az1 = availableAzs[0]?.ZoneName!;
  const az2 = availableAzs[1]?.ZoneName!;
  const vpc = yield* Vpc(`Vpc-${suffix}`, { cidrBlock: "10.0.0.0/16" });
  const subnetA = yield* Subnet(`SubnetA-${suffix}`, {
    vpcId: vpc.vpcId,
    cidrBlock: "10.0.1.0/24",
    availabilityZone: az1,
  });
  const subnetB = yield* Subnet(`SubnetB-${suffix}`, {
    vpcId: vpc.vpcId,
    cidrBlock: "10.0.2.0/24",
    availabilityZone: az2,
  });
  return { vpc, subnets: [subnetA.subnetId, subnetB.subnetId] };
});

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const { subnets } = yield* minimalNetwork(suffix);
          return yield* LoadBalancer("IdempotentLb", {
            scheme: "internet-facing",
            subnets,
            attributes: { "idle_timeout.timeout_seconds": "60" },
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const { subnets } = yield* minimalNetwork(suffix);
          return yield* LoadBalancer("IdempotentLb", {
            scheme: "internet-facing",
            subnets,
            attributes: { "idle_timeout.timeout_seconds": "60" },
          });
        }),
      );

      expect(second.loadBalancerArn).toEqual(initial.loadBalancerArn);
      expect(second.loadBalancerName).toEqual(initial.loadBalancerName);
      expect(second.dnsName).toEqual(initial.dnsName);

      yield* stack.destroy();
      yield* assertLoadBalancerDeleted(initial.loadBalancerArn);
    }).pipe(logLevel),
  { timeout: 600_000 },
);

test.provider(
  "reconcile resets attributes mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);

      const lb = yield* stack.deploy(
        Effect.gen(function* () {
          const { subnets } = yield* minimalNetwork(suffix);
          return yield* LoadBalancer("DriftLb", {
            subnets,
            attributes: {
              "idle_timeout.timeout_seconds": "60",
              "deletion_protection.enabled": "false",
            },
          });
        }),
      );

      // Drift: bump idle timeout and enable deletion protection out-of-band.
      yield* ELBv2.modifyLoadBalancerAttributes({
        LoadBalancerArn: lb.loadBalancerArn,
        Attributes: [
          { Key: "idle_timeout.timeout_seconds", Value: "240" },
          { Key: "deletion_protection.enabled", Value: "true" },
        ],
      });

      // Re-deploy with original desired props — reconcile must reset both.
      yield* stack.deploy(
        Effect.gen(function* () {
          const { subnets } = yield* minimalNetwork(suffix);
          return yield* LoadBalancer("DriftLb", {
            subnets,
            attributes: {
              "idle_timeout.timeout_seconds": "60",
              "deletion_protection.enabled": "false",
            },
          });
        }),
      );

      const attrs = yield* ELBv2.describeLoadBalancerAttributes({
        LoadBalancerArn: lb.loadBalancerArn,
      });
      const attrMap = Object.fromEntries(
        (attrs.Attributes ?? []).flatMap((a) =>
          a.Key && a.Value ? [[a.Key, a.Value] as const] : [],
        ),
      );
      expect(attrMap["idle_timeout.timeout_seconds"]).toEqual("60");
      expect(attrMap["deletion_protection.enabled"]).toEqual("false");

      yield* stack.destroy();
      yield* assertLoadBalancerDeleted(lb.loadBalancerArn);
    }).pipe(logLevel),
  { timeout: 600_000 },
);

test.provider(
  "reconcile re-creates a LoadBalancer that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const lbName = `alch-recreate-${suffix}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const { subnets } = yield* minimalNetwork(suffix);
          return yield* LoadBalancer("RecreateLb", {
            name: lbName,
            subnets,
          });
        }),
      );

      yield* ELBv2.deleteLoadBalancer({
        LoadBalancerArn: initial.loadBalancerArn,
      });
      yield* assertLoadBalancerDeleted(initial.loadBalancerArn);

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          const { subnets } = yield* minimalNetwork(suffix);
          return yield* LoadBalancer("RecreateLb", {
            name: lbName,
            subnets,
          });
        }),
      );

      expect(recreated.loadBalancerName).toEqual(lbName);
      expect(recreated.loadBalancerArn).not.toEqual(initial.loadBalancerArn);

      yield* stack.destroy();
      yield* assertLoadBalancerDeleted(recreated.loadBalancerArn);
    }).pipe(logLevel),
  { timeout: 900_000 },
);

test.provider(
  "changing name triggers replace, old LoadBalancer is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alch-rename-a-${suffix}`;
      const nameB = `alch-rename-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          const { subnets } = yield* minimalNetwork(suffix);
          return yield* LoadBalancer("RenameLb", {
            name: nameA,
            subnets,
          });
        }),
      );
      expect(a.loadBalancerName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          const { subnets } = yield* minimalNetwork(suffix);
          return yield* LoadBalancer("RenameLb", {
            name: nameB,
            subnets,
          });
        }),
      );
      expect(b.loadBalancerName).toEqual(nameB);
      expect(b.loadBalancerArn).not.toEqual(a.loadBalancerArn);

      yield* assertLoadBalancerDeleted(a.loadBalancerArn);

      yield* stack.destroy();
      yield* assertLoadBalancerDeleted(b.loadBalancerArn);
    }).pipe(logLevel),
  { timeout: 900_000 },
);

test.provider(
  "destroying an already-deleted LoadBalancer is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);

      const lb = yield* stack.deploy(
        Effect.gen(function* () {
          const { subnets } = yield* minimalNetwork(suffix);
          return yield* LoadBalancer("DoubleDestroyLb", {
            subnets,
          });
        }),
      );

      // Out-of-band delete, then ask the engine to destroy. Provider must
      // catch `LoadBalancerNotFoundException` and complete cleanly.
      yield* ELBv2.deleteLoadBalancer({
        LoadBalancerArn: lb.loadBalancerArn,
      });
      yield* assertLoadBalancerDeleted(lb.loadBalancerArn);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 600_000 },
);

test.provider(
  "adopt(true) re-tags a foreign LoadBalancer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const lbName = `alch-adopt-${suffix}`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          const { subnets } = yield* minimalNetwork(suffix);
          return yield* LoadBalancer("Original", {
            name: lbName,
            subnets,
          });
        }),
      );

      // Wipe state — LB stays in AWS.
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
            const { subnets } = yield* minimalNetwork(suffix);
            return yield* LoadBalancer("Different", {
              name: lbName,
              subnets,
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.loadBalancerName).toEqual(lbName);
      expect(takenOver.loadBalancerArn).toEqual(original.loadBalancerArn);

      // Adoption with `adopt(true)` should retag with the new logical id's
      // alchemy tags so subsequent runs route through silent adoption.
      const tagDescriptions = yield* ELBv2.describeTags({
        ResourceArns: [takenOver.loadBalancerArn],
      });
      const tagMap = Object.fromEntries(
        (tagDescriptions.TagDescriptions?.[0]?.Tags ?? []).flatMap((t) =>
          t.Key && t.Value ? [[t.Key, t.Value] as const] : [],
        ),
      );
      expect(tagMap["alchemy:fqn"]).toBeDefined();
      expect(tagMap["alchemy:stage"]).toBeDefined();

      yield* stack.destroy();
      yield* assertLoadBalancerDeleted(takenOver.loadBalancerArn);
    }).pipe(logLevel),
  { timeout: 900_000 },
);
