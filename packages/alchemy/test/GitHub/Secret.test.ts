import { adopt } from "@/AdoptPolicy";
import * as GitHub from "@/GitHub";
import { GitHubCredentials } from "@/GitHub/Credentials";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const owner = process.env.GITHUB_TEST_OWNER ?? "";
const repository = process.env.GITHUB_TEST_REPO ?? "";
const skip = !owner || !repository || !process.env.GITHUB_TOKEN;

const { test } = Test.make({ providers: GitHub.providers() });

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

const getOctokit = Effect.gen(function* () {
  const creds = yield* GitHubCredentials;
  return creds.octokit();
});

/** True iff a repo secret with `name` exists at the GitHub API. */
const secretExists = (name: string) =>
  Effect.gen(function* () {
    const octokit = yield* getOctokit;
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          await octokit.rest.actions.getRepoSecret({
            owner,
            repo: repository,
            secret_name: name,
          });
          return true;
        } catch (e: any) {
          if (e.status === 404) return false;
          throw e;
        }
      },
      catch: (e) => e as Error,
    });
  });

/** Read created_at/updated_at metadata for a repo secret (for rotation assertions). */
const secretMetadata = (name: string) =>
  Effect.gen(function* () {
    const octokit = yield* getOctokit;
    return yield* Effect.tryPromise(() =>
      octokit.rest.actions
        .getRepoSecret({
          owner,
          repo: repository,
          secret_name: name,
        })
        .then((r) => r.data),
    );
  });

const deleteSecretOutOfBand = (name: string) =>
  Effect.gen(function* () {
    const octokit = yield* getOctokit;
    yield* Effect.tryPromise(async () => {
      try {
        await octokit.rest.actions.deleteRepoSecret({
          owner,
          repo: repository,
          secret_name: name,
        });
      } catch (e: any) {
        if (e.status !== 404) throw e;
      }
    });
  });

const putSecretOutOfBand = (name: string, value: string) =>
  Effect.gen(function* () {
    const octokit = yield* getOctokit;
    const { data: pk } = yield* Effect.tryPromise(() =>
      octokit.rest.actions.getRepoPublicKey({ owner, repo: repository }),
    );
    const encrypted = yield* Effect.tryPromise(async () => {
      const mod = await import("libsodium-wrappers");
      const sodium: typeof import("libsodium-wrappers") =
        (mod as any).default ?? mod;
      await sodium.ready;
      const binKey = sodium.from_base64(
        pk.key,
        sodium.base64_variants.ORIGINAL,
      );
      const binMessage = sodium.from_string(value);
      return sodium.to_base64(
        sodium.crypto_box_seal(binMessage, binKey),
        sodium.base64_variants.ORIGINAL,
      );
    });
    yield* Effect.tryPromise(() =>
      octokit.rest.actions.createOrUpdateRepoSecret({
        owner,
        repo: repository,
        secret_name: name,
        encrypted_value: encrypted,
        key_id: pk.key_id,
      }),
    );
  });

test.provider.skipIf(skip)(
  "create and delete repository secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `ALCHEMY_TEST_BASIC_${randomSuffix().toUpperCase()}`;

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Secret("S", {
            owner,
            repository,
            name,
            value: Redacted.make("hello-1"),
          });
        }),
      );
      expect(yield* secretExists(name)).toBe(true);

      yield* stack.destroy();
      expect(yield* secretExists(name)).toBe(false);
    }),
);

