import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Bucket } from "./Bucket.ts";

/**
 * AI Search service token. Mints a Cloudflare account API token with the
 * `AI Search Index Engine` and `Workers R2 Storage Write` permission groups
 * and registers it with the AI Search service.
 */
export const Token = Cloudflare.AiSearchToken("DocsSearchToken");

/**
 * AI Search instance indexing the example's R2 bucket. The token is
 * provisioned by the `Token` resource above; no manual setup required.
 */
export const Search = Effect.gen(function* () {
  const bucket = yield* Bucket;
  const token = yield* Token;
  return yield* Cloudflare.AiSearch("DocsSearch", {
    tokenId: token.tokenId,
    source: { type: "r2", bucketName: bucket.bucketName },
    chunkSize: 256,
    chunkOverlap: 10,
    maxNumResults: 10,
  });
});
