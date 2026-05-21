import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { Bucket } from "./bucket.ts";

/**
 * AI Search service token, auto-provisioned. Cloudflare requires a service
 * token for R2-backed instances; `AiSearchToken` mints the underlying account
 * API token and registers it with the AI Search service.
 */
export const Token = Cloudflare.AiSearchToken("AiSearchTestToken", {
  name: "alchemy-test-ai-search-token",
});

/**
 * AI Search instance indexed against the shared R2 bucket.
 */
export const Search = Effect.gen(function* () {
  const bucket = yield* Bucket;
  const token = yield* Token;
  return yield* Cloudflare.AiSearch("AiSearchTestInstance", {
    name: "alchemy-test-ai-search",
    tokenId: token.tokenId,
    source: { type: "r2", bucketName: bucket.bucketName },
  });
});