test.provider.skipIf(skip)(
  "redeploy with same secret value is convergent (re-PUTs but does not throw)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `ALCHEMY_TEST_NOOP_${randomSuffix().toUpperCase()}`;

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Secret("S", {
            owner,
            repository,
            name,
            value: Redacted.make("same-value"),
          });
        }),
      );
      expect(yield* secretExists(name)).toBe(true);

      // Same desired state — reconcile re-PUTs (write-only resource has no
      // value diff), but it must not error and the secret must still exist.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Secret("S", {
            owner,
            repository,
            name,
            value: Redacted.make("same-value"),
          });
        }),
      );
      expect(yield* secretExists(name)).toBe(true);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(skip)(
  "rotating the value updates the secret without replace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `ALCHEMY_TEST_ROTATE_${randomSuffix().toUpperCase()}`;

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Secret("S", {
            owner,
            repository,
            name,
            value: Redacted.make("v1"),
          });
        }),
      );
      const before = yield* secretMetadata(name);

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Secret("S", {
            owner,
            repository,
            name,
            value: Redacted.make("v2"),
          });
        }),
      );
      const after = yield* secretMetadata(name);

      // Same logical/physical identity — created_at preserved (no replace),
      // updated_at advances on rotation.
      expect(before.created_at).toEqual(after.created_at);
      expect(new Date(after.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(before.updated_at).getTime(),
      );
      expect(second.updatedAt).not.toEqual(first.updatedAt);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(skip)(
  "reconcile re-creates a secret deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `ALCHEMY_TEST_RECREATE_${randomSuffix().toUpperCase()}`;

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Secret("S", {
            owner,
            repository,
            name,
            value: Redacted.make("v1"),
          });
        }),
      );
      expect(yield* secretExists(name)).toBe(true);

      // Delete behind the engine's back.
      yield* deleteSecretOutOfBand(name);
      expect(yield* secretExists(name)).toBe(false);

      // Re-deploy with no prop changes — reconcile must converge by
      // re-uploading the secret (it's write-only, so the only convergent
      // option is to PUT every time).
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Secret("S", {
            owner,
            repository,
            name,
            value: Redacted.make("v1"),
          });
        }),
      );
      expect(yield* secretExists(name)).toBe(true);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(skip)(
  "changing name triggers replace and old secret is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const suffix = randomSuffix().toUpperCase();
      const oldName = `ALCHEMY_TEST_REPLACE_OLD_${suffix}`;
      const newName = `ALCHEMY_TEST_REPLACE_NEW_${suffix}`;

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Secret("S", {
            owner,
            repository,
            name: oldName,
            value: Redacted.make("v"),
          });
        }),
      );
      expect(yield* secretExists(oldName)).toBe(true);

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Secret("S", {
            owner,
            repository,
            name: newName,
            value: Redacted.make("v"),
          });
        }),
      );

      // After replace, the new identity exists and the old one is gone.
      expect(yield* secretExists(newName)).toBe(true);
      expect(yield* secretExists(oldName)).toBe(false);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(skip)(
  "destroying an already-deleted secret is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `ALCHEMY_TEST_DOUBLE_DESTROY_${randomSuffix().toUpperCase()}`;

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Secret("S", {
            owner,
            repository,
            name,
            value: Redacted.make("v"),
          });
        }),
      );
      expect(yield* secretExists(name)).toBe(true);

      // Delete the secret out-of-band, then ask the engine to destroy.
      // The 404 from `deleteRepoSecret` must be swallowed as success
      // rather than propagating to the user.
      yield* deleteSecretOutOfBand(name);
      yield* stack.destroy();
      expect(yield* secretExists(name)).toBe(false);
    }),
);

test.provider.skipIf(skip)(
  "adopt(true) re-claims a foreign secret without first destroying it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `ALCHEMY_TEST_ADOPT_${randomSuffix().toUpperCase()}`;

      // Pre-create the secret out-of-band so it has no engine ownership.
      yield* putSecretOutOfBand(name, "foreign-value");
      expect(yield* secretExists(name)).toBe(true);

      const adopted = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* GitHub.Secret("S", {
              owner,
              repository,
              name,
              value: Redacted.make("alchemy-value"),
            });
          }),
        )
        .pipe(adopt(true));
      expect(adopted.updatedAt).toBeDefined();

      // Wipe state but keep the cloud secret — re-deploying without
      // adopt() must still converge because reconcile is unconditionally
      // a PUT (write-only resource).
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "S",
        });
      }).pipe(Effect.provide(stack.state));

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Secret("S", {
            owner,
            repository,
            name,
            value: Redacted.make("alchemy-value"),
          });
        }),
      );
      expect(yield* secretExists(name)).toBe(true);

      yield* stack.destroy();
      expect(yield* secretExists(name)).toBe(false);
    }),
);
