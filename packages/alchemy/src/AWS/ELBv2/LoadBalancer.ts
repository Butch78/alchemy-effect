import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { RegionID } from "../Region.ts";
import * as Data from "effect/Data";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";

export type LoadBalancerName = string;
export type LoadBalancerArn =
  `arn:aws:elasticloadbalancing:${RegionID}:${AccountID}:loadbalancer/${string}`;

export interface LoadBalancerProps {
  name?: string;
  scheme?: "internal" | "internet-facing";
  type?: "application" | "network";
  subnets: Input<SubnetId[]>;
  securityGroups?: Input<SecurityGroupId[]>;
  ipAddressType?: string;
  attributes?: Record<string, string>;
  tags?: Record<string, string>;
}

export interface LoadBalancer extends Resource<
  "AWS.ELBv2.LoadBalancer",
  LoadBalancerProps,
  {
    loadBalancerArn: LoadBalancerArn;
    loadBalancerName: LoadBalancerName;
    dnsName: string;
    canonicalHostedZoneId: string;
    vpcId: string;
    scheme: string;
    type: string;
    securityGroups: string[];
    subnets: string[];
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

export const LoadBalancer = Resource<LoadBalancer>("AWS.ELBv2.LoadBalancer");

export const LoadBalancerProvider = () =>
  Provider.effect(
    LoadBalancer,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 32, lowercase: true });

      return {
        stables: [
          "loadBalancerArn",
          "loadBalancerName",
          "dnsName",
          "canonicalHostedZoneId",
          "vpcId",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (
            !deepEqual(
              {
                scheme: olds.scheme ?? "internet-facing",
                type: olds.type ?? "application",
                subnets: olds.subnets,
                securityGroups: olds.securityGroups ?? [],
                ipAddressType: olds.ipAddressType,
              },
              {
                scheme: news.scheme ?? "internet-facing",
                type: news.type ?? "application",
                subnets: news.subnets,
                securityGroups: news.securityGroups ?? [],
                ipAddressType: news.ipAddressType,
              },
            )
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, output }) {
          if (!output) {
            return undefined;
          }
          // Look up by ARN if we have it (faster, and survives deletion-and-
          // recreate of a same-named LB).
          const described = yield* elbv2
            .describeLoadBalancers({
              LoadBalancerArns: [output.loadBalancerArn],
            })
            .pipe(
              Effect.catchTag("LoadBalancerNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const loadBalancer = described?.LoadBalancers?.[0];
          if (!loadBalancer?.LoadBalancerArn) {
            return undefined;
          }
          // Read tags from the cloud, not the cached output, so adoption
          // sees the truth.
          const observedTags = yield* fetchObservedTags(
            loadBalancer.LoadBalancerArn,
          );
          const attrs = {
            ...output,
            dnsName: loadBalancer.DNSName!,
            canonicalHostedZoneId: loadBalancer.CanonicalHostedZoneId!,
            vpcId: loadBalancer.VpcId!,
            scheme: loadBalancer.Scheme!,
            type: loadBalancer.Type!,
            securityGroups: loadBalancer.SecurityGroups ?? [],
            subnets:
              loadBalancer.AvailabilityZones?.flatMap((zone) =>
                zone.SubnetId ? [zone.SubnetId] : [],
              ) ?? [],
            tags: observedTags,
          };
          return (yield* hasAlchemyTags(id, observedTags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const name = yield* toName(id, news);
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — look up by deterministic name. `LoadBalancerNotFound`
          // is the "doesn't exist yet" signal; nothing else is a race that
          // we want to swallow.
          let loadBalancer = yield* describeByName(name);

          // Ensure — create if missing. The replacement axes (scheme, type,
          // subnets, securityGroups, ipAddressType) are handled by diff so
          // we don't need to deal with mismatches here. We tolerate
          // `DuplicateLoadBalancerName` as a race with a peer reconciler:
          // re-describe and continue.
          if (!loadBalancer?.LoadBalancerArn) {
            loadBalancer = yield* elbv2
              .createLoadBalancer({
                Name: name,
                Scheme: news.scheme ?? "internet-facing",
                Type: news.type ?? "application",
                Subnets: news.subnets as string[],
                SecurityGroups: news.securityGroups as string[] | undefined,
                IpAddressType: news.ipAddressType,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.map((created) => created.LoadBalancers?.[0]),
                Effect.catchTag(
                  "DuplicateLoadBalancerNameException",
                  () => describeByName(name),
                ),
              );
            if (!loadBalancer?.LoadBalancerArn) {
              return yield* Effect.die(
                new Error("createLoadBalancer returned no load balancer"),
              );
            }
          }

          const loadBalancerArn =
            loadBalancer.LoadBalancerArn as LoadBalancerArn;

          // Wait for `active` before mutating — `modifyLoadBalancerAttributes`
          // and tag operations against an LB still in `provisioning` can
          // race or fail with `OperationNotPermitted`. ALB provisioning
          // typically completes in 30-60s; cap the wait at 5 minutes.
          loadBalancer = yield* waitForLoadBalancerActive(
            loadBalancerArn,
            session,
          );

          // Sync attributes — observed ↔ desired. We always apply when
          // desired attrs are non-empty; AWS rejects an empty list anyway,
          // and reading observed attributes is an extra round-trip we
          // don't need for convergence.
          if (news.attributes && Object.keys(news.attributes).length > 0) {
            yield* elbv2.modifyLoadBalancerAttributes({
              LoadBalancerArn: loadBalancerArn,
              Attributes: Object.entries(news.attributes).map(
                ([Key, Value]) => ({
                  Key,
                  Value,
                }),
              ),
            });
          }

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = yield* fetchObservedTags(loadBalancerArn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* elbv2.addTags({
              ResourceArns: [loadBalancerArn],
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* elbv2.removeTags({
              ResourceArns: [loadBalancerArn],
              TagKeys: removed,
            });
          }

          yield* session.note(loadBalancerArn);
          return {
            loadBalancerArn,
            loadBalancerName: loadBalancer.LoadBalancerName!,
            dnsName: loadBalancer.DNSName!,
            canonicalHostedZoneId: loadBalancer.CanonicalHostedZoneId!,
            vpcId: loadBalancer.VpcId!,
            scheme: loadBalancer.Scheme!,
            type: loadBalancer.Type!,
            securityGroups: loadBalancer.SecurityGroups ?? [],
            subnets:
              loadBalancer.AvailabilityZones?.flatMap((zone) =>
                zone.SubnetId ? [zone.SubnetId] : [],
              ) ?? [],
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          // Tolerate the LB having already been deleted out-of-band, and
          // ride out `ResourceInUse` (eventual-consistency: a listener or
          // target-group attachment racing with us). Cap at 2 minutes so we
          // surface persistent in-use failures (e.g. deletion protection
          // enabled) instead of looping forever.
          yield* elbv2
            .deleteLoadBalancer({
              LoadBalancerArn: output.loadBalancerArn,
            })
            .pipe(
              Effect.catchTag(
                "LoadBalancerNotFoundException",
                () => Effect.void,
              ),
              Effect.retry({
                while: (e) => e._tag === "ResourceInUseException",
                schedule: Schedule.fixed(5000).pipe(
                  Schedule.both(Schedule.recurs(24)),
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `LoadBalancer in use, retrying delete... (${
                        (attempt + 1) * 5
                      }s)`,
                    ),
                  ),
                ),
              }),
            );
        }),
      };
    }),
  );

class LoadBalancerNotActive extends Data.TaggedError("LoadBalancerNotActive")<{
  arn: string;
  state: string;
}> {}

const waitForLoadBalancerActive = (
  loadBalancerArn: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* elbv2.describeLoadBalancers({
      LoadBalancerArns: [loadBalancerArn],
    });
    const loadBalancer = result.LoadBalancers?.[0];
    if (!loadBalancer) {
      return yield* Effect.die(
        new Error(
          `LoadBalancer ${loadBalancerArn} disappeared while waiting for active state`,
        ),
      );
    }
    const state = loadBalancer.State?.Code ?? "unknown";
    if (state === "active") {
      return loadBalancer;
    }
    if (state === "failed") {
      return yield* Effect.die(
        new Error(
          `LoadBalancer ${loadBalancerArn} entered failed state: ${
            loadBalancer.State?.Reason ?? "no reason given"
          }`,
        ),
      );
    }
    return yield* new LoadBalancerNotActive({ arn: loadBalancerArn, state });
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof LoadBalancerNotActive,
      schedule: Schedule.fixed(5000).pipe(
        Schedule.both(Schedule.recurs(60)), // up to 5 minutes
        Schedule.tapOutput(([, attempt]) =>
          session.note(
            `Waiting for LoadBalancer to be active... (${(attempt + 1) * 5}s)`,
          ),
        ),
      ),
    }),
  );

const describeByName = (name: string) =>
  elbv2
    .describeLoadBalancers({ Names: [name] })
    .pipe(
      Effect.map((r) => r.LoadBalancers?.[0]),
      Effect.catchTag("LoadBalancerNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const fetchObservedTags = (
  loadBalancerArn: string,
): Effect.Effect<Record<string, string>, any, any> =>
  elbv2
    .describeTags({ ResourceArns: [loadBalancerArn] })
    .pipe(
      Effect.map((r) =>
        Object.fromEntries(
          (r.TagDescriptions?.[0]?.Tags ?? [])
            .filter(
              (t): t is { Key: string; Value: string } =>
                typeof t.Key === "string" && typeof t.Value === "string",
            )
            .map((t) => [t.Key, t.Value]),
        ),
      ),
      // The LB can race away under us between the create and the tag fetch
      // (rare, but possible in adoption flows). Treat that as "no tags".
      Effect.catchTag("LoadBalancerNotFoundException", () =>
        Effect.succeed({} as Record<string, string>),
      ),
    );
