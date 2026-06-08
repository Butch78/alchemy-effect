import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The spending limit is a per-ACCOUNT singleton, so these cases destroy first
// to clear any limit left by a prior run, then drive create -> update -> delete
// and verify each step against the live billing API.

test.provider(
  "create, read-back, and delete the account spending limit",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const getLimit = yield* aiGateway.getBillingSpendingLimit;

      yield* stack.destroy();

      const cap = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGatewaySpendingLimit("SpendCap", {
            amount: 12_345, // cents -> $123.45
            duration: "monthly",
          });
        }),
      );

      expect(cap.amount).toEqual(12_345);
      expect(cap.duration).toEqual("monthly");
      expect(cap.strategy).toEqual("fixed"); // default
      expect(cap.enabled).toEqual(true);

      const live = yield* getLimit({ accountId });
      expect(live.enabled).toEqual(true);
      expect(live.config.amount).toEqual(12_345);

      yield* stack.destroy();

      // After delete the account reports no active limit.
      const afterDelete = yield* getLimit({ accountId });
      expect(afterDelete.enabled).toEqual(false);
    }).pipe(logLevel),
);

test.provider("update the spending limit in place", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const getLimit = yield* aiGateway.getBillingSpendingLimit;

    yield* stack.destroy();

    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AiGatewaySpendingLimit("SpendCap", {
          amount: 10_000,
          duration: "weekly",
          strategy: "fixed",
        });
      }),
    );

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AiGatewaySpendingLimit("SpendCap", {
          amount: 50_000,
          duration: "monthly",
          strategy: "sliding",
        });
      }),
    );

    expect(updated.amount).toEqual(50_000);
    expect(updated.duration).toEqual("monthly");
    expect(updated.strategy).toEqual("sliding");

    const live = yield* getLimit({ accountId });
    expect(live.config.amount).toEqual(50_000);
    expect(live.config.duration).toEqual("monthly");

    yield* stack.destroy();
  }).pipe(logLevel),
);
