// UPSTREAM CONTRIBUTION — destined for the Alchemy v2 repo at
//   alchemy/src/Cloudflare/AiGateway/AiGatewaySpendingLimit.ts
//
// This file is authored against alchemy@2.0.0-beta.52 and the generated
// `@distilled.cloud/cloudflare@0.23.1` client. It mirrors the existing
// `AiGateway` provider's structure (Provider.effect lifecycle, desired/
// map/mutable helpers, diff → reconcile → delete → read) so it drops into
// the same directory and registration path. It is NOT part of the Expanse
// build — see ../PR_DESCRIPTION.md for the integration steps.
//
// Scope note: Cloudflare's AI Gateway exposes exactly one spend-control
// surface in its public API today — the *account-level* unified-billing
// spending limit (`/accounts/{account_id}/ai-gateway/billing/spending-limit`).
// The per-gateway / per-metadata ("$X per user") spend rules announced in
// the 2026-06-05 blog post are dashboard-only and absent from the OpenAPI
// schema (hence absent from the distilled client), so they cannot be wrapped
// yet. This resource covers the account-wide cap; revisit per-gateway rules
// when Cloudflare publishes them.
import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

/** Reset cadence for the spend window. */
export type AiGatewaySpendingLimitDuration = "daily" | "weekly" | "monthly";

/**
 * Enforcement algorithm — `fixed` resets the counter on the window boundary,
 * `sliding` tracks a rolling window. Mirrors the gateway's rate-limiting
 * `technique` semantics.
 */
export type AiGatewaySpendingLimitStrategy = "fixed" | "sliding";

export type AiGatewaySpendingLimitProps = {
  /**
   * Spending limit, **in cents** (Cloudflare's native unit; minimum `100` =
   * $1.00). Tracks cumulative AI Gateway spend across the account.
   */
  amount: number;
  /**
   * Window over which `amount` accumulates before reset/roll-off.
   */
  duration: AiGatewaySpendingLimitDuration;
  /**
   * Enforcement algorithm.
   *
   * @default "fixed"
   */
  strategy?: AiGatewaySpendingLimitStrategy;
};

export type AiGatewaySpendingLimit = Resource<
  "Cloudflare.AiGatewaySpendingLimit",
  AiGatewaySpendingLimitProps,
  {
    accountId: string;
    amount: number;
    duration: AiGatewaySpendingLimitDuration;
    strategy: AiGatewaySpendingLimitStrategy;
    /** Whether Cloudflare currently reports the limit as active. */
    enabled: boolean;
  },
  never,
  Providers
>;

export const isAiGatewaySpendingLimit = (
  value: unknown,
): value is AiGatewaySpendingLimit =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as AiGatewaySpendingLimit).Type ===
    "Cloudflare.AiGatewaySpendingLimit";

/**
 * The account-level Cloudflare AI Gateway spending limit — a hard dollar cap
 * on cumulative spend across every gateway in the account's Unified Billing.
 *
 * This is a **per-account singleton**: Cloudflare stores a single limit per
 * account (`/accounts/{account_id}/ai-gateway/billing/spending-limit`), so
 * declaring more than one `AiGatewaySpendingLimit` against the same account
 * will make them fight over the same remote object. Declare exactly one.
 *
 * @section Setting a spend cap
 * @example Monthly cap
 * ```ts
 * import * as Cloudflare from "alchemy/Cloudflare";
 *
 * const cap = yield* Cloudflare.AiGatewaySpendingLimit("ai-spend-cap", {
 *   amount: 25_000, // cents -> $250.00 (minimum 100 = $1.00)
 *   duration: "monthly",
 * });
 * ```
 *
 * @example Sliding daily window
 * ```ts
 * const cap = yield* Cloudflare.AiGatewaySpendingLimit("ai-spend-cap", {
 *   amount: 5_000, // cents -> $50.00
 *   duration: "daily",
 *   strategy: "sliding",
 * });
 * ```
 */
export const AiGatewaySpendingLimit = Resource<AiGatewaySpendingLimit>(
  "Cloudflare.AiGatewaySpendingLimit",
);

export const AiGatewaySpendingLimitProvider = () =>
  Provider.effect(
    AiGatewaySpendingLimit,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const getLimit = yield* aiGateway.getBillingSpendingLimit;
      const createLimit = yield* aiGateway.createBillingSpendingLimit;
      const deleteLimit = yield* aiGateway.deleteBillingSpendingLimit;

      // Resolve the desired config from props (or from cached attributes /
      // prior props), applying the `strategy` default. Accepts the loose
      // overlap shared by Props, Attributes, `olds`, and `output`.
      const desired = (props?: {
        amount?: number;
        duration?: string;
        strategy?: string;
      }) => ({
        amount: props?.amount ?? 0,
        duration: (props?.duration ??
          "monthly") as AiGatewaySpendingLimitDuration,
        strategy: (props?.strategy ??
          "fixed") as AiGatewaySpendingLimitStrategy,
      });

      // Fields that, when changed, drive an in-place update vs. a replace.
      const mutable = (v: {
        amount: number;
        duration: string;
        strategy: string;
      }) => ({ amount: v.amount, duration: v.duration, strategy: v.strategy });

      return {
        stables: ["accountId"],
        diff: Effect.fn(function* ({ olds = {}, news, output }) {
          if (!isResolved(news)) return undefined;
          // The limit is keyed solely by account; an account change is the
          // only structural identity change and forces a replace.
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const oldMutable = mutable(output ?? desired(olds));
          const nextMutable = mutable(desired(news));
          if (!deepEqual(oldMutable, nextMutable)) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ news = {}, output }) {
          const acct = output?.accountId ?? accountId;
          const next = desired(news);
          // Upsert — POST to this per-account singleton is idempotent, so we
          // always apply the desired shape; adoption, drift, and routine
          // updates all converge through the one call. The create returns no
          // body and the stored state is exactly what we send, so we report
          // the applied shape directly rather than paying a read-back GET.
          yield* createLimit({
            accountId: acct,
            amount: next.amount,
            duration: next.duration,
            strategy: next.strategy,
          });
          return { accountId: acct, ...next, enabled: true };
        }),
        delete: Effect.fn(function* ({ output }) {
          // DELETE on the spending-limit endpoint is idempotent — removing an
          // absent limit is a server-side no-op.
          yield* deleteLimit({ accountId: output.accountId });
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const acct = output?.accountId ?? accountId;
          const current = yield* getLimit({ accountId: acct });
          // A disabled limit means there is no resource to track.
          if (!current.enabled) return undefined;
          // GET config fields are nullable; prefer the server's view and fall
          // back to the prior known shape.
          const prior = output ?? desired(olds);
          return {
            accountId: acct,
            amount: current.config.amount ?? prior.amount,
            duration: (current.config.duration ??
              prior.duration) as AiGatewaySpendingLimitDuration,
            strategy: (current.config.strategy ??
              prior.strategy) as AiGatewaySpendingLimitStrategy,
            enabled: current.enabled,
          };
        }),
      };
    }),
  );
