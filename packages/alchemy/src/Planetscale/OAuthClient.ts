import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import crypto from "node:crypto";
import http from "node:http";

export class OAuthError extends Data.TaggedError("OAuthError")<{
  error: string;
  errorDescription: string;
}> {}

export interface OAuthCredentials {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  scopes: string[];
}

export interface Authorization {
  url: string;
  state: string;
}

/**
 * Registered PlanetScale OAuth application credentials.
 *
 * Unlike Cloudflare, PlanetScale OAuth has **no PKCE flow** — exchanging the
 * authorization code (and refreshing the token) requires the application's
 * `client_secret`. There is no way to keep that secret out of a distributed
 * CLI, so it ships here: the exposure is the same posture as a public
 * `client_id` (a stolen refresh token is usable, exactly like Cloudflare's
 * secret-less refresh), and it can be rotated by cutting a new release.
 *
 * Registered at https://app.planetscale.com with redirect URI
 * {@link OAUTH_REDIRECT_URI}. Scopes are configured on the application
 * itself, not requested per-authorization. Rotate by registering a new
 * secret and cutting a release.
 */
export const OAUTH_CLIENT_ID = "pscale_app_aa12e3938baebb788aac443f66e422da";
export const OAUTH_CLIENT_SECRET =
  "pscale_app_secret_yyZ3Q8oe99GP9_yA5wrA5er6RuN6Lz9dC66Bj1OJzpg";

export const OAUTH_REDIRECT_URI = "http://localhost:9976/auth/callback";
export const OAUTH_ENDPOINTS = {
  authorize: "https://auth.planetscale.com/oauth/authorize",
  token: "https://auth.planetscale.com/oauth/token",
};

function generateState(length = 32): string {
  return crypto.randomBytes(length).toString("base64url");
}

function extractCredentials(json: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}): OAuthCredentials {
  return {
    type: "oauth",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    scopes: json.scope ? json.scope.split(" ") : [],
  };
}

const tokenRequest = (
  params: Record<string, string>,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  Effect.gen(function* () {
    // PlanetScale's token endpoint takes its parameters as query string.
    const url = new URL(OAUTH_ENDPOINTS.token);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(url.toString(), {
          method: "POST",
          headers: { Accept: "application/json" },
        }),
      catch: (err) =>
        new OAuthError({
          error: "network_error",
          errorDescription: `Token request failed: ${err}`,
        }),
    });

    if (!res.ok) {
      const json = yield* Effect.tryPromise({
        try: () =>
          res.json() as Promise<{ error: string; error_description: string }>,
        catch: () =>
          new OAuthError({
            error: "parse_error",
            errorDescription: `Token endpoint returned ${res.status}`,
          }),
      });
      return yield* new OAuthError({
        error: json.error,
        errorDescription: json.error_description,
      });
    }

    const json = yield* Effect.tryPromise({
      try: () =>
        res.json() as Promise<{
          access_token: string;
          refresh_token: string;
          expires_in: number;
          scope: string;
        }>,
      catch: () =>
        new OAuthError({
          error: "parse_error",
          errorDescription: "Failed to parse token response",
        }),
    });
    return extractCredentials(json);
  });

/**
 * Generate a PlanetScale authorization URL for the given scopes.
 *
 * Scope names MUST use the tier prefix (`user:`, `organization:`,
 * `database:`, `branch:`) — bare names like `read_user` are rejected with
 * "The requested scope is invalid, unknown, or malformed." Use the values
 * from {@link ALL_SCOPES}, which carry the prefix.
 *
 * Pass an empty array to fall back to PlanetScale's implicit default set
 * (`read_databases`, `read_user`, `read_organization` — the only place
 * unprefixed names work).
 */
export function authorize(scopes: string[]): Authorization {
  const state = generateState();
  const url = new URL(OAUTH_ENDPOINTS.authorize);
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  if (scopes.length > 0) {
    url.searchParams.set("scope", scopes.join(" "));
  }
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

/**
 * Exchange an authorization code for OAuth credentials.
 */
export const exchange = (
  code: string,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    redirect_uri: OAUTH_REDIRECT_URI,
  });

/**
 * Refresh expired OAuth credentials.
 */
