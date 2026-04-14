import * as p from "@clack/prompts";
import * as cfAccounts from "@distilled.cloud/cloudflare/accounts";
import * as CfCredentialsModule from "@distilled.cloud/cloudflare/Credentials";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ChildProcess } from "effect/unstable/process";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { StageConfig } from "../../Cloudflare/StageConfig.ts";
import type { AuthProvider } from "../AuthProvider.ts";
import {
  credentialsFilePath,
  deleteCredentials,
  displayRedacted,
  readCredentials,
  writeCredentials,
} from "../Credentials.ts";
import * as OAuthClient from "./OAuthClient.ts";
import { ALL_SCOPES, DEFAULT_SCOPES } from "./Scopes.ts";

export type { OAuthCredentials } from "./OAuthClient.ts";
export { ALL_SCOPES, DEFAULT_SCOPES } from "./Scopes.ts";
export { OAuthClient };

export type CloudflareAuthConfig =
  | { method: "env"; accountId?: string }
  | { method: "stored"; credentialType: "apiToken"; accountId?: string }
  | { method: "stored"; credentialType: "apiKey"; accountId?: string }
  | { method: "oauth"; scopes: string[]; accountId?: string };

export type CloudflareStoredCredentials =
  | { type: "apiToken"; apiToken: string }
  | { type: "apiKey"; apiKey: string; email: string }
  | OAuthClient.OAuthCredentials;

export type CloudflareResolvedCredentials =
  | {
      type: "apiToken";
      apiToken: Redacted.Redacted<string>;
      source: string;
    }
  | {
      type: "apiKey";
      apiKey: Redacted.Redacted<string>;
      email: string;
      source: string;
    }
  | {
      type: "oauth";
      accessToken: Redacted.Redacted<string>;
      expires: number;
      source: string;
    };

export function resolveFromEnv(): CloudflareResolvedCredentials | undefined {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (apiToken) {
    return {
      type: "apiToken",
      apiToken: Redacted.make(apiToken),
      source: "environment variables",
    };
  }
  const apiKey = process.env.CLOUDFLARE_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;
  if (apiKey && email) {
    return {
      type: "apiKey",
      apiKey: Redacted.make(apiKey),
      email,
      source: "environment variables",
    };
  }
  return undefined;
}

const promptAccountId = (): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const envAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const result = yield* Effect.promise(() =>
      p.text({
        message: "Cloudflare Account ID (Enter to skip)",
        placeholder: envAccountId ?? "",
        defaultValue: envAccountId ?? "",
      }),
    );
    if (p.isCancel(result)) return undefined;
    return result || undefined;
  });

const promptOAuthScopes = (): Effect.Effect<string[] | undefined> =>
  Effect.gen(function* () {
    const customize = yield* Effect.promise(() =>
      p.confirm({
        message: "Customize OAuth scopes? (default covers typical use cases)",
        initialValue: false,
      }),
    );
    if (p.isCancel(customize)) return undefined;

    if (!customize) return [...DEFAULT_SCOPES];

    const selected = yield* Effect.promise(() =>
      p.multiselect({
        message: "Select OAuth scopes",
        initialValues: DEFAULT_SCOPES as string[],
        options: Object.entries(ALL_SCOPES).map(([value, hint]) => ({
          value: value as string,
          label: value,
          hint,
        })),
        required: true,
      }),
    );
    if (p.isCancel(selected)) return undefined;
    return selected as string[];
  });

// ── Cloudflare Accounts API ──────────────────────────────────────────

/**
 * Provide a temporary Credentials + HttpClient layer from a raw OAuth
 * access token so we can call the distilled SDK outside of a full stack.
 */
const withOAuthCredentials = <A, E>(
  accessToken: string,
  effect: Effect.Effect<
    A,
    E,
    | CfCredentialsModule.Credentials
    | import("effect/unstable/http/HttpClient").HttpClient
  >,
): Effect.Effect<A, E> =>
  Effect.provide(
    effect,
    Layer.mergeAll(
      CfCredentialsModule.fromOAuth({
        load: Effect.succeed({ accessToken }),
        refresh: () =>
          Effect.die("refresh not expected during account selection"),
      }),
      FetchHttpClient.layer,
    ),
  );

