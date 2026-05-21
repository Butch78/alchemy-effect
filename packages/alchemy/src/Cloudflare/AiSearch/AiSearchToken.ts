import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { resolvePermissionGroup } from "../ApiToken/Common.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type AiSearchTokenProps = {
  /**
   * Token name. Used both for the underlying Cloudflare account API token and
   * for the AI Search service token entry. Defaults to a stable physical name
   * derived from `${app}-${stage}-${id}`.
   */
  name?: string;
};

export type AiSearchToken = Resource<
  "Cloudflare.AiSearchToken",
  AiSearchTokenProps,
  {
    /**
     * UUID returned by `POST /accounts/{accountId}/ai-search/tokens`. Pass
     * this to `Cloudflare.AiSearch({ tokenId: ... })`.
     */
    tokenId: string;
    /**
     * ID of the Cloudflare account API token that backs this AI Search
     * service token. Tracked so `delete` can tear both halves down.
     */
    accountTokenId: string;
    accountId: string;
    name: string;
  },
  never,
  Providers
>;

export const isAiSearchToken = (value: unknown): value is AiSearchToken =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as AiSearchToken).Type === "Cloudflare.AiSearchToken";

/**
 * A Cloudflare AI Search service token. Provisions the two-part token the AI
 * Search API requires for R2-backed (and web-crawler) instances:
 *
 *   1. A Cloudflare account API token with `AI Search Index Engine` and
 *      `Workers R2 Storage Write` permissions (account-scoped).
 *   2. A registration of that account token with AI Search itself.
 *
 * Both halves are owned by this resource and cleaned up on delete. Pass
 * `token.tokenId` into `Cloudflare.AiSearch`:
 *
 * @example R2-backed AI Search with auto-provisioned token
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("Docs");
 * const token = yield* Cloudflare.AiSearchToken("SearchToken");
 * const search = yield* Cloudflare.AiSearch("DocsSearch", {
 *   tokenId: token.tokenId,
 *   source: { type: "r2", bucketName: bucket.bucketName },
 * });
 * ```
 */
export const AiSearchToken = Resource<AiSearchToken>(
  "Cloudflare.AiSearchToken",
);

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id, maxLength: 64 });
  });

export const AiSearchTokenProvider = () =>
  Provider.effect(
    AiSearchToken,
    Effect.gen(function* () {
      const { accountId: defaultAccountId } = yield* CloudflareEnvironment;
      const createAccountToken = yield* accounts.createToken;
      const deleteAccountToken = yield* accounts.deleteToken;
      const createSearchToken = yield* aisearch.createToken;
      const readSearchToken = yield* aisearch.readToken;
      const deleteSearchToken = yield* aisearch.deleteToken;

      return {
        stables: ["tokenId", "accountTokenId", "accountId"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          // Tokens are functionally immutable here: the only mutable surface
          // is the name, and renaming a Cloudflare account API token is not
          // exposed through the same lifecycle. Trigger replace on rename.
          const nextName = yield* resolveName(id, news.name);
          const oldName = output?.name ?? (yield* resolveName(id, olds?.name));
          if (oldName !== nextName) return { action: "replace" } as const;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const acct = output?.accountId ?? defaultAccountId;
          const name = yield* resolveName(id, news?.name);

          // Observe — if we already have a registered AI Search token, trust
          // it. The plaintext account API token value only exists in memory
          // at create time, so we can't re-register from scratch on read.
          if (output?.tokenId) {
            const existing = yield* readSearchToken({
              accountId: acct,
              id: output.tokenId,
            }).pipe(
              Effect.map(() => true),
              Effect.catchTag("NotFound", () => Effect.succeed(false)),
            );
            if (existing) {
              return {
                tokenId: output.tokenId,
                accountTokenId: output.accountTokenId,
                accountId: acct,
                name: output.name ?? name,
              };
            }
          }

          // Ensure — create the underlying account API token with the
          // permissions Cloudflare's AI Search engine needs to read from R2
          // and run the indexer.
          const accountToken = yield* createAccountToken({
            accountId: acct,
            name: `${name} (AI Search Service Token)`,
            policies: [
              {
                effect: "allow",
                permissionGroups: [
                  resolvePermissionGroup("AI Search Index Engine"),
                  resolvePermissionGroup("Workers R2 Storage Write"),
                ],
                resources: { [`com.cloudflare.api.account.${acct}`]: "*" },
              },
            ],
          });

          if (!accountToken.id || !accountToken.value) {
            return yield* Effect.die(
              new Error(
                "AccountApiToken create returned no id/value; cannot register AI Search token",
              ),
            );
          }

          // Register with AI Search. The service stores the cf_api_key
          // internally — we only need to pass it through once.
          const registered = yield* createSearchToken({
            accountId: acct,
            name,
            cfApiId: accountToken.id,
            cfApiKey: accountToken.value,
          });

          return {
            tokenId: registered.id,
            accountTokenId: accountToken.id,
            accountId: acct,
            name: registered.name,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Order matters: AI Search refuses to delete a token while any
          // instance still references it (code 7076). Surface that as a
          // hard error rather than orphaning the account token, since the
          // user must tear down the dependent instance first.
          yield* deleteSearchToken({
            accountId: output.accountId,
            id: output.tokenId,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
          yield* deleteAccountToken({
            accountId: output.accountId,
            tokenId: output.accountTokenId,
          }).pipe(Effect.ignore);
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.tokenId) return undefined;
          return yield* readSearchToken({
            accountId: output.accountId,
            id: output.tokenId,
          }).pipe(
            Effect.map(() => ({
              tokenId: output.tokenId,
              accountTokenId: output.accountTokenId,
              accountId: output.accountId,
              name: output.name,
            })),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
