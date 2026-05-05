import type { Octokit } from "@octokit/rest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { GitHubCredentials } from "./Credentials.ts";
import type * as GitHub from "./Providers.ts";

export interface SecretProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Secret name (e.g. `AWS_ROLE_ARN`).
   */
  name: string;

  /**
   * Secret value. Wrap with `Redacted.make` to prevent the value from
   * appearing in logs or state.
   */
  value: Redacted.Redacted;

  /**
   * Optional environment name. When set the secret is scoped to that
   * GitHub Actions environment instead of the whole repository.
   */
  environment?: string;
}

export interface Secret extends Resource<
  "GitHub.Secret",
  SecretProps,
  {
    /**
     * ISO-8601 timestamp of the last update.
     */
    updatedAt: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub Actions repository or environment secret.
 *
 * `Secret` manages the lifecycle of an encrypted secret in GitHub Actions.
 * Secrets are encrypted using the repository's (or environment's) public
 * key via `libsodium` before being stored. The resource is idempotent —
 * calling it with the same name will update the secret value in place.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied
 * by `GitHub.providers()` (which uses the Alchemy AuthProvider — env,
 * stored PAT, `gh` CLI, or OAuth). The token needs `repo` scope for
 * private repositories or `public_repo` for public ones.
 *
 * @section Repository Secrets
 * Store secrets accessible to all GitHub Actions workflows in the
 * repository.
 *
 * @example Create a Repository Secret
 * ```typescript
 * yield* GitHub.Secret("aws-role", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "AWS_ROLE_ARN",
 *   value: Redacted.make(role.roleArn),
 * });
 * ```
 *
 * @section Environment Secrets
 * Scope a secret to a specific GitHub Actions environment (e.g.
 * `production`, `staging`). Environment secrets require environment
 * protection rules to be satisfied before workflows can access them.
 *
 * @example Create an Environment Secret
 * ```typescript
 * yield* GitHub.Secret("deploy-key", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   environment: "production",
 *   name: "DEPLOY_KEY",
 *   value: Redacted.make("my-secret-value"),
 * });
 * ```
 *
 * @section Wiring with Other Resources
 * A common pattern is wiring the output of another resource — like an
 * IAM role ARN or a database URL — directly into a GitHub secret so
 * that CI workflows can use it.
 *
 * @example Store an IAM Role ARN for CI
 * ```typescript
 * const role = yield* AWS.IAM.Role("ci-role", { ... });
 *
 * yield* GitHub.Secret("ci-role-arn", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "AWS_ROLE_ARN",
 *   value: Redacted.make(role.roleArn),
 * });
 * ```
 *
 * @example Store Multiple Secrets
 * ```typescript
 * yield* GitHub.Secret("db-url", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   environment: "production",
 *   name: "DATABASE_URL",
 *   value: Redacted.make(database.connectionString),
 * });
 *
 * yield* GitHub.Secret("api-key", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   environment: "production",
 *   name: "API_KEY",
 *   value: Redacted.make(apiKey),
 * });
 * ```
 */
export const Secret = Resource<Secret>("GitHub.Secret");

/**
 * Repository (or environment) was not found at the GitHub API. Surfaces
 * `404` from the public-key, upsert, and delete paths. Treated as
 * non-fatal in `delete` (the secret is already gone with the repo) and
 * retried briefly in `reconcile` to ride out repo-create eventual
 * consistency.
 */
export class GitHubSecretNotFound extends Data.TaggedError(
  "GitHubSecretNotFound",
)<{
  readonly owner: string;
  readonly repository: string;
  readonly name: string;
  readonly environment?: string;
  readonly cause?: unknown;
}> {}

/**
 * GitHub validated the request as malformed (HTTP 422) — typically a
 * bad encrypted_value, missing key_id, or invalid secret name. This is
 * a programming or input error, not transient, and never retried.
 */