export const refresh = (
  credentials: OAuthCredentials,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  tokenRequest({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
  });

/**
 * Start a local HTTP server to listen for the OAuth callback, exchange
 * the authorization code, and return the credentials.
 *
 * Times out after 5 minutes.
 */
export const callback = (
  authorization: Authorization,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  Effect.tryPromise({
    try: () => callbackPromise(authorization),
    catch: (err) => {
      if (err instanceof OAuthError) return err;
      return new OAuthError({
        error: "callback_error",
        errorDescription: `OAuth callback failed: ${err}`,
      });
    },
  });

function callbackPromise(
  authorization: Authorization,
): Promise<OAuthCredentials> {
  const { pathname, port } = new URL(OAUTH_REDIRECT_URI);

  return new Promise<OAuthCredentials>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname !== pathname) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }

      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      if (error) {
        res.writeHead(302, { Location: "https://alchemy.run/auth/error" });
        res.end();
        cleanup();
        reject(
          new OAuthError({
            error,
            errorDescription: errorDescription ?? "An unknown error occurred.",
          }),
        );
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        res.writeHead(302, { Location: "https://alchemy.run/auth/error" });
        res.end();
        cleanup();
        reject(
          new OAuthError({
            error: "invalid_request",
            errorDescription: "Missing code or state",
          }),
        );
        return;
      }

      if (state !== authorization.state) {
        res.writeHead(302, { Location: "https://alchemy.run/auth/error" });
        res.end();
        cleanup();
        reject(
          new OAuthError({
            error: "invalid_request",
            errorDescription: "Invalid state",
          }),
        );
        return;
      }

      try {
        const credentials = await Effect.runPromise(exchange(code));
        res.writeHead(302, {
          Location: "https://alchemy.run/auth/success",
        });
        res.end();
        cleanup();
        resolve(credentials);
      } catch (err) {
        res.writeHead(302, { Location: "https://alchemy.run/auth/error" });
        res.end();
        cleanup();
        reject(err);
      }
    });

    const timeout = setTimeout(
      () => {
        cleanup();
        reject(
          new OAuthError({
            error: "timeout",
            errorDescription: "The authorization process timed out.",
          }),
        );
      },
      5 * 60 * 1000,
    );

    function cleanup() {
      clearTimeout(timeout);
      server.close();
    }

    server.on("error", (err) => {
      cleanup();
      reject(
        new OAuthError({
          error: "server_error",
          errorDescription: `Failed to start callback server: ${err.message}`,
        }),
      );
    });

    server.listen(Number(port));
  });
}

/**
 * Every PlanetScale OAuth scope accepted by the authorize endpoint.
 *
 * Per PlanetScale support, the canonical scope names use **tier prefixes**
 * (`user:`, `organization:`, `database:`, `branch:`). The public docs at
 * https://planetscale.com/docs/api/reference/oauth-access-scopes describe
 * these as "access tier" groupings, but the labels are literally part of
 * the scope identifier — `read_databases` alone is rejected; the auth
 * server wants `organization:read_databases`.
 *
 * The three OIDC scopes (`openid`, `email`, `profile`) and a handful of
 * legacy bare names (`read_user`, `read_organization`, `read_databases`,
 * etc.) are *also* accepted unprefixed for back-compat — but the prefixed
 * forms are the source of truth and the only ones the OAuth-app dashboard
 * persists, so this table only ships the prefixed set plus the OIDC trio.
 */
