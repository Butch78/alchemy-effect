import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { Unowned } from "../../AdoptPolicy.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved, somePropsAreDifferent } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createAlchemyTagFilters,
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import type { VpcId } from "./Vpc.ts";

export type SubnetId<ID extends string = string> = `subnet-${ID}`;
export const SubnetId = <ID extends string>(id: ID): ID & SubnetId<ID> =>
  `subnet-${id}` as ID & SubnetId<ID>;

export type SubnetArn =
  `arn:aws:ec2:${RegionID}:${AccountID}:subnet/${SubnetId}`;

export interface SubnetProps {
  /**
   * The VPC to create the subnet in.
   */
  vpcId: VpcId;

  /**
   * The IPv4 network range for the subnet, in CIDR notation.
   * Required unless using IPAM.
   * @example "10.0.1.0/24"
   */
  cidrBlock?: string;

  /**
   * The IPv6 network range for the subnet, in CIDR notation.
   */
  ipv6CidrBlock?: string;

  /**
   * The Availability Zone for the subnet.
   * @example "us-east-1a"
   */
  availabilityZone?: string;

  /**
   * The ID of the Availability Zone for the subnet.
   */
  availabilityZoneId?: string;

  /**
   * The ID of an IPv4 IPAM pool you want to use for allocating this subnet's CIDR.
   */
  ipv4IpamPoolId?: string;

  /**
   * The netmask length of the IPv4 CIDR you want to allocate to this subnet from an IPAM pool.
   */
  ipv4NetmaskLength?: number;

  /**
   * The ID of an IPv6 IPAM pool which will be used to allocate this subnet an IPv6 CIDR.
   */
  ipv6IpamPoolId?: string;

  /**
   * The netmask length of the IPv6 CIDR you want to allocate to this subnet from an IPAM pool.
   */
  ipv6NetmaskLength?: number;

  /**
   * Whether instances launched in the subnet get public IPv4 addresses.
   * @default false
   */
  mapPublicIpOnLaunch?: boolean;

  /**
   * Whether instances launched in the subnet get IPv6 addresses.
   * @default false
   */
  assignIpv6AddressOnCreation?: boolean;

  /**
   * Whether DNS queries made to the Amazon-provided DNS Resolver in this subnet should return
   * synthetic IPv6 addresses for IPv4-only destinations.
   * @default false
   */
  enableDns64?: boolean;

  /**
   * Whether to enable resource name DNS A record on launch.
   * @default false
   */
  enableResourceNameDnsARecordOnLaunch?: boolean;

  /**
   * Whether to enable resource name DNS AAAA record on launch.
   * @default false
   */
  enableResourceNameDnsAAAARecordOnLaunch?: boolean;

  /**
   * The hostname type for EC2 instances launched into this subnet.
   */
  hostnameType?: ec2.HostnameType;

  /**
   * Tags to assign to the subnet.
   * These will be merged with alchemy auto-tags (alchemy::stack, alchemy::stage, alchemy::id).
   */
  tags?: Record<string, string>;
}

