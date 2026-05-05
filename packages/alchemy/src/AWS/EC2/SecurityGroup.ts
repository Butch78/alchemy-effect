import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { AWSEnvironment } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import type { VpcId } from "./Vpc.ts";

export type SecurityGroupId<ID extends string = string> = `sg-${ID}`;
export const SecurityGroupId = <ID extends string>(
  id: ID,
): ID & SecurityGroupId<ID> => `sg-${id}` as ID & SecurityGroupId<ID>;

export type SecurityGroupArn<
  GroupId extends SecurityGroupId = SecurityGroupId,
> = `arn:aws:ec2:${RegionID}:${AccountID}:security-group/${GroupId}`;

/**
 * Ingress or egress rule for a security group.
 */
export interface SecurityGroupRuleData {
  /**
   * The IP protocol name or number.
   * Use -1 to specify all protocols.
   */
  ipProtocol: string;

  /**
   * The start of the port range.
   * For ICMP, use the ICMP type number.
   */
  fromPort?: number;

  /**
   * The end of the port range.
   * For ICMP, use the ICMP code.
   */
  toPort?: number;

  /**
   * IPv4 CIDR ranges to allow.
   */
  cidrIpv4?: string;

  /**
   * IPv6 CIDR ranges to allow.
   */
  cidrIpv6?: string;

  /**
   * ID of a security group to allow traffic from/to.
   */
  referencedGroupId?: SecurityGroupId;

  /**
   * ID of a prefix list.
   */
  prefixListId?: string;

  /**
   * Description for the rule.
   */
  description?: string;
}

export interface SecurityGroupProps {
  /**
   * The VPC to create the security group in.
   */
  vpcId: VpcId;

  /**
   * The name of the security group.
   * If not provided, a name will be generated.
   */
  groupName?: string;

  /**
   * A description for the security group.
   * @default "Managed by Alchemy"
   */
  description?: string;

  /**
   * Inbound rules for the security group.
   */
  ingress?: SecurityGroupRuleData[];

  /**
   * Outbound rules for the security group.
   * If not specified, allows all outbound traffic by default.
   */
  egress?: SecurityGroupRuleData[];

  /**
   * Tags to assign to the security group.
   */
  tags?: Record<string, string>;
}

export interface SecurityGroup extends Resource<
  "AWS.EC2.SecurityGroup",
  SecurityGroupProps,
  {
    /**
     * The ID of the security group.
     */
    groupId: SecurityGroupId;

    /**
     * The Amazon Resource Name (ARN) of the security group.
     */
    groupArn: SecurityGroupArn;

    /**
     * The name of the security group.
     */
    groupName: string;

    /**
     * The description of the security group.
     */
    description: string;

    /**
     * The ID of the VPC for the security group.
     */
    vpcId: VpcId;

    /**
     * The ID of the AWS account that owns the security group.
     */
    ownerId: string;

    /**
     * The inbound rules associated with the security group.
     */
    ingressRules?: Array<{
      securityGroupRuleId: string;
      ipProtocol: string;
      fromPort?: number;
      toPort?: number;
      cidrIpv4?: string;
      cidrIpv6?: string;
      referencedGroupId?: string;
      prefixListId?: string;
      description?: string;
      isEgress: false;
    }>;

    /**
     * The outbound rules associated with the security group.
     */
    egressRules?: Array<{
      securityGroupRuleId: string;
      ipProtocol: string;
      fromPort?: number;
      toPort?: number;
      cidrIpv4?: string;
      cidrIpv6?: string;
      referencedGroupId?: string;
      prefixListId?: string;
      description?: string;
      isEgress: true;
    }>;
  },
  never,
  Providers
> {}
export const SecurityGroup = Resource<SecurityGroup>("AWS.EC2.SecurityGroup");

