import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as IAM from "@distilled.cloud/aws/iam";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const assumeRolePolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: {
        Service: "lambda.amazonaws.com",
      },
      Action: ["sts:AssumeRole"],
    },
  ],
};

test.provider("create, update, and delete role", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const role = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Role("IamRole", {
          assumeRolePolicyDocument: assumeRolePolicy,
          managedPolicyArns: [
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
          inlinePolicies: {
            AllowLogs: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["logs:CreateLogGroup"],
                  Resource: "*",
                },
              ],
            },
          },
          tags: {
            env: "test",
          },
        });
      }),
    );

    const created = yield* IAM.getRole({
      RoleName: role.roleName,
    });
    expect(created.Role.RoleName).toBe(role.roleName);

    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Role("IamRole", {
          assumeRolePolicyDocument: assumeRolePolicy,
          managedPolicyArns: [],
          inlinePolicies: {
            AllowLogs: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["logs:CreateLogStream"],
                  Resource: "*",
                },
              ],
            },
          },
          tags: {
            env: "prod",
          },
        });
      }),
    );

    const updatedTags = yield* IAM.listRoleTags({
      RoleName: role.roleName,
    });
    expect(
      Object.fromEntries(
        (updatedTags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
      ),
    ).toMatchObject({
      env: "prod",
    });

    yield* stack.destroy();

    const deleted = yield* IAM.getRole({
      RoleName: role.roleName,
    }).pipe(Effect.option);
    expect(deleted._tag).toBe("None");
  }),
);

// Engine-level adoption tests for IAM Role. Note: the user must supply an
// explicit `roleName` for adoption to work across a state-store wipe —
// without one, `createPhysicalName` derives a fresh name from a per-deploy
// random `instanceId`, so the cold-start `read` lookup would never find
// the original role.
test.provider(
  "owned role (matching alchemy tags) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const roleName = `alchemy-test-role-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("AdoptableRole", {
            roleName,
            assumeRolePolicyDocument: assumeRolePolicy,
          });
        }),
      );

      // Wipe state — the role stays in IAM.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableRole",
        });
      }).pipe(Effect.provide(stack.state));

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("AdoptableRole", {
            roleName,
            assumeRolePolicyDocument: assumeRolePolicy,
          });
        }),
      );

      expect(adopted.roleArn).toEqual(initial.roleArn);
      expect(adopted.roleName).toEqual(roleName);

      yield* stack.destroy();

      const deleted = yield* IAM.getRole({ RoleName: roleName }).pipe(
        Effect.option,
      );
      expect(deleted._tag).toBe("None");
    }),
);

test.provider(
  "foreign-tagged role requires adopt(true) to take over",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Use a deterministic shared physical name for both deploys.
      const sharedRoleName = `alchemy-test-role-takeover-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("Original", {
            roleName: sharedRoleName,
            assumeRolePolicyDocument: assumeRolePolicy,
          });
        }),
      );

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
            return yield* Role("Different", {
              roleName: sharedRoleName,
              assumeRolePolicyDocument: assumeRolePolicy,
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.roleArn).toEqual(original.roleArn);

      // After adoption, tags should now identify this stack/stage/id.
      const tagsResp = yield* IAM.listRoleTags({ RoleName: sharedRoleName });
      const tagMap = Object.fromEntries(
        (tagsResp.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagMap["alchemy::id"]).toEqual("Different");

      yield* stack.destroy();

      const deleted = yield* IAM.getRole({ RoleName: sharedRoleName }).pipe(
        Effect.option,
      );
      expect(deleted._tag).toBe("None");
    }),
);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("IdempotentRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
            inlinePolicies: {
              AllowLogs: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["logs:CreateLogGroup"],
                    Resource: "*",
                  },
                ],
              },
            },
            tags: { env: "test" },
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("IdempotentRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
            inlinePolicies: {
              AllowLogs: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["logs:CreateLogGroup"],
                    Resource: "*",
                  },
                ],
              },
            },
            tags: { env: "test" },
          });
        }),
      );

      expect(second.roleArn).toEqual(initial.roleArn);
      expect(second.roleName).toEqual(initial.roleName);

      yield* stack.destroy();

      const deleted = yield* IAM.getRole({ RoleName: initial.roleName }).pipe(
        Effect.option,
      );
      expect(deleted._tag).toBe("None");
    }),
);

test.provider(
  "reconcile resets assume-role policy and inline policies mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const role = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("DriftRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
            inlinePolicies: {
              AllowLogs: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["logs:CreateLogGroup"],
                    Resource: "*",
                  },
                ],
              },
            },
          });
        }),
      );

      // Mutate the assume-role policy out-of-band.
      const driftedAssume = {
        Version: "2012-10-17" as const,
        Statement: [
          {
            Effect: "Allow" as const,
            Principal: { Service: "ec2.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      };
      yield* IAM.updateAssumeRolePolicy({
        RoleName: role.roleName,
        PolicyDocument: JSON.stringify(driftedAssume),
      });

      // Mutate the inline policy out-of-band.
      yield* IAM.putRolePolicy({
        RoleName: role.roleName,
        PolicyName: "AllowLogs",
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Deny",
              Action: "*",
              Resource: "*",
            },
          ],
        }),
      });

      // Re-deploy with the original desired state — reconcile must reset.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("DriftRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
            inlinePolicies: {
              AllowLogs: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["logs:CreateLogGroup"],
                    Resource: "*",
                  },
                ],
              },
            },
          });
        }),
      );

      const observed = yield* IAM.getRole({ RoleName: role.roleName });
      const observedAssume = JSON.parse(
        decodeURIComponent(observed.Role.AssumeRolePolicyDocument ?? ""),
      );
      expect(observedAssume.Statement[0].Principal.Service).toEqual(
        "lambda.amazonaws.com",
      );

      const observedInline = yield* IAM.getRolePolicy({
        RoleName: role.roleName,
        PolicyName: "AllowLogs",
      });
      const observedDoc = JSON.parse(
        decodeURIComponent(observedInline.PolicyDocument ?? ""),
      );
      expect(observedDoc.Statement[0].Effect).toEqual("Allow");
      expect(observedDoc.Statement[0].Action).toEqual([
        "logs:CreateLogGroup",
      ]);

      yield* stack.destroy();

      const deleted = yield* IAM.getRole({ RoleName: role.roleName }).pipe(
        Effect.option,
      );
      expect(deleted._tag).toBe("None");
    }),
);

test.provider(
  "reconcile re-creates a role that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const roleName = `alchemy-test-role-recreate-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("RecreateRole", {
            roleName,
            assumeRolePolicyDocument: assumeRolePolicy,
          });
        }),
      );
      expect(initial.roleName).toEqual(roleName);

      // Out-of-band: delete the role.
      yield* IAM.deleteRole({ RoleName: roleName });
      const gone = yield* IAM.getRole({ RoleName: roleName }).pipe(
        Effect.option,
      );
      expect(gone._tag).toBe("None");

      // Reconcile must recreate. IAM is eventually consistent globally
      // so the recreate may need a moment to propagate to subsequent
      // mutating calls — the reconciler handles this internally.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("RecreateRole", {
            roleName,
            assumeRolePolicyDocument: assumeRolePolicy,
            inlinePolicies: {
              AllowLogs: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["logs:CreateLogGroup"],
                    Resource: "*",
                  },
                ],
              },
            },
          });
        }),
      );
      expect(recreated.roleName).toEqual(roleName);

      const observedInline = yield* IAM.getRolePolicy({
        RoleName: roleName,
        PolicyName: "AllowLogs",
      });
      expect(observedInline.PolicyName).toEqual("AllowLogs");

      yield* stack.destroy();

      const deleted = yield* IAM.getRole({ RoleName: roleName }).pipe(
        Effect.option,
      );
      expect(deleted._tag).toBe("None");
    }),
  { timeout: 180_000 },
);

