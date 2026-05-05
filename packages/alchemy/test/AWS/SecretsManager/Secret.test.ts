import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Secret } from "@/AWS/SecretsManager";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as SecretsManager from "@distilled.cloud/aws/secrets-manager";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class SecretStillExists extends Data.TaggedError("SecretStillExists") {}
class SecretValueMismatch extends Data.TaggedError("SecretValueMismatch") {}

/**
 * Wait for the secret to be fully gone. After `DeleteSecret` with
 * `ForceDeleteWithoutRecovery: true` it can take a moment before
 * `DescribeSecret` returns `ResourceNotFoundException`.
 */
const assertSecretDeleted = Effect.fn(function* (secretId: string) {
  yield* SecretsManager.describeSecret({ SecretId: secretId }).pipe(
    Effect.flatMap(() => Effect.fail(new SecretStillExists())),
    Effect.retry({
      while: (e) => e._tag === "SecretStillExists",
      schedule: Schedule.exponential(100).pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});

const assertSecretStringEquals = Effect.fn(function* (
  secretId: string,
  expected: string,
) {
  yield* Effect.gen(function* () {
    const value = yield* SecretsManager.getSecretValue({ SecretId: secretId });
    const observed = value.SecretString
      ? typeof value.SecretString === "string"
        ? value.SecretString
        : Redacted.value(value.SecretString)
      : undefined;
    if (observed !== expected) {
      return yield* Effect.fail(new SecretValueMismatch());
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "SecretValueMismatch",
      schedule: Schedule.fixed("500 millis").pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );
});

test.provider("create and delete secret with default props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const secret = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Secret("DefaultSecret", {
          secretString: Redacted.make("hello"),
        });
      }),
    );

    expect(secret.secretArn).toBeDefined();
    expect(secret.secretName).toBeDefined();
    yield* assertSecretStringEquals(secret.secretArn, "hello");

    yield* stack.destroy();
    yield* assertSecretDeleted(secret.secretArn);
  }),
);

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("IdempotentSecret", {
            description: "stable description",
            secretString: Redacted.make("v1"),
          });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("IdempotentSecret", {
            description: "stable description",
            secretString: Redacted.make("v1"),
          });
        }),
      );
      // ARN/Name stable across redeploy.
      expect(second.secretArn).toEqual(initial.secretArn);
      expect(second.secretName).toEqual(initial.secretName);
      // Value still readable.
      yield* assertSecretStringEquals(second.secretArn, "v1");

      yield* stack.destroy();
      yield* assertSecretDeleted(initial.secretArn);
    }),
);

test.provider(
  "reconcile resets description / kmsKeyId mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const secret = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("DriftSecret", {
            description: "managed",
            secretString: Redacted.make("seed"),
          });
        }),
      );

      // Mutate the description out of band.
      yield* SecretsManager.updateSecret({
        SecretId: secret.secretArn,
        Description: "drifted by external actor",
      });
      const drifted = yield* SecretsManager.describeSecret({
        SecretId: secret.secretArn,
      });
      expect(drifted.Description).toEqual("drifted by external actor");

      // Re-deploy with the same desired description — reconcile should
      // converge it back.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("DriftSecret", {
            description: "managed",
            secretString: Redacted.make("seed"),
          });
        }),
      );

      const converged = yield* SecretsManager.describeSecret({
        SecretId: secret.secretArn,
      });
      expect(converged.Description).toEqual("managed");

      yield* stack.destroy();
      yield* assertSecretDeleted(secret.secretArn);
    }),
);

test.provider("rotating secretString advances the version", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Secret("VersionSecret", {
          secretString: Redacted.make("first"),
        });
      }),
    );
    yield* assertSecretStringEquals(initial.secretArn, "first");
    const v1 = initial.versionId;
    expect(v1).toBeDefined();

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Secret("VersionSecret", {
          secretString: Redacted.make("second"),
        });
      }),
    );
    expect(updated.secretArn).toEqual(initial.secretArn);
    expect(updated.versionId).toBeDefined();
    expect(updated.versionId).not.toEqual(v1);
    yield* assertSecretStringEquals(updated.secretArn, "second");

    yield* stack.destroy();
    yield* assertSecretDeleted(initial.secretArn);
  }),
);

test.provider(
  "reconcile re-creates a secret that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const secretName = `alchemy-test-secret-recreate-${suffix}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("RecreateSecret", {
            name: secretName,
            secretString: Redacted.make("v1"),
          });
        }),
      );

      // Force-delete the secret out of band so the name is immediately
      // free for reuse.
      yield* SecretsManager.deleteSecret({
        SecretId: initial.secretArn,
        ForceDeleteWithoutRecovery: true,
      });
      yield* assertSecretDeleted(initial.secretArn);

      // Re-deploying must converge by re-creating.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("RecreateSecret", {
            name: secretName,
            secretString: Redacted.make("v2"),
          });
        }),
      );
      expect(recreated.secretName).toEqual(secretName);
      yield* assertSecretStringEquals(recreated.secretArn, "v2");

      yield* stack.destroy();
      yield* assertSecretDeleted(recreated.secretArn);
    }),
);