export const SecurityGroupProvider = () =>
  Provider.effect(
    SecurityGroup,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

      const createTags = Effect.fn(function* (
        id: string,
        tags?: Record<string, string>,
      ) {
        return {
          Name: id,
          ...(yield* createInternalTags(id)),
          ...tags,
        };
      });

      const createGroupName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return yield* createPhysicalName({ id, maxLength: 255 });
        });

      // Bounded retry for the eventual-consistency window right after
      // createSecurityGroup — describeSecurityGroups can briefly miss a
      // freshly-minted SG, surfacing as InvalidGroup.NotFound or an empty
      // result.
      const retryEventuallyConsistent = <A, E, R>(
        eff: Effect.Effect<A, E, R>,
      ) =>
        eff.pipe(
          Effect.retry({
            while: (e: { readonly _tag?: string } | unknown) =>
              (e as { readonly _tag?: string })?._tag ===
                "InvalidGroup.NotFound" ||
              (e as { readonly _tag?: string })?._tag ===
                "SecurityGroupNotVisible",
            schedule: Schedule.exponential(100).pipe(
              Schedule.both(Schedule.recurs(10)),
            ),
          }),
        );

      // Hard variant — fails if the SG isn't returned. Use only after we've
      // confirmed (or just minted) the SG and a missing result indicates a
      // genuine inconsistency. Wraps the lookup in `retryEventuallyConsistent`
      // so post-create races don't surface as hard failures.
      const describeSecurityGroup = (groupId: string) =>
        retryEventuallyConsistent(
          ec2.describeSecurityGroups({ GroupIds: [groupId] }).pipe(
            Effect.flatMap((r) =>
              r.SecurityGroups?.[0]
                ? Effect.succeed(r.SecurityGroups[0])
                : Effect.fail({
                    _tag: "SecurityGroupNotVisible" as const,
                    groupId,
                  }),
            ),
          ),
        );

      // Soft variant — InvalidGroup.NotFound (e.g. SG deleted out-of-band) is
      // collapsed into `undefined`. Use anywhere we want missing-as-empty
      // semantics during reconcile/read instead of propagating the error.
      const findSecurityGroup = (groupId: string) =>
        ec2
          .describeSecurityGroups({ GroupIds: [groupId] })
          .pipe(
            Effect.map((r) => r.SecurityGroups?.[0]),
            Effect.catchTag("InvalidGroup.NotFound", () =>
              Effect.succeed(undefined),
            ),
          );

      const describeSecurityGroupRules = (groupId: string) =>
        ec2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [groupId] }],
        });

      // Stable canonical form of an SG rule used for diffing observed cloud
      // rules against the desired set. Includes everything that affects rule
      // identity in AWS (protocol/ports/source) plus the description. AWS
      // collapses identical rule shapes into one rule even when authorize is
      // called multiple times, so this canonicalization is what matches.
      const canonicalRuleKey = (rule: {
        ipProtocol: string;
        fromPort: number | undefined;
        toPort: number | undefined;
        cidrIpv4: string | undefined;
        cidrIpv6: string | undefined;
        referencedGroupId: string | undefined;
        prefixListId: string | undefined;
        description: string | undefined;
      }) =>
        JSON.stringify({
          ipProtocol: rule.ipProtocol,
          fromPort: rule.fromPort ?? null,
          toPort: rule.toPort ?? null,
          cidrIpv4: rule.cidrIpv4 ?? null,
          cidrIpv6: rule.cidrIpv6 ?? null,
          referencedGroupId: rule.referencedGroupId ?? null,
          prefixListId: rule.prefixListId ?? null,
          description: rule.description ?? null,
        });

      const observedToCanonical = (rule: ec2.SecurityGroupRule) => ({
        ipProtocol: rule.IpProtocol!,
        fromPort: rule.FromPort,
        toPort: rule.ToPort,
        cidrIpv4: rule.CidrIpv4,
        cidrIpv6: rule.CidrIpv6,
        referencedGroupId: rule.ReferencedGroupInfo?.GroupId,
        prefixListId: rule.PrefixListId,
        description: rule.Description,
      });

      const desiredToCanonical = (rule: SecurityGroupRuleData) => ({
        ipProtocol: rule.ipProtocol,
        fromPort: rule.fromPort,
        toPort: rule.toPort,
        cidrIpv4: rule.cidrIpv4,
        cidrIpv6: rule.cidrIpv6,
        referencedGroupId: rule.referencedGroupId,
        prefixListId: rule.prefixListId,
        description: rule.description,
      });

      const toAttrs = (
        sg: ec2.SecurityGroup,
        rules: ec2.SecurityGroupRule[],
      ): SecurityGroup["Attributes"] => ({
        groupId: sg.GroupId as SecurityGroupId,
        groupArn:
          `arn:aws:ec2:${region}:${accountId}:security-group/${sg.GroupId as SecurityGroupId}` as SecurityGroupArn,
        groupName: sg.GroupName!,
        description: sg.Description!,
        vpcId: sg.VpcId as VpcId,
        ownerId: sg.OwnerId!,
        ingressRules: rules
          .filter((r) => !r.IsEgress)
          .map((r) => ({
            securityGroupRuleId: r.SecurityGroupRuleId!,
            ipProtocol: r.IpProtocol!,
            fromPort: r.FromPort,
            toPort: r.ToPort,
            cidrIpv4: r.CidrIpv4,
            cidrIpv6: r.CidrIpv6,
            referencedGroupId: r.ReferencedGroupInfo?.GroupId,
            prefixListId: r.PrefixListId,
            description: r.Description,
            isEgress: false as const,
          })),
        egressRules: rules
          .filter((r) => r.IsEgress)
          .map((r) => ({
            securityGroupRuleId: r.SecurityGroupRuleId!,
            ipProtocol: r.IpProtocol!,
            fromPort: r.FromPort,
            toPort: r.ToPort,
            cidrIpv4: r.CidrIpv4,
            cidrIpv6: r.CidrIpv6,
            referencedGroupId: r.ReferencedGroupInfo?.GroupId,
            prefixListId: r.PrefixListId,
            description: r.Description,
            isEgress: true as const,
          })),
      });

      const toIpPermission = (
        rule: SecurityGroupRuleData,
      ): ec2.IpPermission => ({
        IpProtocol: rule.ipProtocol,
        FromPort: rule.fromPort,
        ToPort: rule.toPort,
        IpRanges: rule.cidrIpv4
          ? [{ CidrIp: rule.cidrIpv4, Description: rule.description }]
          : undefined,
        Ipv6Ranges: rule.cidrIpv6
          ? [{ CidrIpv6: rule.cidrIpv6, Description: rule.description }]
          : undefined,
        UserIdGroupPairs: rule.referencedGroupId
          ? [
              {
                GroupId: rule.referencedGroupId as string,
                Description: rule.description,
              },
            ]
          : undefined,
        PrefixListIds: rule.prefixListId
          ? [
              {
                PrefixListId: rule.prefixListId as string,
                Description: rule.description,
              },
            ]
          : undefined,
      });

      return {
        stables: ["groupId", "groupArn", "ownerId"],

        read: Effect.fn(function* ({ id, output }) {
          // Fast path — if state has the groupId, look it up directly. A
          // missing result here means the SG was deleted out of band; surface
          // as `undefined` so the engine treats it as a fresh create rather
          // than failing the read.
          let sg: ec2.SecurityGroup | undefined;
          if (output?.groupId) {
            sg = yield* findSecurityGroup(output.groupId);
          } else {
            // Slow path / adoption — search by alchemy tags so a wiped state
            // file can re-discover an SG we previously created.
            const filters = yield* createAlchemyTagFilters(id);
            const found = yield* ec2.describeSecurityGroups({
              Filters: filters,
            });
            sg = found.SecurityGroups?.[0];
          }
          if (!sg) return undefined;
          const rulesResult = yield* describeSecurityGroupRules(sg.GroupId!);
          const attrs = toAttrs(sg, rulesResult.SecurityGroupRules ?? []);
          // Foreign-tagged SGs require explicit `adopt(true)` to take over.
          const tagRecord = Object.fromEntries(
            (sg.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          );
          return (yield* hasAlchemyTags(id, tagRecord))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return;
          // VPC change requires replacement
          if (news.vpcId !== olds.vpcId) {
            return { action: "replace" };
          }

          // Group name change requires replacement
          const newGroupName = yield* createGroupName(id, news.groupName);
          const oldGroupName = output?.groupName
            ? output.groupName
            : yield* createGroupName(id, olds.groupName);
          if (newGroupName !== oldGroupName) {
            return { action: "replace" };
          }

          // Other changes can be updated in-place
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const groupName = yield* createGroupName(id, news.groupName);
          const desiredTags = yield* createTags(id, news.tags);

          // Observe — find the SG via cached id, else fall through to create.
          let sg: ec2.SecurityGroup | undefined;
          if (output?.groupId) {
            const lookup = yield* ec2
              .describeSecurityGroups({ GroupIds: [output.groupId] })
              .pipe(
                Effect.catchTag("InvalidGroup.NotFound", () =>
                  Effect.succeed({ SecurityGroups: [] }),
                ),
              );
            sg = lookup.SecurityGroups?.[0];
          }

          // Ensure — create the SG when missing.
          if (sg === undefined) {
            yield* session.note(`Creating Security Group: ${groupName}`);
            const result = yield* ec2.createSecurityGroup({
              GroupName: groupName,
              Description: news.description ?? "Managed by Alchemy",
              VpcId: news.vpcId as string,
              TagSpecifications: [
                {
                  ResourceType: "security-group",
                  Tags: createTagsList(desiredTags),
                },
              ],
              DryRun: false,
            });
            const newGroupId = result.GroupId! as SecurityGroupId;
            yield* session.note(`Security Group created: ${newGroupId}`);
            sg = yield* describeSecurityGroup(newGroupId);
          }

          const groupId = sg.GroupId! as SecurityGroupId;

          // Sync tags — observed cloud tags vs desired.
          const currentTags = Object.fromEntries(
            (sg.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const { removed: removedTags, upsert: upsertTags } = diffTags(
            currentTags,
            desiredTags,
          );
          if (removedTags.length > 0) {
            yield* ec2.deleteTags({
              Resources: [groupId],
              Tags: removedTags.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsertTags.length > 0) {
            yield* ec2.createTags({
              Resources: [groupId],
              Tags: upsertTags,
              DryRun: false,
            });
          }

          // Sync ingress + egress rules — diff observed canonical rules
          // against desired and apply only the delta. AWS deduplicates
          // identical rule shapes into a single rule, so a stable canonical
          // key (protocol + port range + source + description) drives the
          // diff. Default egress (-1, 0.0.0.0/0) is the AWS-side default
          // when an SG is created and is reapplied here when no explicit
          // egress is desired so out-of-band revocation converges back.
          const currentRulesResult = yield* describeSecurityGroupRules(groupId);
          const currentRules = currentRulesResult.SecurityGroupRules ?? [];
          const observedIngress = currentRules.filter((r) => !r.IsEgress);
          const observedEgress = currentRules.filter((r) => r.IsEgress);

          const desiredIngress = news.ingress ?? [];
          const desiredEgress: SecurityGroupRuleData[] =
            news.egress && news.egress.length > 0
              ? news.egress
              : [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }];

          const syncRules = (
            observed: ec2.SecurityGroupRule[],
            desired: SecurityGroupRuleData[],
            kind: "ingress" | "egress",
          ) =>
            Effect.gen(function* () {
              const observedKeys = new Map(
                observed.map((r) => [
                  canonicalRuleKey(observedToCanonical(r)),
                  r,
                ]),
              );
              const desiredKeys = new Map(
                desired.map((r) => [
                  canonicalRuleKey(desiredToCanonical(r)),
                  r,
                ]),
              );
              const toRevoke = [...observedKeys.entries()]
                .filter(([k]) => !desiredKeys.has(k))
                .map(([, r]) => r.SecurityGroupRuleId!)
                .filter((x): x is string => Boolean(x));
              const toAuthorize = [...desiredKeys.entries()]
                .filter(([k]) => !observedKeys.has(k))
                .map(([, r]) => r);

              if (toRevoke.length > 0) {
                const revokeReq = {
                  GroupId: groupId,
                  SecurityGroupRuleIds: toRevoke,
                  DryRun: false,
                };
                if (kind === "ingress") {
                  yield* ec2
                    .revokeSecurityGroupIngress(revokeReq)
                    .pipe(
                      Effect.catchTag(
                        "InvalidPermission.NotFound",
                        () => Effect.void,
                      ),
                    );
                } else {
                  yield* ec2
                    .revokeSecurityGroupEgress(revokeReq)
                    .pipe(
                      Effect.catchTag(
                        "InvalidPermission.NotFound",
                        () => Effect.void,
                      ),
                    );
                }
                yield* session.note(
                  `Revoked ${toRevoke.length} ${kind} rules`,
                );
              }
              if (toAuthorize.length > 0) {
                const authorizeReq = {
                  GroupId: groupId,
                  IpPermissions: toAuthorize.map(toIpPermission),
                  DryRun: false,
                };
                if (kind === "ingress") {
                  yield* ec2.authorizeSecurityGroupIngress(authorizeReq);
                } else {
                  yield* ec2.authorizeSecurityGroupEgress(authorizeReq);
                }
                yield* session.note(
                  `Authorized ${toAuthorize.length} ${kind} rules`,
                );
              }
            });

          yield* syncRules(observedIngress, desiredIngress, "ingress");
          yield* syncRules(observedEgress, desiredEgress, "egress");

          // Re-read final state via the bounded eventual-consistency retry.
          const finalSg = yield* describeSecurityGroup(groupId);
          const finalRules = yield* describeSecurityGroupRules(groupId);
          return toAttrs(finalSg, finalRules.SecurityGroupRules ?? []);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const groupId = output.groupId;

          yield* session.note(`Deleting Security Group: ${groupId}`);

          yield* ec2
            .deleteSecurityGroup({
              GroupId: groupId,
              DryRun: false,
            })
            .pipe(
              Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
              // Retry on dependency violations (e.g., ENIs still using the
              // security group). Distilled tags `DependencyViolation`
              // directly via `withDependencyViolationError`, so a substring
              // match against `ValidationError.message` is dead code that
              // would only swallow unrelated ValidationErrors.
              Effect.retry({
                while: (e) => e._tag === "DependencyViolation",
                schedule: Schedule.fixed(5000).pipe(
                  Schedule.both(Schedule.recurs(30)), // Up to ~2.5 minutes
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
            );

          yield* session.note(`Security Group ${groupId} deleted`);
        }),
      };
    }),
  );
