import {
  apiKeyCredentials,
  apiTokenCredentials,
  Credentials,
  oauthCredentials,
  type ResolvedCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { loadOrConfigure } from "../Profile/Profile.ts";
import {
  CloudflareAuth,
  type CloudflareResolvedCredentials,
} from "./Auth/AuthProvider.ts";

export { Credentials, fromEnv } from "@distilled.cloud/cloudflare/Credentials";

/**
 * Build a `Credentials` layer that resolves Cloudflare credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const auth = yield* CloudflareAuth;
      const profileName = yield* Config.string("ALCHEMY_PROFILE").pipe(
        Config.withDefault("default"),
      );
      const ctx = yield* Effect.context<never>();

      return Effect.gen(function* () {
        const config = yield* loadOrConfigure(auth, profileName);
        const creds = yield* auth.read(profileName, config);
        return toResolvedCredentials(creds);
      }).pipe(
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Cloudflare credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.provide(ctx),
      );
    }),
  );

const toResolvedCredentials = (
  creds: CloudflareResolvedCredentials,
): ResolvedCredentials => {
  switch (creds.type) {
    case "apiToken":
      return apiTokenCredentials({
        apiToken: Redacted.value(creds.apiToken),
      });
    case "apiKey":
      return apiKeyCredentials({
        apiKey: Redacted.value(creds.apiKey),
        email: Redacted.value(creds.email),
      });
    case "oauth":
      return oauthCredentials({
        accessToken: Redacted.value(creds.accessToken),
        expiresAt: creds.expires,
      });
  }
};
