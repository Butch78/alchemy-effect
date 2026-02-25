import * as ec2 from "distilled-aws/ec2";
import * as Effect from "effect/Effect";

import type { Input } from "../../Input.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { SecurityGroupId } from "./SecurityGroup.ts";

export const SecurityGroupRule = Resource<{
  <const ID extends string, const Props extends SecurityGroupRuleProps>(
    id: ID,
    props: Props,
  ): Effect.Effect<SecurityGroupRule<ID, Props>>;
}>("AWS.EC2.SecurityGroupRule");

export interface SecurityGroupRule<
  ID extends string = string,
  Props extends SecurityGroupRuleProps = SecurityGroupRuleProps,
> extends Resource<
  SecurityGroupRule,
  "AWS.EC2.SecurityGroupRule",
  ID,
  Props,
  SecurityGroupRuleAttrs<Input.Resolve<Props>>
> {}

export type SecurityGroupRuleId<ID extends string = string> = `sgr-${ID}`;
export const SecurityGroupRuleId = <ID extends string>(
  id: ID,
): ID & SecurityGroupRuleId<ID> => `sgr-${id}` as ID & SecurityGroupRuleId<ID>;

export interface SecurityGroupRuleProps {
  /**
   * The ID of the security group.
   */
  groupId: Input<SecurityGroupId>;

  /**
   * Whether this is an ingress (inbound) or egress (outbound) rule.
   */
  type: "ingress" | "egress";

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
   * IPv4 CIDR range to allow.
   */
  cidrIpv4?: string;

  /**
   * IPv6 CIDR range to allow.
   */
  cidrIpv6?: string;

  /**
   * ID of a security group to allow traffic from/to.
   */
  referencedGroupId?: Input<SecurityGroupId>;

  /**
   * ID of a prefix list.
   */
  prefixListId?: Input<string>;

  /**
   * Description for the rule.
   */
  description?: string;

  /**
   * Tags to assign to the security group rule.
   */
  tags?: Record<string, Input<string>>;
}

export interface SecurityGroupRuleAttrs<
  Props extends Input.Resolve<SecurityGroupRuleProps> =
    Input.Resolve<SecurityGroupRuleProps>,
> {
  /**
   * The ID of the security group rule.
   */
  securityGroupRuleId: SecurityGroupRuleId;

  /**
   * The ID of the security group.
   */
  groupId: Props["groupId"];

  /**
   * The ID of the AWS account that owns the security group.
   */
  groupOwnerId: string;

  /**
   * Whether this is an egress rule.
   */
  isEgress: Props["type"] extends "egress" ? true : false;

  /**
   * The IP protocol.
   */
  ipProtocol: Props["ipProtocol"];

  /**
   * The start of the port range.
   */
  fromPort?: number;

  /**
   * The end of the port range.
   */
  toPort?: number;

  /**
   * The IPv4 CIDR range.
   */
  cidrIpv4?: Props["cidrIpv4"];

  /**
   * The IPv6 CIDR range.
   */
  cidrIpv6?: Props["cidrIpv6"];

  /**
   * The ID of the referenced security group.
   */
  referencedGroupId?: string;

  /**
   * The ID of the prefix list.
   */
  prefixListId?: string;

  /**
   * The description.
   */
  description?: Props["description"];
}

