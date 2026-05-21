import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Bucket } from "./Bucket.ts";

/**
 * AI Search service token, auto-provisioned by `AiSearchToken` (creates the
 * underlying Cloudflare account API token with the right permissions and
 * registers it with the AI Search service).
 */
export const SearchToken = Cloudflare.AiSearchToken("SearchToken");

/**
 * AI Search instance indexing the example's R2 bucket.
 */
export const Search = Effect.gen(function* () {
  const bucket = yield* Bucket;
  const token = yield* SearchToken;
  return yield* Cloudflare.AiSearch("Search", {
    tokenId: token.tokenId,
    source: { type: "r2", bucketName: bucket.bucketName },
  });
});