export interface Subnet extends Resource<
  "AWS.EC2.Subnet",
  SubnetProps,
  {
    /**
     * The ID of the VPC the subnet is in.
     */
    vpcId: VpcId;

    /**
     * The ID of the subnet.
     */
    subnetId: SubnetId;

    /**
     * The Amazon Resource Name (ARN) of the subnet.
     */
    subnetArn: SubnetArn;

    /**
     * The IPv4 CIDR block for the subnet.
     */
    cidrBlock: string;

    /**
     * The Availability Zone of the subnet.
     */
    availabilityZone: string;

    /**
     * The ID of the Availability Zone of the subnet.
     */
    availabilityZoneId?: string;

    /**
     * The current state of the subnet.
     */
    state: ec2.SubnetState;

    /**
     * The number of available IPv4 addresses in the subnet.
     */
    availableIpAddressCount: number;

    /**
     * Whether instances launched in the subnet get public IPv4 addresses.
     */
    mapPublicIpOnLaunch: boolean;

    /**
     * Whether instances launched in the subnet get IPv6 addresses.
     */
    assignIpv6AddressOnCreation: boolean | undefined;

    /**
     * Whether the subnet is the default subnet for the Availability Zone.
     */
    defaultForAz: boolean;

    /**
     * The ID of the AWS account that owns the subnet.
     */
    ownerId?: string;

    /**
     * Information about the IPv6 CIDR blocks associated with the subnet.
     */
    ipv6CidrBlockAssociationSet?: Array<{
      associationId: string;
      ipv6CidrBlock: string;
      ipv6CidrBlockState: {
        state: ec2.SubnetCidrBlockStateCode;
        statusMessage?: string;
      };
    }>;

    /**
     * Whether DNS64 is enabled for the subnet.
     */
    enableDns64?: boolean;

    /**
     * Whether this is an IPv6-only subnet.
     */
    ipv6Native?: boolean;

    /**
     * The private DNS name options on launch.
     */
    privateDnsNameOptionsOnLaunch?: {
      hostnameType?: ec2.HostnameType;
      enableResourceNameDnsARecord?: boolean;
      enableResourceNameDnsAAAARecord?: boolean;
    };

    /**
     * The tags currently applied to the subnet.
     */
    tags?: Record<string, string>;
  },
  never,
  Providers
> {}
export const Subnet = Resource<Subnet>("AWS.EC2.Subnet");

