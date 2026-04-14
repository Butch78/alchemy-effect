import * as p from "@clack/prompts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { AwsLoginError } from "./AWS/index.ts";
import * as AWS from "./AWS/index.ts";
import * as Cloudflare from "./Cloudflare/index.ts";
import { type AlchemyProfile, getProfile, setProfile } from "./Config.ts";

export type { AuthProvider } from "./AuthProvider.ts";
export {
  getProfile,
  rootDir,
  setProfile,
  type AlchemyConfig,
  type AlchemyProfile,
} from "./Config.ts";
export {
  credentialsFilePath,
  deleteCredentials,
  displayRedacted,
  readCredentials,
  Redacted,
  writeCredentials,
} from "./Credentials.ts";
export { AWS, Cloudflare };

type ProviderKey = "aws" | "cloudflare";

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  aws: "AWS",
  cloudflare: "Cloudflare",
};

const ALL_PROVIDERS: ProviderKey[] = ["aws", "cloudflare"];

export const providers = {
  aws: AWS.provider,
  cloudflare: Cloudflare.provider,
} as const;

function describeMethod(key: ProviderKey, profile: AlchemyProfile): string {
  const cfg = profile[key];
  if (!cfg) return "";
  if (key === "aws") {
    const aws = cfg as AWS.AwsAuthConfig;
    if (aws.method === "sso") return `sso (${aws.ssoProfile})`;
    return aws.method;
  }
  const cf = cfg as Cloudflare.CloudflareAuthConfig;
  if (cf.method === "stored") return `stored (${cf.credentialType})`;
  return cf.method;
}

export const layer = (profileName: string) =>
  Layer.unwrap(
    getProfile(profileName).pipe(
      Effect.map((profile) => {
        if (!profile) return Layer.empty;

        const awsLayer = profile.aws
          ? Layer.merge(
              AWS.credentialsLayer(profileName, profile.aws),
              AWS.stageConfigLayer(profile.aws),
            )
          : undefined;

        const cfLayer = profile.cloudflare
          ? Layer.merge(
              Cloudflare.credentialsLayer(profileName, profile.cloudflare),
              Cloudflare.stageConfigLayer(profile.cloudflare),
            )
          : undefined;

        if (awsLayer && cfLayer) return Layer.merge(awsLayer, cfLayer);
        if (awsLayer) return awsLayer;
        if (cfLayer) return cfLayer;
        return Layer.empty;
      }),
    ),
  );

type AllErrors =
  | AwsLoginError
  | Cloudflare.OAuthClient.OAuthError
  | PlatformError;

type AllRequirements =
  | FileSystem.FileSystem
  | ChildProcessSpawner
  | Path.Path
  | HttpClient.HttpClient;

const configureProvider = (
  key: ProviderKey,
  profileName: string,
  isReconfigure: boolean,
): Effect.Effect<
  AWS.AwsAuthConfig | Cloudflare.CloudflareAuthConfig | "remove" | undefined,
  AllErrors,
  AllRequirements
> => {
  return providers[key].configure(profileName, isReconfigure);
};

const loginProvider = (
  key: ProviderKey,
  config: AWS.AwsAuthConfig | Cloudflare.CloudflareAuthConfig,
): Effect.Effect<void, AllErrors, AllRequirements> => {
  if (key === "aws") return AWS.login(config as AWS.AwsAuthConfig);
  return Cloudflare.login(config as Cloudflare.CloudflareAuthConfig);
};

const logoutProvider = (
  key: ProviderKey,
  profileName: string,
  config: AWS.AwsAuthConfig | Cloudflare.CloudflareAuthConfig,
): Effect.Effect<void, never, AllRequirements> => {
  if (key === "aws")
    return AWS.logout(profileName, config as AWS.AwsAuthConfig);
  return Cloudflare.logout(
    profileName,
    config as Cloudflare.CloudflareAuthConfig,
  );
};

export const configure = (
  profileName: string,
): Effect.Effect<
  boolean,
  AllErrors,
  AllRequirements
> =>
  Effect.gen(function* () {
    const existing = yield* getProfile(profileName);
    const isFirstTime = !existing;

    p.intro(`Alchemy Effect — Configure profile: ${profileName}`);

    if (isFirstTime) {
      return yield* configureFirstTime(profileName);
    }
    return yield* configureExisting(profileName, existing);
  });

const configureFirstTime = (
  profileName: string,
): Effect.Effect<
  boolean,
  AllErrors,
  AllRequirements
> =>
  Effect.gen(function* () {
    const selected = yield* Effect.promise(() =>
      p.multiselect({
        message: "Which providers would you like to enable?",
        options: ALL_PROVIDERS.map((key) => ({
          value: key,
          label: PROVIDER_LABELS[key],
        })),
        required: true,
      }),
    );
    if (p.isCancel(selected)) {
      p.cancel("Configuration cancelled.");
      return false;
    }

    const profile: AlchemyProfile = {};
    const toLogin: {
      key: ProviderKey;
      config: AWS.AwsAuthConfig | Cloudflare.CloudflareAuthConfig;
    }[] = [];

    for (const key of selected) {
      const result = yield* configureProvider(key, profileName, false);
      if (result === undefined) {
        p.cancel("Configuration cancelled.");
        return false;
      }
      profile[key] = result as any;
      toLogin.push({ key, config: result as any });
    }

    yield* setProfile(profileName, profile);
    p.log.success(`Profile "${profileName}" saved.`);

    for (const { key, config } of toLogin) {
      yield* loginProvider(key, config);
    }

    p.outro("Done.");
    return true;
  });

