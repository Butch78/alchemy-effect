import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import os from "node:os";
import path from "pathe";
import type { AuthError, AuthProvider } from "./AuthProvider.ts";

export const rootDir = path.join(os.homedir(), ".alchemy");
export const configFilePath = path.join(rootDir, "profiles.json");

export const CONFIG_VERSION = 2;

export class AlchemyProfiles extends Context.Service<
  AlchemyProfiles,
  {
    version: typeof CONFIG_VERSION;
    profiles: Record<string, AlchemyProfile>;
  }
>()("Alchemy::Profiles") {}

export type AlchemyProfile = Record<string, { method: string }>;

const emptyConfig = (): AlchemyProfiles["Service"] => ({
  version: CONFIG_VERSION,
  profiles: {},
});

export const readConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const data = yield* fs
    .readFileString(configFilePath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (data === undefined) return emptyConfig();
  try {
    const parsed = JSON.parse(data);
    if (parsed?.version !== CONFIG_VERSION) {
      return emptyConfig();
    }
    return parsed as AlchemyProfiles["Service"];
  } catch {
    return emptyConfig();
  }
});

export const writeConfig = Effect.fnUntraced(function* (
  config: AlchemyProfiles["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(path.dirname(configFilePath), {
    recursive: true,
  });
  yield* fs.writeFileString(configFilePath, JSON.stringify(config, null, 2));
});

export const getProfile = (name: string) =>
  readConfig.pipe(Effect.map((config) => config.profiles[name]));

export const setProfile = (
  name: string,
  profile: AlchemyProfile,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const config = yield* readConfig;
    config.profiles[name] = profile;
    yield* writeConfig(config);
  });

/**
 * Load the stored config for the given AuthProvider in `profileName`.
 * If absent, run the provider's interactive `configure` step and persist the
 * resulting config under the provider's name.
 */
export const loadOrConfigure = <Config extends { method: string }>(
  auth: AuthProvider<Config>,
  profileName: string,
): Effect.Effect<Config, AuthError | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const existing = yield* getProfile(profileName);
    const stored = existing?.[auth.name] as Config | undefined;
    if (stored) return stored;
    const config = yield* auth.configure(profileName);
    yield* setProfile(profileName, {
      ...existing,
      [auth.name]: config,
    });
    return config;
  });