export const ALL_SCOPES = {
  // OIDC (unprefixed by spec)
  openid: "OpenID Connect scope",
  email: "Read user email",
  profile: "Read user profile",

  // User
  "user:read_user": "Read user",
  "user:write_user": "Write user",
  "user:read_organizations": "Read a user's organizations",

  // Organization
  "organization:read_organization": "Read organization",
  "organization:write_organization": "Write organization",
  "organization:delete_organization": "Delete organization",
  "organization:read_invoices": "Read organization invoices",
  "organization:read_members": "Read members in an organization",
  "organization:write_members": "Write members in an organization",
  "organization:delete_members": "Delete members in an organization",
  "organization:read_databases": "Read organization databases",
  "organization:create_databases": "Create organization databases",
  "organization:write_databases": "Write organization databases",
  "organization:delete_databases": "Delete organization databases",
  "organization:read_branches": "Read branches in an organization",
  "organization:write_branches": "Write branches in an organization",
  "organization:delete_branches": "Delete branches in an organization",
  "organization:promote_branches": "Promote branches in an organization",
  "organization:delete_production_branches":
    "Delete a production branch in an organization",
  "organization:manage_passwords":
    "Read, write, and delete branch passwords in an organization",
  "organization:manage_production_branch_passwords":
    "Read, write, and delete production branch passwords in an organization",
  "organization:manage_read_only_passwords":
    "Read, write, and delete read only branch passwords in an organization",
  "organization:manage_production_read_only_passwords":
    "Read, write, and delete production read only branch passwords in an organization",
  "organization:read_deploy_requests":
    "Read deploy requests in an organization",
  "organization:write_deploy_requests":
    "Create and update deploy requests in an organization",
  "organization:approve_deploy_requests":
    "Approve deploy requests in an organization",
  "organization:deploy_deploy_requests":
    "Deploy deploy requests in an organization",
  "organization:read_comments":
    "Read deploy request comments in an organization",
  "organization:write_comments":
    "Create deploy request comments in an organization",
  "organization:read_backups": "Read backups in an organization",
  "organization:write_backups": "Create and update backups in an organization",
  "organization:delete_backups": "Delete backups in an organization",
  "organization:delete_production_branch_backups":
    "Delete production backups in an organization",
  "organization:restore_backups":
    "Restore backups to new branches in an organization",
  "organization:restore_production_branch_backups":
    "Restore production branch backups to new branches in an organization",

  // Database
  "database:read_database": "Read database information",
  "database:write_database": "Write database",
  "database:delete_database": "Delete a database",
  "database:read_members": "Read members",
  "database:write_members": "Write members",
  "database:delete_members": "Delete members",
  "database:read_branches": "Read database branches",
  "database:write_branches": "Write database branches",
  "database:delete_branches": "Delete database branches",
  "database:promote_branches": "Promote database branches",
  "database:demote_branches": "Demote production database branches",
  "database:delete_production_branches": "Delete a production database branch",
  "database:manage_passwords":
    "Read, write, and delete database branch passwords",
  "database:manage_production_branch_passwords":
    "Read, write, and delete production branch passwords",
  "database:manage_read_only_passwords":
    "Read, write, and delete read only branch passwords",
  "database:manage_production_read_only_passwords":
    "Read, write, and delete production read only branch passwords",
  "database:read_deploy_requests": "Read deploy requests in a database",
  "database:write_deploy_requests":
    "Create and update deploy requests in a database",
  "database:approve_deploy_requests": "Approve deploy requests in a database",
  "database:deploy_deploy_requests": "Deploy deploy requests in a database",
  "database:read_comments": "Read deploy request comments in a database",
  "database:write_comments": "Create deploy request comments in a database",
  "database:read_backups": "Read backups",
  "database:write_backups": "Create and update backups",
  "database:delete_backups": "Delete backups",
  "database:delete_production_branch_backups": "Delete production backups",
  "database:restore_backups": "Restore backups to new branches",
  "database:restore_production_branch_backups":
    "Restore production branch backups to new branches",

  // Branch
  "branch:read_branch": "Read a database branch",
  "branch:write_branch": "Write a database branch",
  "branch:delete_branch": "Delete a database branch",
  "branch:manage_passwords": "Read, write, and delete branch passwords",
  "branch:manage_read_only_passwords":
    "Read, write, and delete read only branch passwords",
  "branch:read_backups": "Read backups",
  "branch:write_backups": "Create and update backups",
  "branch:delete_backups": "Delete backups",
  "branch:restore_backups": "Restore this branch's backups to new branches",
} as const;

/**
 * Reasonable defaults covering what the PlanetScale provider resources
 * (Database, Branch, MySQLPassword, MySQLMigrations, …) need to operate.
 * Override by running `alchemy login --configure`.
 */
export const DEFAULT_SCOPES: readonly (keyof typeof ALL_SCOPES)[] = [
  "user:read_user",
  "user:read_organizations",
  "organization:read_organization",
  "organization:read_databases",
  "organization:create_databases",
  "organization:write_databases",
  "organization:delete_databases",
  "organization:read_branches",
  "organization:write_branches",
  "organization:delete_branches",
  "organization:promote_branches",
  "organization:manage_passwords",
  "organization:manage_production_branch_passwords",
  "organization:read_deploy_requests",
  "organization:write_deploy_requests",
  "organization:approve_deploy_requests",
  "organization:deploy_deploy_requests",
  "organization:read_backups",
  "organization:write_backups",
  "organization:restore_backups",
];
