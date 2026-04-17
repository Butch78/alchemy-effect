import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";

const ALCHEMY_PROFILE = Config.string("ALCHEMY_PROFILE").pipe(
  Config.withDefault("default"),
);

export class CloudflareEnvironment extends Context.Service<
  CloudflareEnvironment,
  {
    account?: string;
  }
>()("Cloudflare::CloudflareEnvironment") {}

const CLOUDFLARE_ACCOUNT_ID = Config.string("CLOUDFLARE_ACCOUNT_ID");

export const fromEnv = () =>
  Layer.effect(
    CloudflareEnvironment,
    Effect.gen(function* () {
      const accountId = yield* CLOUDFLARE_ACCOUNT_ID.pipe(
        Config.option,
        Config.map(Option.getOrUndefined),
      );
      return { account: accountId } as any;
    }),
  );

export const fromProfile = () =>
  Layer.effect(
    CloudflareEnvironment,
    Effect.gen(function* () {
      const auth = yield* CloudflareAuth;

      const profileName = yield* ALCHEMY_PROFILE;
      const config = auth.read(profileName).pipe(
        Effect.map(Match.value),
        // Match.when({ accountId: Option.isSome }, () =>
        //   Option.getOrUndefined(config.accountId),
        // ),
        // Match.exhaustive,
      );
      const accountId =
        "accountId" in config
          ? (config.accountId as string | undefined)
          : undefined;

      return { account: profile.accountId } as any;
    }),
  );