const selectAccount = (
  accessToken: string,
): Effect.Effect<string | undefined, cfAccounts.ListAccountsError> =>
  Effect.gen(function* () {
    const list = yield* cfAccounts.listAccounts;
    const response = yield* list({});
    const accounts = response.result;
    if (accounts.length === 0) {
      p.log.warn("No Cloudflare accounts found for this credential.");
      return undefined;
    }
    if (accounts.length === 1) {
      const account = accounts[0]!;
      p.log.info(`Using account: ${account.name} (${account.id})`);
      return account.id;
    }
    const selected = yield* Effect.promise(() =>
      p.select({
        message: "Select a Cloudflare account",
        options: accounts.map((a) => ({
          value: a.id,
          label: a.name,
          hint: a.id,
        })),
      }),
    );
    if (p.isCancel(selected)) return undefined;
    return selected;
  }).pipe((effect) => withOAuthCredentials(accessToken, effect));

const matchMethod = Match.discriminator("method");

function printAccountId(accountId: string | undefined): void {
  const resolved = accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  console.log(
    `  accountId: ${resolved ?? "(not set — configure or set CLOUDFLARE_ACCOUNT_ID)"}`,
  );
}

function printCredentials(creds: CloudflareResolvedCredentials): void {
  Match.value(creds).pipe(
    Match.when({ type: "apiToken" }, (c) => {
      console.log(`  apiToken: ${displayRedacted(c.apiToken, 9)}`);
    }),
    Match.when({ type: "apiKey" }, (c) => {
      console.log(`  apiKey: ${displayRedacted(c.apiKey)}`);
      console.log(`  email:  ${c.email}`);
    }),
    Match.when({ type: "oauth" }, (c) => {
      console.log(`  accessToken: ${displayRedacted(c.accessToken)}`);
      const expiresIn = Math.max(
        0,
        Math.round((c.expires - Date.now()) / 1000),
      );
      console.log(
        `  expires: ${expiresIn > 0 ? `in ${expiresIn}s` : "expired"}`,
      );
    }),
    Match.exhaustive,
  );
  console.log(`  source: ${creds.source}`);
}

// ── Service ─────────────────────────────────────────────────────────────

export class CfAuth extends Context.Service<
  CfAuth,
  AuthProvider<CloudflareAuthConfig, CfCredentialsModule.Credentials>
>()("Auth::Cloudflare") {}

// ── Live layer ──────────────────────────────────────────────────────────
// Captures FileSystem and ChildProcessSpawner from context.
// All AuthProvider methods return clean Effects with no requirements.