export const SubnetProvider = () =>
  Provider.effect(
    Subnet,
    Effect.gen(function* () {
      return {
        stables: ["subnetId", "subnetArn", "ownerId", "vpcId"],
        // Observe a Subnet by alchemy tags. Subnet ids are auto-assigned, so
        // we can't reconstruct the identifier from props — instead we filter
        // `describeSubnets` by the internal tags `createInternalTags(id)`
        // writes on every Subnet we manage. If a Subnet was created out of
        // band (no alchemy tags) the filter returns nothing and we surface
        // `undefined` rather than guessing.
        read: Effect.fn(function* ({ id, output }) {
          let subnet: ec2.Subnet | undefined;
          if (output?.subnetId) {
            const lookup = yield* ec2
              .describeSubnets({ SubnetIds: [output.subnetId] })
              .pipe(
                Effect.catchTag("InvalidSubnetID.NotFound", () =>
                  Effect.succeed({ Subnets: [] }),
                ),
              );
            subnet = lookup.Subnets?.[0];
          }
          if (!subnet) {
            const filters = yield* createAlchemyTagFilters(id);
            const lookup = yield* ec2.describeSubnets({ Filters: filters });
            subnet = lookup.Subnets?.[0];
          }
          if (!subnet) return undefined;
          const tags = Object.fromEntries(
            (subnet.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const attrs = toSubnetAttrs(subnet, tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (
            somePropsAreDifferent(olds, news, [
              "vpcId",
              "cidrBlock",
              "availabilityZone",
              "availabilityZoneId",
              "ipv6CidrBlock",
              "ipv4IpamPoolId",
              "ipv6IpamPoolId",
            ])
          ) {
            return { action: "replace" };
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const alchemyTags = yield* createInternalTags(id);
          const desiredTags = { ...alchemyTags, ...(news.tags ?? {}) };

          // Observe — find the subnet via cached id, else by alchemy tags so
          // an interrupted previous run (state lost after createSubnet but
          // before persistence) recovers without leaking a duplicate.
          let subnet: ec2.Subnet | undefined;
          if (output?.subnetId) {
            const lookup = yield* ec2
              .describeSubnets({ SubnetIds: [output.subnetId] })
              .pipe(
                Effect.catchTag("InvalidSubnetID.NotFound", () =>
                  Effect.succeed({ Subnets: [] }),
                ),
              );
            subnet = lookup.Subnets?.[0];
          }
          if (!subnet) {
            const filters = yield* createAlchemyTagFilters(id);
            const lookup = yield* ec2.describeSubnets({ Filters: filters });
            subnet = lookup.Subnets?.[0];
          }

          // Ensure — create the subnet when missing.
          if (subnet === undefined) {
            const createResult = yield* ec2
              .createSubnet({
                VpcId: news.vpcId,
                CidrBlock: news.cidrBlock,
                Ipv6CidrBlock: news.ipv6CidrBlock,
                AvailabilityZone: news.availabilityZone,
                AvailabilityZoneId: news.availabilityZoneId,
                Ipv4IpamPoolId: news.ipv4IpamPoolId,
                Ipv4NetmaskLength: news.ipv4NetmaskLength,
                Ipv6IpamPoolId: news.ipv6IpamPoolId,
                Ipv6NetmaskLength: news.ipv6NetmaskLength,
                Ipv6Native: false,
                TagSpecifications: [
                  {
                    ResourceType: "subnet",
                    Tags: createTagsList(desiredTags),
                  },
                ],
                DryRun: false,
              })
              .pipe(
                // VPC reads are eventually consistent — when a fresh VPC is
                // created in the same plan the propagation delay can surface
                // as `InvalidVpcID.NotFound` here. Bound the wait so a
                // genuinely-missing VPC still surfaces as a failure.
                Effect.retry({
                  while: (e) => e._tag === "InvalidVpcID.NotFound",
                  schedule: Schedule.fixed(1000).pipe(
                    Schedule.both(Schedule.recurs(15)),
                  ),
                }),
              );
            const newSubnetId = createResult.Subnet!.SubnetId! as SubnetId;
            yield* session.note(`Subnet created: ${newSubnetId}`);
            subnet = yield* waitForSubnetAvailable(newSubnetId, session);
          }

          const subnetId = subnet.SubnetId! as SubnetId;

          // Sync subnet attributes — diff observed cloud state against desired
          // and only call modifySubnetAttribute on real drift. Each call is
          // wrapped in `retryEventuallyConsistent` because EC2 may briefly
          // return `InvalidSubnetID.NotFound` immediately after createSubnet
          // even though `waitForSubnetAvailable` has reported the subnet as
          // `available`.
          const desiredMapPublicIp = news.mapPublicIpOnLaunch ?? false;
          if ((subnet.MapPublicIpOnLaunch ?? false) !== desiredMapPublicIp) {
            yield* ec2
              .modifySubnetAttribute({
                SubnetId: subnetId,
                MapPublicIpOnLaunch: { Value: desiredMapPublicIp },
              })
              .pipe(retryEventuallyConsistent);
            yield* session.note(
              `Updated map public IP on launch: ${desiredMapPublicIp}`,
            );
          }

          const desiredAssignIpv6 = news.assignIpv6AddressOnCreation ?? false;
          if (
            (subnet.AssignIpv6AddressOnCreation ?? false) !== desiredAssignIpv6
          ) {
            yield* ec2
              .modifySubnetAttribute({
                SubnetId: subnetId,
                AssignIpv6AddressOnCreation: { Value: desiredAssignIpv6 },
              })
              .pipe(retryEventuallyConsistent);
            yield* session.note(
              `Updated assign IPv6 address on creation: ${desiredAssignIpv6}`,
            );
          }

          const desiredEnableDns64 = news.enableDns64 ?? false;
          if ((subnet.EnableDns64 ?? false) !== desiredEnableDns64) {
            yield* ec2
              .modifySubnetAttribute({
                SubnetId: subnetId,
                EnableDns64: { Value: desiredEnableDns64 },
              })
              .pipe(retryEventuallyConsistent);
            yield* session.note(`Updated DNS64 setting: ${desiredEnableDns64}`);
          }

          const observedHostnameType =
            subnet.PrivateDnsNameOptionsOnLaunch?.HostnameType;
          const observedDnsA =
            subnet.PrivateDnsNameOptionsOnLaunch?.EnableResourceNameDnsARecord;
          const observedDnsAAAA =
            subnet.PrivateDnsNameOptionsOnLaunch
              ?.EnableResourceNameDnsAAAARecord;
          if (
            observedHostnameType !== news.hostnameType ||
            observedDnsA !== news.enableResourceNameDnsARecordOnLaunch ||
            observedDnsAAAA !== news.enableResourceNameDnsAAAARecordOnLaunch
          ) {
            if (
              news.enableResourceNameDnsARecordOnLaunch !== undefined ||
              news.enableResourceNameDnsAAAARecordOnLaunch !== undefined ||
              news.hostnameType !== undefined
            ) {
              yield* ec2
                .modifySubnetAttribute({
                  SubnetId: subnetId,
                  PrivateDnsHostnameTypeOnLaunch: news.hostnameType,
                  EnableResourceNameDnsARecordOnLaunch:
                    news.enableResourceNameDnsARecordOnLaunch !== undefined
                      ? { Value: news.enableResourceNameDnsARecordOnLaunch }
                      : undefined,
                  EnableResourceNameDnsAAAARecordOnLaunch:
                    news.enableResourceNameDnsAAAARecordOnLaunch !== undefined
                      ? { Value: news.enableResourceNameDnsAAAARecordOnLaunch }
                      : undefined,
                })
                .pipe(retryEventuallyConsistent);
              yield* session.note("Updated private DNS hostname settings");
            }
          }

          // Sync tags — observed cloud tags vs desired. Foreign-tagged
          // takeovers (adopt(true)) come through here with `subnet.Tags` not
          // matching what we last persisted, so this diff is what re-brands
          // the subnet on adoption.
          const currentTags = Object.fromEntries(
            (subnet.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2
              .deleteTags({
                Resources: [subnetId],
                Tags: removed.map((key) => ({ Key: key })),
                DryRun: false,
              })
              .pipe(retryEventuallyConsistent);
          }
          if (upsert.length > 0) {
            yield* ec2
              .createTags({
                Resources: [subnetId],
                Tags: upsert,
                DryRun: false,
              })
              .pipe(retryEventuallyConsistent);
          }

          // Re-read final state.
          const finalLookup = yield* ec2
            .describeSubnets({ SubnetIds: [subnetId] })
            .pipe(retryEventuallyConsistent);
          const final = finalLookup.Subnets?.[0];
          if (!final) {
            return yield* new SubnetDisappeared({ subnetId });
          }
          const finalTags = Object.fromEntries(
            (final.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          return toSubnetAttrs(final, finalTags);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const subnetId = output.subnetId;

          yield* session.note(`Deleting subnet: ${subnetId}`);

          // Attempt to delete the subnet. If it's already gone, that's a
          // no-op. DependencyViolation means ENIs / RouteTableAssociations /
          // running instances are still being torn down; bound the wait at
          // ~5 minutes to match VPC.
          yield* ec2
            .deleteSubnet({
              SubnetId: subnetId,
              DryRun: false,
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "DependencyViolation",
                schedule: Schedule.fixed(5000).pipe(
                  Schedule.both(Schedule.recurs(60)),
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `Waiting for subnet dependencies to clear... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
              Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.void),
            );

          // Wait for the deletion to propagate.
          yield* waitForSubnetDeleted(subnetId, session);

          yield* session.note(`Subnet ${subnetId} deleted successfully`);
        }),
      };
    }),
  );

// Retryable error: Subnet is still pending
class SubnetPending extends Data.TaggedError("SubnetPending")<{
  subnetId: string;
  state: string;
}> {}

// Retryable error: Subnet still exists during deletion
class SubnetStillExists extends Data.TaggedError("SubnetStillExists")<{
  subnetId: string;
}> {}

// Tagged failure for the rare case where a Subnet vanishes mid-reconcile
// (e.g. it was deleted out of band between createSubnet and the final read).
class SubnetDisappeared extends Data.TaggedError("SubnetDisappeared")<{
  subnetId: string;
}> {}

/**
 * Pipe an EC2 effect through a bounded retry that rides out post-create
 * eventual-consistency `InvalidSubnetID.NotFound`. The general AWS retry
 * layer doesn't ride this out because distilled doesn't tag it as
 * retryable — but we know it's transient when we have just created the
 * subnet ourselves.
 */
const retryEventuallyConsistent = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, { _tag: "InvalidSubnetID.NotFound" }>, R> =>
  self.pipe(
    Effect.retry({
      while: (e: any) => e?._tag === "InvalidSubnetID.NotFound",
      schedule: Schedule.fixed(1000).pipe(Schedule.both(Schedule.recurs(15))),
    }),
  ) as Effect.Effect<
    A,
    Exclude<E, { _tag: "InvalidSubnetID.NotFound" }>,
    R
  >;

/**
 * Project a `describeSubnets` result row to the public Attributes shape.
 * Used by `read` and the final read inside `reconcile` to produce
 * identically-shaped output.
 */
const toSubnetAttrs = (
  subnet: ec2.Subnet,
  tags: Record<string, string>,
): Subnet["Attributes"] => ({
  subnetId: subnet.SubnetId! as SubnetId,
  subnetArn: subnet.SubnetArn! as SubnetArn,
  cidrBlock: subnet.CidrBlock!,
  vpcId: subnet.VpcId! as VpcId,
  availabilityZone: subnet.AvailabilityZone!,
  availabilityZoneId: subnet.AvailabilityZoneId,
  state: subnet.State!,
  availableIpAddressCount: subnet.AvailableIpAddressCount ?? 0,
  mapPublicIpOnLaunch: subnet.MapPublicIpOnLaunch ?? false,
  assignIpv6AddressOnCreation: subnet.AssignIpv6AddressOnCreation ?? false,
  defaultForAz: subnet.DefaultForAz ?? false,
  ownerId: subnet.OwnerId,
  ipv6CidrBlockAssociationSet: subnet.Ipv6CidrBlockAssociationSet?.map(
    (assoc) => ({
      associationId: assoc.AssociationId!,
      ipv6CidrBlock: assoc.Ipv6CidrBlock!,
      ipv6CidrBlockState: {
        state: assoc.Ipv6CidrBlockState!.State!,
        statusMessage: assoc.Ipv6CidrBlockState!.StatusMessage,
      },
    }),
  ),
  enableDns64: subnet.EnableDns64,
  ipv6Native: subnet.Ipv6Native,
  privateDnsNameOptionsOnLaunch: subnet.PrivateDnsNameOptionsOnLaunch
    ? {
        hostnameType: subnet.PrivateDnsNameOptionsOnLaunch.HostnameType,
        enableResourceNameDnsARecord:
          subnet.PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsARecord,
        enableResourceNameDnsAAAARecord:
          subnet.PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsAAAARecord,
      }
    : undefined,
  tags,
});

/**
 * Wait for subnet to be in `available` state. EC2 is eventually consistent,
 * so `describeSubnets` immediately after `createSubnet` may briefly return
 * `InvalidSubnetID.NotFound` — treat that as "still pending" instead of
 * failing.
 */
const waitForSubnetAvailable = (
  subnetId: string,
  session?: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeSubnets({ SubnetIds: [subnetId] })
      .pipe(
        Effect.catchTag("InvalidSubnetID.NotFound", () =>
          Effect.succeed({ Subnets: [] as ec2.Subnet[] }),
        ),
      );
    const subnet = result.Subnets?.[0];

    if (!subnet) {
      return yield* new SubnetPending({ subnetId, state: "missing" });
    }

    if (subnet.State === "available") {
      return subnet;
    }

    return yield* new SubnetPending({ subnetId, state: subnet.State! });
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof SubnetPending,
      schedule: Schedule.fixed(2000).pipe(
        Schedule.both(Schedule.recurs(30)), // Max 60 seconds
        Schedule.tapOutput(([, attempt]) =>
          session
            ? session.note(
                `Waiting for subnet to be available... (${(attempt + 1) * 2}s)`,
              )
            : Effect.void,
        ),
      ),
    }),
  );

/**
 * Wait for subnet to be deleted
 */
const waitForSubnetDeleted = (
  subnetId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeSubnets({ SubnetIds: [subnetId] })
      .pipe(
        Effect.catchTag("InvalidSubnetID.NotFound", () =>
          Effect.succeed({ Subnets: [] }),
        ),
      );

    if (!result.Subnets || result.Subnets.length === 0) {
      return; // Successfully deleted
    }

    // Still exists - this is the only retryable case
    return yield* new SubnetStillExists({ subnetId });
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof SubnetStillExists,
      schedule: Schedule.fixed(2000).pipe(
        Schedule.both(Schedule.recurs(15)), // Max 30 seconds
        Schedule.tapOutput(([, attempt]) =>
          session.note(
            `Waiting for subnet deletion... (${(attempt + 1) * 2}s)`,
          ),
        ),
      ),
    }),
  );