test.provider(
  "reconcile restores a secret that is in the soft-delete window",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const secretName = `alchemy-test-secret-restore-${suffix}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("RestoreSecret", {
            name: secretName,
            secretString: Redacted.make("v1"),
          });
        }),
      );

      // Schedule the secret for deletion (NOT force-delete) so it
      // enters the recovery window. The next reconcile must observe the
      // `DeletedDate`, restore the secret, and continue.
      yield* SecretsManager.deleteSecret({
        SecretId: initial.secretArn,
        RecoveryWindowInDays: 7,
      });
      const scheduled = yield* SecretsManager.describeSecret({
        SecretId: initial.secretArn,
      });
      expect(scheduled.DeletedDate).toBeDefined();

      const restored = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("RestoreSecret", {
            name: secretName,
            secretString: Redacted.make("v2"),
          });
        }),
      );
      expect(restored.secretArn).toEqual(initial.secretArn);
      yield* assertSecretStringEquals(restored.secretArn, "v2");

      const post = yield* SecretsManager.describeSecret({
        SecretId: restored.secretArn,
      });
      expect(post.DeletedDate).toBeUndefined();

      yield* stack.destroy();
      yield* assertSecretDeleted(restored.secretArn);
    }),
);

test.provider("changing name triggers replace, old secret is deleted", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const suffix = Math.random().toString(36).slice(2, 8);
    const nameA = `alchemy-test-secret-rename-a-${suffix}`;
    const nameB = `alchemy-test-secret-rename-b-${suffix}`;

    const a = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Secret("RenameSecret", {
          name: nameA,
          secretString: Redacted.make("v1"),
        });
      }),
    );
    expect(a.secretName).toEqual(nameA);

    const b = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Secret("RenameSecret", {
          name: nameB,
          secretString: Redacted.make("v1"),
        });
      }),
    );
    expect(b.secretName).toEqual(nameB);
    expect(b.secretArn).not.toEqual(a.secretArn);

    // The old secret must be force-deleted on replace.
    yield* assertSecretDeleted(a.secretArn);

    yield* stack.destroy();
    yield* assertSecretDeleted(b.secretArn);
  }),
);

test.provider("destroying an already-deleted secret is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const secret = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Secret("DoubleDestroySecret", {
          secretString: Redacted.make("v1"),
        });
      }),
    );

    // Force-delete out of band.
    yield* SecretsManager.deleteSecret({
      SecretId: secret.secretArn,
      ForceDeleteWithoutRecovery: true,
    });
    yield* assertSecretDeleted(secret.secretArn);

    // Engine-level destroy must succeed even though the secret is gone.
    yield* stack.destroy();
  }),
);

// Engine-level adoption tests.
test.provider(
  "owned secret (matching alchemy tags) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const secretName = `alchemy-test-secret-adopt-${suffix}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("AdoptableSecret", {
            name: secretName,
            secretString: Redacted.make("v1"),
          });
        }),
      );
      expect(initial.secretName).toEqual(secretName);

      // Wipe state — secret stays in AWS.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableSecret",
        });
      }).pipe(Effect.provide(stack.state));

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("AdoptableSecret", {
            name: secretName,
            secretString: Redacted.make("v1"),
          });
        }),
      );
      expect(adopted.secretArn).toEqual(initial.secretArn);

      yield* stack.destroy();
      yield* assertSecretDeleted(initial.secretArn);
    }),
);

test.provider(
  "foreign-tagged secret requires adopt(true) to take over and gets re-tagged",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const secretName = `alchemy-test-secret-takeover-${suffix}`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("Original", {
            name: secretName,
            secretString: Redacted.make("v1"),
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
            return yield* Secret("Different", {
              name: secretName,
              secretString: Redacted.make("v1"),
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.secretName).toEqual(secretName);
      expect(takenOver.secretArn).toEqual(original.secretArn);

      // The taken-over secret should now carry our internal alchemy tags.
      const described = yield* SecretsManager.describeSecret({
        SecretId: takenOver.secretArn,
      });
      const tagMap = Object.fromEntries(
        (described.Tags ?? [])
          .filter(
            (t): t is { Key: string; Value: string } =>
              typeof t.Key === "string" && typeof t.Value === "string",
          )
          .map((t) => [t.Key, t.Value]),
      );
      expect(tagMap["alchemy:fqn"]).toBeDefined();
      expect(tagMap["alchemy:stage"]).toBeDefined();

      yield* stack.destroy();
      yield* assertSecretDeleted(takenOver.secretArn);
    }),
);