export const SecurityGroupRuleProvider = () =>
  SecurityGroupRule.provider.effect(
    Effect.gen(function* () {
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

      const describeRule = (ruleId: string) =>
        ec2.describeSecurityGroupRules({ SecurityGroupRuleIds: [ruleId] }).pipe(
          Effect.map((r) => r.SecurityGroupRules?.[0]),
          Effect.flatMap((rule) =>
            rule
              ? Effect.succeed(rule)
              : Effect.fail(
                  new Error(`Security Group Rule ${ruleId} not found`),
                ),
          ),
        );

      const toAttrs = (
        rule: Awaited<
          ReturnType<
            typeof describeRule extends (
              ...args: any
            ) => Effect.Effect<infer R, any, any>
              ? () => Promise<R>
              : never
          >
        >,
      ): SecurityGroupRuleAttrs => ({
        securityGroupRuleId: rule.SecurityGroupRuleId as SecurityGroupRuleId,
        groupId: rule.GroupId as SecurityGroupId,
        groupOwnerId: rule.GroupOwnerId!,
        isEgress: rule.IsEgress as any,
        ipProtocol: rule.IpProtocol!,
        fromPort: rule.FromPort,
        toPort: rule.ToPort,
        cidrIpv4: rule.CidrIpv4,
        cidrIpv6: rule.CidrIpv6,
        referencedGroupId: rule.ReferencedGroupInfo?.GroupId,
        prefixListId: rule.PrefixListId,
        description: rule.Description,
      });

      return {
        stables: ["securityGroupRuleId", "groupOwnerId"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const rule = yield* describeRule(output.securityGroupRuleId);
          return toAttrs(rule);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          // Most properties require replacement
          if (
            news.groupId !== olds.groupId ||
            news.type !== olds.type ||
            news.ipProtocol !== olds.ipProtocol ||
            news.fromPort !== olds.fromPort ||
            news.toPort !== olds.toPort ||
            news.cidrIpv4 !== olds.cidrIpv4 ||
            news.cidrIpv6 !== olds.cidrIpv6 ||
            news.referencedGroupId !== olds.referencedGroupId ||
            news.prefixListId !== olds.prefixListId
          ) {
            return { action: "replace" };
          }
          // Description and tags can be updated
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          yield* session.note(`Creating Security Group Rule...`);

          const ipPermission = {
            IpProtocol: news.ipProtocol,
            FromPort: news.fromPort,
            ToPort: news.toPort,
            IpRanges: news.cidrIpv4
              ? [{ CidrIp: news.cidrIpv4, Description: news.description }]
              : undefined,
            Ipv6Ranges: news.cidrIpv6
              ? [{ CidrIpv6: news.cidrIpv6, Description: news.description }]
              : undefined,
            UserIdGroupPairs: news.referencedGroupId
              ? [
                  {
                    GroupId: news.referencedGroupId as string,
                    Description: news.description,
                  },
                ]
              : undefined,
            PrefixListIds: news.prefixListId
              ? [
                  {
                    PrefixListId: news.prefixListId as string,
                    Description: news.description,
                  },
                ]
              : undefined,
          };

          let ruleId: string;

          if (news.type === "ingress") {
            const result = yield* ec2.authorizeSecurityGroupIngress({
              GroupId: news.groupId as string,
              IpPermissions: [ipPermission],
              TagSpecifications: [
                {
                  ResourceType: "security-group-rule",
                  Tags: createTagsList(yield* createTags(id, news.tags)),
                },
              ],
              DryRun: false,
            });
            ruleId = result.SecurityGroupRules?.[0]?.SecurityGroupRuleId!;
          } else {
            const result = yield* ec2.authorizeSecurityGroupEgress({
              GroupId: news.groupId as string,
              IpPermissions: [ipPermission],
              TagSpecifications: [
                {
                  ResourceType: "security-group-rule",
                  Tags: createTagsList(yield* createTags(id, news.tags)),
                },
              ],
              DryRun: false,
            });
            ruleId = result.SecurityGroupRules?.[0]?.SecurityGroupRuleId!;
          }

          yield* session.note(`Security Group Rule created: ${ruleId}`);

          const rule = yield* describeRule(ruleId);
          return toAttrs(rule);
        }),

        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const ruleId = output.securityGroupRuleId;

          // Update description if changed
          if (news.description !== olds.description) {
            yield* ec2.modifySecurityGroupRules({
              GroupId: news.groupId as string,
              SecurityGroupRules: [
                {
                  SecurityGroupRuleId: ruleId,
                  SecurityGroupRule: {
                    IpProtocol: news.ipProtocol,
                    FromPort: news.fromPort,
                    ToPort: news.toPort,
                    CidrIpv4: news.cidrIpv4,
                    CidrIpv6: news.cidrIpv6,
                    ReferencedGroupId: news.referencedGroupId as
                      | string
                      | undefined,
                    PrefixListId: news.prefixListId as string | undefined,
                    Description: news.description,
                  },
                },
              ],
            });
            yield* session.note("Updated description");
          }

          // Handle tag updates
          const newTags = yield* createTags(id, news.tags);
          const oldTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [ruleId] },
                  { Name: "resource-type", Values: ["security-group-rule"] },
                ],
              })
              .pipe(
                Effect.map(
                  (r) =>
                    Object.fromEntries(
                      r.Tags?.map((t) => [t.Key!, t.Value!]) ?? [],
                    ) as Record<string, string>,
                ),
              )) ?? {};

          const { removed, upsert } = diffTags(oldTags, newTags);

          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [ruleId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [ruleId],
              Tags: upsert,
              DryRun: false,
            });
            yield* session.note("Updated tags");
          }

          const rule = yield* describeRule(ruleId);
          return toAttrs(rule);
        }),

        delete: Effect.fn(function* ({ olds, output, session }) {
          const ruleId = output.securityGroupRuleId;

          yield* session.note(`Deleting Security Group Rule: ${ruleId}`);

          if (olds.type === "ingress") {
            yield* ec2
              .revokeSecurityGroupIngress({
                GroupId: olds.groupId as string,
                SecurityGroupRuleIds: [ruleId],
                DryRun: false,
              })
              .pipe(
                Effect.catchTag(
                  "InvalidPermission.NotFound",
                  () => Effect.void,
                ),
              );
          } else {
            yield* ec2
              .revokeSecurityGroupEgress({
                GroupId: olds.groupId as string,
                SecurityGroupRuleIds: [ruleId],
                DryRun: false,
              })
              .pipe(
                Effect.catchTag(
                  "InvalidPermission.NotFound",
                  () => Effect.void,
                ),
              );
          }

          yield* session.note(`Security Group Rule ${ruleId} deleted`);
        }),
      };
    }),
  );