test.provider(
  "changing roleName triggers replace, old role is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-role-replace-a-${suffix}`;
      const nameB = `alchemy-test-role-replace-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("ReplaceRole", {
            roleName: nameA,
            assumeRolePolicyDocument: assumeRolePolicy,
          });
        }),
      );
      expect(a.roleName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("ReplaceRole", {
            roleName: nameB,
            assumeRolePolicyDocument: assumeRolePolicy,
          });
        }),
      );
      expect(b.roleName).toEqual(nameB);
      expect(b.roleArn).not.toEqual(a.roleArn);

      // The old role must be gone after replace.
      const oldGone = yield* IAM.getRole({ RoleName: nameA }).pipe(
        Effect.option,
      );
      expect(oldGone._tag).toBe("None");

      yield* stack.destroy();

      const newGone = yield* IAM.getRole({ RoleName: nameB }).pipe(
        Effect.option,
      );
      expect(newGone._tag).toBe("None");
    }),
);

test.provider(
  "adding/removing managed-policy attachments diffs against cloud state",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const basicExec =
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
      const readOnly = "arn:aws:iam::aws:policy/ReadOnlyAccess";

      // Start with one managed policy.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("ManagedRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
            managedPolicyArns: [basicExec],
          });
        }),
      );

      const observedAfterCreate = yield* IAM.listAttachedRolePolicies({
        RoleName: initial.roleName,
      });
      expect(
        (observedAfterCreate.AttachedPolicies ?? []).map((p) => p.PolicyArn),
      ).toContain(basicExec);

      // Out-of-band: detach the managed policy and attach a different one.
      yield* IAM.detachRolePolicy({
        RoleName: initial.roleName,
        PolicyArn: basicExec,
      });
      yield* IAM.attachRolePolicy({
        RoleName: initial.roleName,
        PolicyArn: readOnly,
      });

      // Reconcile back to the desired set [basicExec] — diff against
      // observed cloud state must remove `readOnly` and re-attach `basicExec`.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("ManagedRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
            managedPolicyArns: [basicExec],
          });
        }),
      );

      const observedAfterRedeploy = yield* IAM.listAttachedRolePolicies({
        RoleName: initial.roleName,
      });
      const arns = (observedAfterRedeploy.AttachedPolicies ?? []).map(
        (p) => p.PolicyArn,
      );
      expect(arns).toContain(basicExec);
      expect(arns).not.toContain(readOnly);

      yield* stack.destroy();
    }),
);

test.provider(
  "destroying an already-deleted role is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const role = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("DoubleDestroyRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
            inlinePolicies: {
              AllowLogs: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["logs:CreateLogGroup"],
                    Resource: "*",
                  },
                ],
              },
            },
          });
        }),
      );

      // Out-of-band: scrub the role completely. The provider's `delete`
      // must catch `NoSuchEntity` from each cleanup step and complete.
      yield* IAM.deleteRolePolicy({
        RoleName: role.roleName,
        PolicyName: "AllowLogs",
      }).pipe(Effect.option);
      yield* IAM.deleteRole({ RoleName: role.roleName }).pipe(Effect.option);

      yield* stack.destroy();
    }),
);
