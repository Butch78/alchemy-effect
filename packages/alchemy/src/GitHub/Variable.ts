import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { GitHubCredentials } from "./Credentials.ts";
import type * as GitHub from "./Providers.ts";

export interface VariableProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Variable name (e.g. `AWS_ROLE_ARN`).
   */
  name: string;

  /**
   * Variable value.
   */
  value: string;
}

export interface Variable extends Resource<
  "GitHub.Variable",
  VariableProps,
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
 * A GitHub Actions repository variable.
 *
 * `Variable` manages the lifecycle of a plain-text configuration variable
 * in GitHub Actions. Variables are visible in workflow logs and are
 * suitable for non-sensitive configuration like region names, environment
 * labels, or feature flags. For sensitive values, use `GitHub.Secret`
 * instead.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied
 * by `GitHub.providers()` (which uses the Alchemy AuthProvider — env,
 * stored PAT, `gh` CLI, or OAuth). The token needs `repo` scope for
 * private repositories or `public_repo` for public ones.
 *
 * @section Repository Variables
 * Store variables accessible to all GitHub Actions workflows in the
 * repository.
 *
 * @example Create a Repository Variable
 * ```typescript
 * yield* GitHub.Variable("aws-region", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "AWS_REGION",
 *   value: "us-east-1",
 * });
 * ```
 *
 * @section Wiring with Other Resources
 * Pass output attributes from other resources into GitHub variables so
 * that CI workflows can reference them.
 *
 * @example Store a Worker URL for CI
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Api", { ... });
 *
 * yield* GitHub.Variable("api-url", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "API_URL",
 *   value: worker.url!,
 * });
 * ```
 *
 * @example Multiple Variables
 * ```typescript
 * yield* GitHub.Variable("region", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "AWS_REGION",
 *   value: "us-east-1",
 * });
 *
 * yield* GitHub.Variable("stage", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "DEPLOY_STAGE",
 *   value: "production",
 * });
 * ```
 */
export const Variable = Resource<Variable>("GitHub.Variable");

/** Variable was not found at the GitHub API (HTTP 404). */
export class GitHubVariableNotFound extends Data.TaggedError(
  "GitHubVariableNotFound",
)<{
  readonly owner: string;
  readonly repository: string;
  readonly name: string;
  readonly cause?: unknown;
}> {}

/** GitHub returned 422 — typically the variable already exists on create. */
export class GitHubVariableAlreadyExists extends Data.TaggedError(
  "GitHubVariableAlreadyExists",
)<{
  readonly owner: string;
  readonly repository: string;
  readonly name: string;
  readonly cause?: unknown;
}> {}

/** Catch-all for unrecognised Octokit errors. */
export class GitHubVariableError extends Data.TaggedError(
  "GitHubVariableError",
)<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

const getOctokit = Effect.gen(function* () {
  const creds = yield* GitHubCredentials;
  return creds.octokit();
});

const mapOctokitError = (
  e: unknown,
  ctx: { owner: string; repository: string; name: string },
) => {
  const status = (e as { status?: number } | undefined)?.status;
  const message =
    (e as { message?: string } | undefined)?.message ?? String(e);
  if (status === 404) return new GitHubVariableNotFound({ ...ctx, cause: e });
  if (status === 422) {
    return new GitHubVariableAlreadyExists({ ...ctx, cause: e });
  }
  return new GitHubVariableError({ message, status, cause: e });
};

export const VariableProvider = () =>
  Provider.succeed(Variable, {
    reconcile: Effect.fn(function* ({ news }) {
      const octokit = yield* getOctokit;

      // Observe — `name` is the path identifier for repo variables; ask
      // GitHub directly for the live row. A typed `GitHubVariableNotFound`
      // (404) collapses to "no live state" so we converge by creating;
      // any other error surfaces.
      const observed = yield* Effect.tryPromise({
        try: async () => {
          const { data } = await octokit.rest.actions.getRepoVariable({
            owner: news.owner,
            repo: news.repository,
            name: news.name,
          });
          return data;
        },
        catch: (e) =>
          mapOctokitError(e, {
            owner: news.owner,
            repository: news.repository,
            name: news.name,
          }),
      }).pipe(
        Effect.catchTag("GitHubVariableNotFound", () => Effect.succeed(undefined)),
      );

      // Ensure — POST creates the variable. If a peer reconciler created
      // the same variable between our observe and our create, GitHub
      // returns 422; we catch that race and fall through to PATCH.
      if (observed === undefined) {
        const created = yield* Effect.tryPromise({
          try: () =>
            octokit.rest.actions.createRepoVariable({
              owner: news.owner,
              repo: news.repository,
              name: news.name,
              value: news.value,
            }),
          catch: (e) =>
            mapOctokitError(e, {
              owner: news.owner,
              repository: news.repository,
              name: news.name,
            }),
        }).pipe(
          Effect.map(() => "created" as const),
          Effect.catchTag("GitHubVariableAlreadyExists", () =>
            Effect.succeed("race" as const),
          ),
        );
        if (created === "created") {
          return { updatedAt: new Date().toISOString() };
        }
        // fall through to PATCH on the racy create
      }

      // Sync — PATCH the value. We always issue the call when we
      // observed a live variable (so adoption converges value drift),
      // and skip only the no-op redeploy where observe matched desired.
      if (observed !== undefined && observed.value === news.value) {
        return { updatedAt: new Date().toISOString() };
      }

      yield* Effect.tryPromise({
        try: () =>
          octokit.rest.actions.updateRepoVariable({
            owner: news.owner,
            repo: news.repository,
            name: news.name,
            value: news.value,
          }),
        catch: (e) =>
          mapOctokitError(e, {
            owner: news.owner,
            repository: news.repository,
            name: news.name,
          }),
      });
      return { updatedAt: new Date().toISOString() };
    }),

    delete: Effect.fn(function* ({ olds }) {
      const octokit = yield* getOctokit;

      yield* Effect.tryPromise({
        try: () =>
          octokit.rest.actions.deleteRepoVariable({
            owner: olds.owner,
            repo: olds.repository,
            name: olds.name,
          }),
        catch: (e) =>
          mapOctokitError(e, {
            owner: olds.owner,
            repository: olds.repository,
            name: olds.name,
          }),
      }).pipe(
        // Already gone is success — auth/throttling errors still surface.
        Effect.catchTag("GitHubVariableNotFound", () => Effect.void),
      );
    }),
  });
