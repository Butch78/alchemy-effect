import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { getCloudflareEnvKey } from "../CloudflareContext.ts";

export const fetch = Effect.fn(function* (
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  yield* bindFetch();
  const fetcher = yield* getCloudflareEnvKey<runtime.Fetcher>("ASSETS");
  return yield* Effect.promise(
    (): Promise<Response> =>
      fetcher.fetch(
        input as URL | runtime.RequestInfo,
        init as runtime.RequestInit<runtime.CfProperties<unknown>>,
      ) as unknown as Promise<Response>,
  );
});

export const bindFetch = Binding.fn<FetchBinding>("Cloudflare.Assets.Fetch");

export class FetchBinding extends Binding.Service(
  "Cloudflare.Assets.Fetch",
  Effect.fn(function* () {}),
) {}

export type Fetch = FetchBinding;
