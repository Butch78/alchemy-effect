import * as p from "@clack/prompts";
import * as DistilledAuth from "@distilled.cloud/aws/Auth";
import { Credentials as AwsCredentials } from "@distilled.cloud/aws/Credentials";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { spawn } from "node:child_process";
import { StageConfig } from "../../AWS/StageConfig.ts";
import type { AuthProvider } from "../AuthProvider.ts";
import {
  credentialsFilePath,
  deleteCredentials,
  displayRedacted,
  readCredentials,
  writeCredentials,
} from "../Credentials.ts";

export type AwsAuthConfig =
  | { method: "sso"; ssoProfile: string }
  | { method: "env"; profile?: string }
  | { method: "stored"; profile?: string };

export interface AwsStoredCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsResolvedCredentials {
  accessKeyId: Redacted.Redacted<string>;
  secretAccessKey: Redacted.Redacted<string>;
  sessionToken?: Redacted.Redacted<string>;
  source: string;
}

export class AwsLoginError extends Data.TaggedError("AwsLoginError")<{
  message: string;
}> {}

export class AwsAuth extends Context.Service<
  AwsAuth,
  AuthProvider<AwsAuthConfig, AwsCredentials>
>()("Auth::AWS") {}

export function resolveFromEnv(): AwsResolvedCredentials | undefined {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  return {
    accessKeyId: Redacted.make(accessKeyId),
    secretAccessKey: Redacted.make(secretAccessKey),
    ...(sessionToken ? { sessionToken: Redacted.make(sessionToken) } : {}),
    source: "environment variables",
  };
}

const resolveFromStored = (
  profileName: string,
): Effect.Effect<
  AwsResolvedCredentials | undefined,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const creds = yield* readCredentials<AwsStoredCredentials>(
      profileName,
      "aws",
    );
    if (!creds) return undefined;
    return {
      accessKeyId: Redacted.make(creds.accessKeyId),
      secretAccessKey: Redacted.make(creds.secretAccessKey),
      ...(creds.sessionToken
        ? { sessionToken: Redacted.make(creds.sessionToken) }
        : {}),
      source: credentialsFilePath(profileName, "aws"),
    };
  });

/**
 * Prompt for AWS profile name (used for region/account lookup).
 * Returns:
 *   - `undefined` — user cancelled (Ctrl+C / escape)
 *   - `""`        — user skipped (Enter with no value); proceed without one
 *   - a string   — profile name to use
 */
const promptAwsProfile = (): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const envProfile = process.env.AWS_PROFILE;
    const result = yield* Effect.promise(() =>
      p.text({
        message:
          "AWS profile name for region/account (from ~/.aws/config, Enter to skip)",
        placeholder: envProfile ?? "default",
        defaultValue: envProfile ?? "",
      }),
    );
    if (p.isCancel(result)) return undefined;
    return result;
  });

const runSsoCommand = (
  command: "login" | "logout",
  ssoProfile: string,
): Effect.Effect<void, AwsLoginError> =>
  Effect.callback<void, AwsLoginError>((resume) => {
    const proc = spawn("aws", ["sso", command, "--profile", ssoProfile], {
      stdio: "inherit",
    });
    proc.on("close", (code) => {
      if (code === 0) resume(Effect.void);
      else
        resume(
          Effect.fail(
            new AwsLoginError({
              message: `aws sso ${command} exited with code ${code}`,
            }),
          ),
        );
    });
    proc.on("error", (err) =>
      resume(Effect.fail(new AwsLoginError({ message: err.message }))),
    );
  });

const matchMethod = Match.discriminator("method");

