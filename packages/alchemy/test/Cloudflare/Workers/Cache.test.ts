import * as Cloudflare from "@/Cloudflare/index.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import {
  expectWorkerExists,
  findWorker,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");

// Workers Cache (https://developers.cloudflare.com/workers/cache/) is set
// through the script-upload metadata (`cache: { enabled, cross_version_cache }`).
// The settings API has no typed read-back for it, so this suite asserts the
// full deploy -> update -> destroy lifecycle is accepted by Cloudflare with the
// cache metadata present on the upload.
describe.concurrent("Cloudflare.Worker cache", () => {
  test.provider(
    "deploys a worker with cache enabled",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("CacheWorker", {
              main,
              compatibility: { date: "2024-01-01" },
              cache: { enabled: true, crossVersionCache: true },
            });
          }),
        );

        const deployed = yield* findWorker(worker.workerName, accountId);
        expect(deployed?.scriptName).toEqual(worker.workerName);
        yield* expectWorkerExists(worker.workerName, accountId);

        // Update path: toggling a cache field re-puts the metadata and must
        // still be accepted.
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("CacheWorker", {
              main,
              compatibility: { date: "2024-01-01" },
              cache: { enabled: true, crossVersionCache: false },
            });
          }),
        );
        yield* expectWorkerExists(worker.workerName, accountId);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 120_000 },
  );
});