export class GitHubSecretValidationError extends Data.TaggedError(
  "GitHubSecretValidationError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Catch-all for unrecognised Octokit errors so they don't propagate as `unknown`. */
export class GitHubSecretError extends Data.TaggedError("GitHubSecretError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

const getOctokit = Effect.gen(function* () {
  const creds = yield* GitHubCredentials;
  return creds.octokit();
});

async function encryptValue(
  plaintext: string,
  publicKey: string,
): Promise<string> {
  const mod = await import("libsodium-wrappers");
  // Bun/ESM interop: the actual sodium API lives on `.default` when the
  // CJS module is wrapped, but is the module itself under other loaders.
  const sodium: typeof import("libsodium-wrappers") =
    (mod as any).default ?? mod;
  await sodium.ready;
  const binKey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const binMessage = sodium.from_string(plaintext);
  const encrypted = sodium.crypto_box_seal(binMessage, binKey);
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
}

const mapOctokitError = (
  e: unknown,
  ctx: { owner: string; repository: string; name: string; environment?: string },
) => {
  const status = (e as { status?: number } | undefined)?.status;
  const message =
    (e as { message?: string } | undefined)?.message ?? String(e);
  if (status === 404) {
    return new GitHubSecretNotFound({ ...ctx, cause: e });
  }
  if (status === 422) {
    return new GitHubSecretValidationError({ message, cause: e });
  }
  return new GitHubSecretError({ message, status, cause: e });
};

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    reconcile: Effect.fn(function* ({ news, olds, session }) {
      const octokit = yield* getOctokit;

      // Observe — there's no API to read a secret's value back. The most
      // we can observe is *location* (repo-scoped vs environment-scoped)
      // and dispose of an orphan when location changes; otherwise we re-
      // PUT every reconcile, which is the only convergent option for a
      // write-only resource.
      if (olds !== undefined) {
        const wasEnv = !!olds.environment;
        const isEnv = !!news.environment;
        if (wasEnv !== isEnv || olds.environment !== news.environment) {
          yield* deleteSecret(octokit, olds).pipe(
            // The orphan may already be gone (manual cleanup, repo
            // deleted, etc) — that's fine, treat as success.
            Effect.catchTag("GitHubSecretNotFound", () => Effect.void),
          );
        }
      }

      // Ensure & Sync — re-encrypt with a fresh public key and re-PUT.
      // `createOrUpdate*Secret` is upsert-style and is the only way to
      // converge: secret values are write-only, so we cannot diff and
      // skip the call. A 404 here usually means the repo was created
      // *just now* in the same plan — retry briefly to ride out repo
      // eventual consistency.
      yield* upsertSecret(octokit, news).pipe(
        Effect.retry({
          while: (e) => e._tag === "GitHubSecretNotFound",
          schedule: Schedule.fixed(1000).pipe(
            Schedule.tapOutput((i) =>
              session.note(
                `GitHub repo not found yet, retrying secret upsert... ${i + 1}s`,
              ),
            ),
            // Cap at 30s — repo eventual-consistency is normally <5s.
            // Beyond that the repo legitimately doesn't exist and the
            // user needs to see the error.
            Schedule.both(Schedule.recurs(30)),
          ),
        }),
      );
      return { updatedAt: new Date().toISOString() };
    }),

    delete: Effect.fn(function* ({ olds }) {
      const octokit = yield* getOctokit;
      // Idempotent destroy — `GitHubSecretNotFound` is success (the
      // secret is already gone). Other errors must surface so we don't
      // silently leak state on auth/throttling failures.
      yield* deleteSecret(octokit, olds).pipe(
        Effect.catchTag("GitHubSecretNotFound", () => Effect.void),
      );
    }),
  });

const upsertSecret = Effect.fn(function* (
  octokit: Octokit,
  props: SecretProps,
) {
  const plaintext = Redacted.value(props.value);
  const isEnv = !!props.environment;

  const publicKey = yield* Effect.tryPromise({
    try: async () => {
      if (isEnv) {
        const { data } = await octokit.rest.actions.getEnvironmentPublicKey({
          owner: props.owner,
          repo: props.repository,
          environment_name: props.environment!,
        });
        return data;
      }
      const { data } = await octokit.rest.actions.getRepoPublicKey({
        owner: props.owner,
        repo: props.repository,
      });
      return data;
    },
    catch: (e) =>
      mapOctokitError(e, {
        owner: props.owner,
        repository: props.repository,
        name: props.name,
        environment: props.environment,
      }),
  });

  const encrypted = yield* Effect.tryPromise({
    try: () => encryptValue(plaintext, publicKey.key),
    catch: (e) =>
      new GitHubSecretValidationError({
        message: `Failed to encrypt secret value with libsodium for '${props.name}'`,
        cause: e,
      }),
  });

  yield* Effect.tryPromise({
    try: async () => {
      if (isEnv) {
        await octokit.rest.actions.createOrUpdateEnvironmentSecret({
          owner: props.owner,
          repo: props.repository,
          environment_name: props.environment!,
          secret_name: props.name,
          encrypted_value: encrypted,
          key_id: publicKey.key_id,
        });
      } else {
        await octokit.rest.actions.createOrUpdateRepoSecret({
          owner: props.owner,
          repo: props.repository,
          secret_name: props.name,
          encrypted_value: encrypted,
          key_id: publicKey.key_id,
        });
      }
    },
    catch: (e) =>
      mapOctokitError(e, {
        owner: props.owner,
        repository: props.repository,
        name: props.name,
        environment: props.environment,
      }),
  });
});

const deleteSecret = Effect.fn(function* (
  octokit: Octokit,
  props: SecretProps,
) {
  yield* Effect.tryPromise({
    try: async () => {
      if (props.environment) {
        await octokit.rest.actions.deleteEnvironmentSecret({
          owner: props.owner,
          repo: props.repository,
          environment_name: props.environment,
          secret_name: props.name,
        });
      } else {
        await octokit.rest.actions.deleteRepoSecret({
          owner: props.owner,
          repo: props.repository,
          secret_name: props.name,
        });
      }
    },
    catch: (e) =>
      mapOctokitError(e, {
        owner: props.owner,
        repository: props.repository,
        name: props.name,
        environment: props.environment,
      }),
  });
});