export const CfAuthLive = Layer.effect(
  CfAuth,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // Build a layer to provide to inner effects that still yield* services
    const platform = Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem, fs),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const provide = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
      >,
    ) => Effect.provide(effect, platform);

    const provideLayer = <A>(
      layer: Layer.Layer<
        A,
        never,
        FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
      >,
    ) => Layer.provide(layer, platform);

    const oauthLogin = (
      profileName: string,
      scopes: string[],
    ): Effect.Effect<OAuthClient.OAuthCredentials | undefined> =>
      provide(
        Effect.gen(function* () {
          const allScopes = [...scopes, "offline_access"];
          const authorization = OAuthClient.authorize(allScopes);

          p.log.info(`Opening browser for Cloudflare OAuth login...`);
          p.log.info(authorization.url);

          yield* Effect.gen(function* () {
            const cmd =
              process.platform === "win32"
                ? "start"
                : process.platform === "darwin"
                  ? "open"
                  : "xdg-open";
            const args = process.platform === "win32" ? ["", authorization.url] : [authorization.url];
            const handle = yield* ChildProcess.make(cmd, args, { shell: true });
            yield* handle.exitCode;
          }).pipe(
            Effect.scoped,
            Effect.catch(() =>
              Effect.sync(() =>
                p.log.warn(
                  "Could not open browser automatically. Please open the URL above manually.",
                ),
              ),
            ),
          );

          p.log.info("Waiting for authorization (up to 5 minutes)...");

          const credentials = yield* OAuthClient.callback(authorization);

          yield* writeCredentials(profileName, "cloudflare", credentials);
          p.log.success("Cloudflare OAuth credentials saved.");
          return credentials;
        }).pipe(
          Effect.catchTag("OAuthError", (err) => {
            p.log.error(`OAuth login failed: ${err.errorDescription}`);
            return Effect.succeed(undefined);
          }),
        ),
      );

    const oauthProvider = (
      profileName: string,
      creds: OAuthClient.OAuthCredentials,
    ): CfCredentialsModule.OAuthProvider<FileSystem.FileSystem> => ({
      load: Effect.succeed({
        accessToken: creds.access,
        refreshToken: creds.refresh,
        expiresAt: creds.expires,
      }),
      refresh: (current) =>
        OAuthClient.refresh({
          type: "oauth",
          access: current.accessToken,
          refresh: current.refreshToken ?? "",
          expires: current.expiresAt ?? 0,
          scopes: [],
        }).pipe(
          Effect.tap((refreshed) =>
            writeCredentials(profileName, "cloudflare", refreshed).pipe(
              Effect.catch(() => Effect.void),
            ),
          ),
          Effect.map((refreshed) => ({
            accessToken: refreshed.access,
            refreshToken: refreshed.refresh,
            expiresAt: refreshed.expires,
          })),
          Effect.tapError(() =>
            Effect.logWarning(
              "Failed to refresh Cloudflare OAuth token. Run: alchemy-effect login",
            ),
          ),
        ),
    });

    const resolveFromStored = (
      profileName: string,
    ): Effect.Effect<CloudflareResolvedCredentials | undefined> =>
      provide(
        Effect.gen(function* () {
          const creds = yield* readCredentials<CloudflareStoredCredentials>(
            profileName,
            "cloudflare",
          );
          if (!creds) return undefined;
          const source = credentialsFilePath(profileName, "cloudflare");
          return Match.value(creds).pipe(
            Match.when({ type: "apiToken" }, (c) => ({
              type: "apiToken" as const,
              apiToken: Redacted.make(c.apiToken),
              source,
            })),
            Match.when({ type: "apiKey" }, (c) => ({
              type: "apiKey" as const,
              apiKey: Redacted.make(c.apiKey),
              email: c.email,
              source,
            })),
            Match.when({ type: "oauth" }, (c) => ({
              type: "oauth" as const,
              accessToken: Redacted.make(c.access),
              expires: c.expires,
              source,
            })),
            Match.exhaustive,
          );
        }),
      );

    const provider: AuthProvider<
      CloudflareAuthConfig,
      CfCredentialsModule.Credentials
    > = {
      name: "Cloudflare",

      configure: (profileName, isReconfigure = false) =>
        Effect.orDie(provide(
          Effect.gen(function* () {
            const options: {
              value: "oauth" | "env" | "stored" | "remove";
              label: string;
              hint?: string;
            }[] = [
              {
                value: "oauth",
                label: "OAuth (SSO)",
                hint: "recommended — browser-based login with automatic token refresh",
              },
              {
                value: "env",
                label: "Environment Variables",
                hint: "CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL",
              },
              {
                value: "stored",
                label: "Stored",
                hint: "stored in ~/.alchemy/credentials",
              },
            ];
            if (isReconfigure) {
              options.push({
                value: "remove",
                label: "Remove",
                hint: "remove Cloudflare from this profile",
              });
            }

            const method = yield* Effect.promise(() =>
              p.select({
                message: "Cloudflare authentication method",
                options,
              }),
            );
            if (p.isCancel(method)) return undefined;

            return yield* Match.value(method).pipe(
              Match.when("remove", () => Effect.succeed("remove" as const)),
              Match.when("oauth", () =>
                Effect.gen(function* () {
                  const scopes = yield* promptOAuthScopes();
                  if (scopes === undefined) return undefined;

                  const oauthCreds = yield* oauthLogin(profileName, scopes);
                  if (!oauthCreds) return undefined;

                  const accountId = yield* selectAccount(
                    oauthCreds.access,
                  ).pipe(
                    Effect.catch((err) => {
                      p.log.warn(
                        `Could not list accounts: ${err}. You can set CLOUDFLARE_ACCOUNT_ID instead.`,
                      );
                      return Effect.succeed(undefined);
                    }),
                  );
                  if (accountId === undefined) return undefined;
                  return {
                    method: "oauth" as const,
                    scopes,
                    ...(accountId ? { accountId } : {}),
                  };
                }),
              ),
              Match.when("env", () =>
                Effect.gen(function* () {
                  const accountId = yield* promptAccountId();
                  if (accountId === undefined) return undefined;
                  return {
                    method: "env" as const,
                    ...(accountId ? { accountId } : {}),
                  };
                }),
              ),
              Match.when("stored", () =>
                Effect.gen(function* () {
                  const credentialType = yield* Effect.promise(() =>
                    p.select({
                      message: "Cloudflare credential type",
                      options: [
                        {
                          value: "apiToken" as const,
                          label: "API Token",
                          hint: "recommended",
                        },
                        { value: "apiKey" as const, label: "API Key + Email" },
                      ],
                    }),
                  );
                  if (p.isCancel(credentialType)) return undefined;

                  return yield* Match.value(credentialType).pipe(
                    Match.when("apiToken", () =>
                      Effect.gen(function* () {
                        const apiToken = yield* Effect.promise(() =>
                          p.password({
                            message: "Cloudflare API Token",
                            validate: (v) =>
                              v.length === 0 ? "Required" : undefined,
                          }),
                        );
                        if (p.isCancel(apiToken)) return undefined;

                        yield* writeCredentials<CloudflareStoredCredentials>(
                          profileName,
                          "cloudflare",
                          { type: "apiToken", apiToken },
                        );
                        p.log.success("Cloudflare credentials saved.");
                        const accountId = yield* promptAccountId();
                        if (accountId === undefined) return undefined;
                        return {
                          method: "stored" as const,
                          credentialType: "apiToken" as const,
                          ...(accountId ? { accountId } : {}),
                        };
                      }),
                    ),
                    Match.when("apiKey", () =>
                      Effect.gen(function* () {
                        const apiKey = yield* Effect.promise(() =>
                          p.text({
                            message: "Cloudflare API Key",
                            validate: (v) =>
                              v.length === 0 ? "Required" : undefined,
                          }),
                        );
                        if (p.isCancel(apiKey)) return undefined;

                        const email = yield* Effect.promise(() =>
                          p.text({
                            message: "Cloudflare Email",
                            validate: (v) =>
                              v.length === 0 ? "Required" : undefined,
                          }),
                        );
                        if (p.isCancel(email)) return undefined;

                        yield* writeCredentials<CloudflareStoredCredentials>(
                          profileName,
                          "cloudflare",
                          { type: "apiKey", apiKey, email },
                        );
                        p.log.success("Cloudflare credentials saved.");
                        const accountId = yield* promptAccountId();
                        if (accountId === undefined) return undefined;
                        return {
                          method: "stored" as const,
                          credentialType: "apiKey" as const,
                          ...(accountId ? { accountId } : {}),
                        };
                      }),
                    ),
                    Match.exhaustive,
                  );
                }),
              ),
              Match.exhaustive,
            );
          }),
        )),

      login: (config) =>
        Effect.orDie(provide(
          Match.value(config).pipe(
            matchMethod("env", () =>
              Effect.sync(() =>
                p.log.info(
                  "Cloudflare: using environment variables — no login required.",
                ),
              ),
            ),
            matchMethod("stored", () =>
              Effect.sync(() =>
                p.log.info(
                  "Cloudflare: using stored credentials — no login required.",
                ),
              ),
            ),
            matchMethod("oauth", (c) =>
              Effect.gen(function* () {
                const creds =
                  yield* readCredentials<OAuthClient.OAuthCredentials>(
                    "default",
                    "cloudflare",
                  );
                if (
                  creds?.type === "oauth" &&
                  creds.expires > Date.now() + 10_000
                ) {
                  p.log.info(
                    "Cloudflare: OAuth credentials are still valid.",
                  );
                  return;
                }
                if (creds?.type === "oauth") {
                  p.log.info("Cloudflare: refreshing OAuth credentials...");
                  const refreshed = yield* OAuthClient.refresh(creds).pipe(
                    Effect.catchTag("OAuthError", () =>
                      Effect.succeed(undefined),
                    ),
                  );
                  if (refreshed) {
                    yield* writeCredentials(
                      "default",
                      "cloudflare",
                      refreshed,
                    );
                    p.log.success(
                      "Cloudflare OAuth credentials refreshed.",
                    );
                    return;
                  }
                }
                yield* oauthLogin("default", c.scopes);
              }),
            ),
            Match.exhaustive,
          ),
        )),

      logout: (profileName, config) =>
        provide(
          Match.value(config).pipe(
            matchMethod("stored", () =>
              Effect.gen(function* () {
                yield* deleteCredentials(profileName, "cloudflare");
                p.log.success("Cloudflare stored credentials removed.");
              }),
            ),
            matchMethod("env", () =>
              Effect.sync(() =>
                p.log.info(
                  "Cloudflare: using environment variables — nothing to log out of.",
                ),
              ),
            ),
            matchMethod("oauth", () =>
              Effect.gen(function* () {
                const creds =
                  yield* readCredentials<OAuthClient.OAuthCredentials>(
                    profileName,
                    "cloudflare",
                  );
                if (creds?.type === "oauth") {
                  yield* OAuthClient.revoke(creds).pipe(
                    Effect.catchTag("OAuthError", (err) =>
                      Effect.sync(() =>
                        p.log.warn(
                          `Could not revoke OAuth token: ${err.errorDescription}`,
                        ),
                      ),
                    ),
                  );
                }
                yield* deleteCredentials(profileName, "cloudflare");
                p.log.success("Cloudflare OAuth credentials removed.");
              }),
            ),
            Match.exhaustive,
          ),
        ),

      viewAuth: (profileName, config) =>
        Match.value(config).pipe(
          matchMethod("env", (c) =>
            Effect.sync(() => {
              console.log("Cloudflare: env");
              const resolved = resolveFromEnv();
              if (!resolved) {
                console.log("  CLOUDFLARE_API_TOKEN: (not set)");
                console.log("  CLOUDFLARE_API_KEY:   (not set)");
                console.log("  CLOUDFLARE_EMAIL:     (not set)");
              } else {
                printCredentials(resolved);
              }
              printAccountId(c.accountId);
            }),
          ),
          matchMethod("stored", (c) =>
            Effect.gen(function* () {
              console.log(`Cloudflare: stored (${c.credentialType})`);
              const resolved = yield* resolveFromStored(profileName);
              if (!resolved) {
                console.log(
                  "  ERROR: credentials not found. Run: alchemy-effect login --configure",
                );
              } else {
                printCredentials(resolved);
              }
              printAccountId(c.accountId);
            }),
          ),
          matchMethod("oauth", (c) =>
            Effect.gen(function* () {
              console.log("Cloudflare: oauth (SSO)");
              const resolved = yield* resolveFromStored(profileName);
              if (!resolved) {
                console.log(
                  "  ERROR: credentials not found. Run: alchemy-effect login",
                );
              } else {
                printCredentials(resolved);
              }
              console.log(`  scopes: ${c.scopes.join(", ")}`);
              printAccountId(c.accountId);
            }),
          ),
          Match.exhaustive,
        ),

      credentialsLayer: (profileName, config) =>
        Match.value(config).pipe(
          matchMethod("env", () => CfCredentialsModule.fromEnv()),
          matchMethod("stored", () =>
            provideLayer(
              Layer.unwrap(
                readCredentials<CloudflareStoredCredentials>(
                  profileName,
                  "cloudflare",
                ).pipe(
                  Effect.map((creds) => {
                    if (!creds) {
                      return Layer.effectDiscard(
                        Effect.die(
                          "Cloudflare stored credentials not found. Run: alchemy-effect login --configure",
                        ),
                      ) as Layer.Layer<CfCredentialsModule.Credentials>;
                    }
                    return Match.value(creds).pipe(
                      Match.when({ type: "apiToken" }, (c) =>
                        CfCredentialsModule.fromApiToken({
                          apiToken: c.apiToken,
                        }),
                      ),
                      Match.when({ type: "apiKey" }, (c) =>
                        CfCredentialsModule.fromApiKey({
                          apiKey: c.apiKey,
                          email: c.email,
                        }),
                      ),
                      Match.when({ type: "oauth" }, (c) =>
                        CfCredentialsModule.fromOAuth(
                          oauthProvider(profileName, c),
                        ),
                      ),
                      Match.exhaustive,
                    );
                  }),
                ),
              ),
            ),
          ),
          matchMethod("oauth", () =>
            provideLayer(
              Layer.unwrap(
                readCredentials<OAuthClient.OAuthCredentials>(
                  profileName,
                  "cloudflare",
                ).pipe(
                  Effect.map((creds) => {
                    if (!creds || creds.type !== "oauth") {
                      return Layer.effectDiscard(
                        Effect.die(
                          "Cloudflare OAuth credentials not found. Run: alchemy-effect login",
                        ),
                      ) as Layer.Layer<CfCredentialsModule.Credentials>;
                    }
                    return CfCredentialsModule.fromOAuth(
                      oauthProvider(profileName, creds),
                    );
                  }),
                ),
              ),
            ),
          ),
          Match.exhaustive,
        ),
    };

    return provider;
  }),
);

export const stageConfigLayer = (
  config: CloudflareAuthConfig,
): Layer.Layer<StageConfig> =>
  Layer.succeed(StageConfig, {
    account: config.accountId,
  });