const printAwsProfileInfo = (awsProfile: string | undefined) =>
  Effect.gen(function* () {
    if (!awsProfile) {
      const envRegion =
        process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      if (envRegion) {
        console.log(`  region: ${envRegion} (from env)`);
      } else {
        console.log("  region: (not set)");
      }
      return;
    }
    const result = yield* Effect.gen(function* () {
      const auth = yield* DistilledAuth.Default;
      return yield* auth.loadProfile(awsProfile);
    }).pipe(
      Effect.match({
        onFailure: (err) => ({ error: String(err) }) as { error: string },
        onSuccess: (profile) => profile,
      }),
    );
    if ("error" in result) {
      console.log(`  profile: ${awsProfile} (failed to load: ${result.error})`);
      return;
    }
    console.log(`  profile: ${awsProfile}`);
    if (result.region) console.log(`  region:  ${result.region}`);
    if (result.sso_account_id)
      console.log(`  account: ${result.sso_account_id}`);
  });

function printCredentials(creds: AwsResolvedCredentials): void {
  console.log(`  accessKeyId:     ${displayRedacted(creds.accessKeyId)}`);
  console.log(`  secretAccessKey: ${displayRedacted(creds.secretAccessKey)}`);
  if (creds.sessionToken) {
    console.log(`  sessionToken:    ${displayRedacted(creds.sessionToken)}`);
  }
  console.log(`  source: ${creds.source}`);
}

const getAwsProfileName = (config: AwsAuthConfig): string | undefined =>
  Match.value(config).pipe(
    matchMethod("sso", (c) => c.ssoProfile),
    matchMethod("env", (c) => c.profile),
    matchMethod("stored", (c) => c.profile),
    Match.exhaustive,
  );

// ── Live layer ──────────────────────────────────────────────────────────
// Captures FileSystem, Path, HttpClient from context.
// All AuthProvider methods return clean Effects with no requirements.