const configureExisting = (
  profileName: string,
  existing: AlchemyProfile,
): Effect.Effect<
  boolean,
  AllErrors,
  AllRequirements
> =>
  Effect.gen(function* () {
    const enabled = ALL_PROVIDERS.filter((k) => existing[k]);
    const disabled = ALL_PROVIDERS.filter((k) => !existing[k]);
    const sorted = [...enabled, ...disabled];

    const selected = yield* Effect.promise(() =>
      p.multiselect({
        message: "Which providers would you like to change?",
        options: sorted.map((key) => {
          const cfg = existing[key];
          return {
            value: key,
            label: PROVIDER_LABELS[key],
            hint: cfg
              ? `enabled — ${describeMethod(key, existing)}`
              : "not configured",
          };
        }),
        required: false,
      }),
    );
    if (p.isCancel(selected)) {
      p.cancel("Configuration cancelled.");
      return false;
    }

    if (selected.length === 0) {
      p.log.info("Nothing to change.");
      p.outro("Done.");
      return true;
    }

    const profile: AlchemyProfile = { ...existing };
    const toLogin: {
      key: ProviderKey;
      config: AWS.AwsAuthConfig | Cloudflare.CloudflareAuthConfig;
    }[] = [];
    const toLogout: {
      key: ProviderKey;
      config: AWS.AwsAuthConfig | Cloudflare.CloudflareAuthConfig;
    }[] = [];

    for (const key of selected) {
      const wasConfigured = !!existing[key];
      const result = yield* configureProvider(key, profileName, wasConfigured);

      if (result === undefined) {
        p.cancel("Configuration cancelled.");
        return false;
      }

      if (result === "remove") {
        if (existing[key]) {
          toLogout.push({ key, config: existing[key]! as any });
        }
        delete profile[key];
        continue;
      }

      if (wasConfigured && existing[key]) {
        toLogout.push({ key, config: existing[key]! as any });
      }
      profile[key] = result as any;
      toLogin.push({ key, config: result as any });
    }

    yield* setProfile(profileName, profile);
    p.log.success(`Profile "${profileName}" saved.`);

    for (const { key, config } of toLogout) {
      yield* logoutProvider(key, profileName, config);
    }

    for (const { key, config } of toLogin) {
      yield* loginProvider(key, config);
    }

    p.outro("Done.");
    return true;
  });

export const login = (
  profileName: string,
): Effect.Effect<void, AllErrors, AllRequirements> =>
  Effect.gen(function* () {
    const profile = yield* getProfile(profileName);

    if (!profile) {
      yield* configure(profileName);
      return;
    }

    p.intro(`Alchemy Effect — Login (profile: ${profileName})`);

    if (!profile.aws && !profile.cloudflare) {
      p.log.warn(
        "No providers configured. Run 'alchemy-effect login --configure' to set up.",
      );
      p.outro("Done.");
      return;
    }

    if (profile.aws) {
      yield* AWS.login(profile.aws);
    }
    if (profile.cloudflare) {
      yield* Cloudflare.login(profile.cloudflare);
    }

    p.outro("Login complete.");
  });

export const logout = (
  profileName: string,
): Effect.Effect<void, never, AllRequirements> =>
  Effect.gen(function* () {
    const profile = yield* getProfile(profileName);

    if (!profile) {
      p.log.warn(
        `No profile found for "${profileName}". Nothing to log out of.`,
      );
      return;
    }

    p.intro(`Alchemy Effect — Logout (profile: ${profileName})`);

    if (!profile.aws && !profile.cloudflare) {
      p.log.warn("No providers configured.");
      p.outro("Done.");
      return;
    }

    if (profile.aws) {
      yield* AWS.logout(profileName, profile.aws);
    }
    if (profile.cloudflare) {
      yield* Cloudflare.logout(profileName, profile.cloudflare);
    }

    p.outro("Logout complete.");
  });

export const viewAuth = (
  profileName: string,
): Effect.Effect<void, never, AllRequirements> =>
  Effect.gen(function* () {
    const profile = yield* getProfile(profileName);

    if (!profile) {
      console.log(
        `No profile found for "${profileName}". Run: alchemy-effect login`,
      );
      return;
    }

    console.log(`\nAlchemy Effect — View Auth (profile: ${profileName})\n`);

    if (!profile.aws) {
      console.log("AWS: not configured");
    } else {
      yield* AWS.viewAuth(profileName, profile.aws);
    }

    console.log();

    if (!profile.cloudflare) {
      console.log("Cloudflare: not configured");
    } else {
      yield* Cloudflare.viewAuth(profileName, profile.cloudflare);
    }

    console.log();
  });