export const AwsAuthLive = Layer.effect(
  AwsAuth,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;

    // Build a layer to provide to inner effects that still yield* services
    const platform = Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem, fs),
      Layer.succeed(Path.Path, path),
      Layer.succeed(HttpClient.HttpClient, httpClient),
    );

    const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | HttpClient.HttpClient>) =>
      Effect.provide(effect, platform);

    const provideLayer = <A>(layer: Layer.Layer<A, never, FileSystem.FileSystem | Path.Path | HttpClient.HttpClient>) =>
      Layer.provide(layer, platform);

    const provider: AuthProvider<AwsAuthConfig, AwsCredentials> = {
      name: "AWS",

      configure: (profileName, isReconfigure = false) =>
        Effect.orDie(provide(
          Effect.gen(function* () {
            const options: {
              value: "sso" | "env" | "stored" | "remove";
              label: string;
              hint?: string;
            }[] = [
              {
                value: "sso",
                label: "SSO",
                hint: "aws sso login — credentials loaded from AWS SSO cache",
              },
              {
                value: "env",
                label: "Environment Variables",
                hint: "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
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
                hint: "remove AWS from this profile",
              });
            }

            const method = yield* Effect.promise(() =>
              p.select({
                message: "AWS authentication method",
                options,
              }),
            );
            if (p.isCancel(method)) return undefined;

            return yield* Match.value(method).pipe(
              Match.when("remove", () => Effect.succeed("remove" as const)),
              Match.when("env", () =>
                Effect.gen(function* () {
                  const profile = yield* promptAwsProfile();
                  if (profile === undefined) return undefined;
                  return {
                    method: "env" as const,
                    ...(profile ? { profile } : {}),
                  };
                }),
              ),
              Match.when("sso", () =>
                Effect.gen(function* () {
                  const ssoProfile = yield* Effect.promise(() =>
                    p.text({
                      message: "AWS profile name (from ~/.aws/config)",
                      placeholder: "default",
                      defaultValue: "default",
                    }),
                  );
                  if (p.isCancel(ssoProfile)) return undefined;
                  return {
                    method: "sso" as const,
                    ssoProfile: ssoProfile || "default",
                  };
                }),
              ),
              Match.when("stored", () =>
                Effect.gen(function* () {
                  const accessKeyId = yield* Effect.promise(() =>
                    p.text({
                      message: "AWS Access Key ID",
                      validate: (v) =>
                        v.length === 0 ? "Required" : undefined,
                    }),
                  );
                  if (p.isCancel(accessKeyId)) return undefined;

                  const secretAccessKey = yield* Effect.promise(() =>
                    p.password({
                      message: "AWS Secret Access Key",
                      validate: (v) =>
                        v.length === 0 ? "Required" : undefined,
                    }),
                  );
                  if (p.isCancel(secretAccessKey)) return undefined;

                  const sessionToken = yield* Effect.promise(() =>
                    p.text({
                      message:
                        "AWS Session Token (optional — press Enter to skip)",
                      placeholder: "(none)",
                    }),
                  );
                  if (p.isCancel(sessionToken)) return undefined;

                  yield* writeCredentials<AwsStoredCredentials>(
                    profileName,
                    "aws",
                    {
                      accessKeyId,
                      secretAccessKey,
                      ...(sessionToken ? { sessionToken } : {}),
                    },
                  );
                  p.log.success("AWS credentials saved.");

                  const profile = yield* promptAwsProfile();
                  if (profile === undefined) return undefined;
                  return {
                    method: "stored" as const,
                    ...(profile ? { profile } : {}),
                  };
                }),
              ),
              Match.exhaustive,
            );
          }),
        )),

      login: (_profileName, config) =>
        Match.value(config).pipe(
          matchMethod("sso", (c) =>
            Effect.gen(function* () {
              const stillValid = yield* provide(
                DistilledAuth.loadProfileCredentials(c.ssoProfile).pipe(
                  Effect.match({
                    onFailure: () => false,
                    onSuccess: () => true,
                  }),
                ),
              );
              if (stillValid) {
                p.log.info(
                  `AWS SSO: profile '${c.ssoProfile}' already has valid credentials.`,
                );
                return;
              }
              p.log.info(
                `AWS SSO: running 'aws sso login --profile ${c.ssoProfile}'...`,
              );
              yield* runSsoCommand("login", c.ssoProfile);
              p.log.success("AWS SSO login complete.");
            }).pipe(
              Effect.catchTag("AwsLoginError", (err) =>
                Effect.sync(() => p.log.error(`AWS SSO login failed: ${err.message}`)),
              ),
            ),
          ),
          matchMethod("env", () =>
            Effect.sync(() =>
              p.log.info(
                "AWS: using environment variables — no login required.",
              ),
            ),
          ),
          matchMethod("stored", () =>
            Effect.sync(() =>
              p.log.info(
                "AWS: using stored credentials — no login required.",
              ),
            ),
          ),
          Match.exhaustive,
        ),

      logout: (profileName, config) =>
        provide(
          Match.value(config).pipe(
            matchMethod("sso", (c) =>
              Effect.gen(function* () {
                p.log.info(
                  `AWS SSO: running 'aws sso logout --profile ${c.ssoProfile}'...`,
                );
                const result = yield* runSsoCommand("logout", c.ssoProfile).pipe(
                  Effect.match({
                    onFailure: () => "failed" as const,
                    onSuccess: () => "ok" as const,
                  }),
                );
                if (result === "ok") {
                  p.log.success("AWS SSO logout complete.");
                } else {
                  p.log.warn(
                    "AWS SSO logout failed (session may already be expired).",
                  );
                }
              }),
            ),
            matchMethod("stored", () =>
              Effect.gen(function* () {
                yield* deleteCredentials(profileName, "aws");
                p.log.success("AWS stored credentials removed.");
              }),
            ),
            matchMethod("env", () =>
              Effect.sync(() =>
                p.log.info(
                  "AWS: using environment variables — nothing to log out of.",
                ),
              ),
            ),
            Match.exhaustive,
          ),
        ),

      viewAuth: (profileName, config) =>
        provide(
          Effect.gen(function* () {
            yield* Match.value(config).pipe(
              matchMethod("env", (c) =>
                Effect.gen(function* () {
                  console.log("AWS: env");
                  const resolved = resolveFromEnv();
                  if (!resolved) {
                    console.log("  AWS_ACCESS_KEY_ID:     (not set)");
                    console.log("  AWS_SECRET_ACCESS_KEY: (not set)");
                  } else {
                    printCredentials(resolved);
                  }
                  yield* printAwsProfileInfo(c.profile);
                }),
              ),
              matchMethod("stored", (c) =>
                Effect.gen(function* () {
                  console.log("AWS: stored");
                  const resolved = yield* resolveFromStored(profileName);
                  if (!resolved) {
                    console.log(
                      "  ERROR: credentials not found. Run: alchemy-effect login --configure",
                    );
                  } else {
                    printCredentials(resolved);
                  }
                  yield* printAwsProfileInfo(c.profile);
                }),
              ),
              matchMethod("sso", (c) =>
                Effect.gen(function* () {
                  console.log(`AWS: sso (profile: ${c.ssoProfile})`);
                  const ssoCredentials = yield* Effect.gen(function* () {
                    const auth = yield* DistilledAuth.Default;
                    const creds = yield* auth.loadProfileCredentials(
                      c.ssoProfile,
                    );
                    return {
                      accessKeyId: creds.accessKeyId,
                      secretAccessKey: creds.secretAccessKey,
                      sessionToken: creds.sessionToken,
                      source: "~/.aws/sso/cache",
                    } as AwsResolvedCredentials;
                  }).pipe(
                    Effect.catch((err: unknown) =>
                      Effect.succeed({ error: String(err) } as {
                        error: string;
                      }),
                    ),
                  );
                  if ("error" in ssoCredentials) {
                    console.log(`  ERROR: ${ssoCredentials.error}`);
                    console.log(
                      `  Run: aws sso login --profile ${c.ssoProfile}`,
                    );
                  } else {
                    printCredentials(ssoCredentials);
                  }
                  yield* printAwsProfileInfo(c.ssoProfile);
                }),
              ),
              Match.exhaustive,
            );
          }),
        ),

      credentialsLayer: (profileName, config) =>
        Match.value(config).pipe(
          matchMethod("sso", (c) =>
            provideLayer(
              Layer.effect(
                AwsCredentials,
                Effect.gen(function* () {
                  const auth = yield* DistilledAuth.Default;
                  return auth.loadProfileCredentials(c.ssoProfile);
                }),
              ),
            ),
          ),
          matchMethod("env", () => {
            const resolved = resolveFromEnv();
            if (!resolved) {
              return Layer.effectDiscard(
                Effect.die(
                  "AWS env credentials not found (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set)",
                ),
              ) as Layer.Layer<AwsCredentials>;
            }
            return Layer.succeed(
              AwsCredentials,
              Effect.succeed({
                accessKeyId: resolved.accessKeyId,
                secretAccessKey: resolved.secretAccessKey,
                sessionToken: resolved.sessionToken,
              }),
            );
          }),
          matchMethod("stored", () =>
            provideLayer(
              Layer.unwrap(
                readCredentials<AwsStoredCredentials>(profileName, "aws").pipe(
                  Effect.map((creds) => {
                    if (!creds) {
                      return Layer.effectDiscard(
                        Effect.die(
                          "AWS stored credentials not found. Run: alchemy-effect login --configure",
                        ),
                      ) as Layer.Layer<AwsCredentials>;
                    }
                    return Layer.succeed(
                      AwsCredentials,
                      Effect.succeed({
                        accessKeyId: Redacted.make(creds.accessKeyId),
                        secretAccessKey: Redacted.make(creds.secretAccessKey),
                        sessionToken: creds.sessionToken
                          ? Redacted.make(creds.sessionToken)
                          : undefined,
                      }),
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
  config: AwsAuthConfig,
) => {
  const awsProfile = getAwsProfileName(config);
  if (!awsProfile) {
    return Layer.succeed(StageConfig, {});
  }
  return Layer.effect(
    StageConfig,
    Effect.gen(function* () {
      const auth = yield* DistilledAuth.Default;
      const profile = yield* auth.loadProfile(awsProfile);
      return {
        profile: awsProfile,
        account: profile.sso_account_id,
        region: profile.region,
      };
    }),
  );
};

// Backwards compat — old `provider` export is now accessed via the service
export { AwsCredentials };
