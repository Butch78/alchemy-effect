import { adopt } from "@/AdoptPolicy";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as R2 from "@/Cloudflare/R2";
import { Stack } from "@/Stack";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import {
  findWorker,
  getWorkerTags,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";
import InternalWorker from "./internal-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "worker.ts");

test.provider("create, update, delete worker", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const s = yield* Stack;

    yield* stack.destroy();

    const worker = yield* stack.deploy(
      Effect.gen(function* () {
        yield* R2.R2Bucket("Bucket", {
          storageClass: "Standard",
        });

        const worker = yield* Cloudflare.Worker("TestWorker", {
          main,
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });

        return worker;
      }),
    );

    const actualWorker = yield* findWorker(worker.workerName, accountId);
    expect(actualWorker?.scriptName).toEqual(worker.workerName);
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stack:${s.name}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stage:${s.stage}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      "alchemy:id:TestWorker",
    );

    // Verify the worker is accessible via URL
    if (worker.url) {
      yield* Effect.logInfo(`Worker URL: ${worker.url}`);
    }

    // Update the worker
    const updatedWorker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("TestWorker", {
          main,
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualUpdatedWorker = yield* findWorker(
      updatedWorker.workerName,
      accountId,
    );
    expect(actualUpdatedWorker?.scriptName).toEqual(updatedWorker.workerName);
    const actualUpdatedSubdomain = yield* workers.getScriptSubdomain({
      accountId,
      scriptName: updatedWorker.workerName,
    });
    expect(actualUpdatedSubdomain).toEqual({
      enabled: true,
      previewsEnabled: true,
    });

    yield* stack.destroy();

    yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete worker with assets", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const s = yield* Stack;

    yield* stack.destroy();

    const worker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("TestWorkerWithAssets", {
          main,
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualWorker = yield* findWorker(worker.workerName, accountId);
    expect(actualWorker?.scriptName).toEqual(worker.workerName);
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stack:${s.name}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stage:${s.stage}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      "alchemy:id:TestWorkerWithAssets",
    );

    // Verify the worker has assets
    expect(worker.hash?.assets).toBeDefined();

    // Verify the worker is accessible via URL
    if (worker.url) {
      yield* Effect.logInfo(`Worker with Assets URL: ${worker.url}`);
    }

    // Update the worker
    const updatedWorker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("TestWorkerWithAssets", {
          main,
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualUpdatedWorker = yield* findWorker(
      updatedWorker.workerName,
      accountId,
    );
    expect(actualUpdatedWorker?.scriptName).toEqual(updatedWorker.workerName);
    expect(updatedWorker.hash?.assets).toBeDefined();

    // Final update
    const finalWorker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("TestWorkerWithAssets", {
          main,
          url: true,
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    yield* stack.destroy();

    yield* waitForWorkerToBeDeleted(finalWorker.workerName, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete internal worker", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const s = yield* Stack;

    yield* stack.destroy();

    const worker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* InternalWorker;
      }),
    );

    const actualWorker = yield* findWorker(worker.workerName, accountId);
    expect(actualWorker?.scriptName).toEqual(worker.workerName);
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stack:${s.name}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stage:${s.stage}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      "alchemy:id:InternalWorker",
    );

    const updatedWorker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* InternalWorker;
      }),
    );

    expect(updatedWorker.workerName).toEqual(worker.workerName);

    yield* stack.destroy();

    yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
  }).pipe(logLevel),
);

// ── Engine-level adoption ─────────────────────────────────────────────────
//
// The engine always calls `provider.read` when there is no prior state, and
// routes on the returned shape:
//
//   - undefined         → resource doesn't exist, drive a normal create
//   - plain attrs       → resource exists and is owned by us (Worker
//                         determines this from `alchemy:*` tags); silent
//                         adoption regardless of `--adopt`
//   - `Unowned(attrs)`  → resource exists but the tags don't identify us;
//                         the engine fails with `OwnedBySomeoneElse` unless
//                         the user opted in via `adopt(true)` / `--adopt`,
//                         in which case it's a silent takeover.
//
// The tests below use `test.provider`'s scratch state so we can wipe state
// mid-test while leaving the actual Cloudflare Worker in place — simulating
// "the user created/deployed this worker before, but this state store has
// never seen it" (e.g. CLI-driven first deploy on a fresh machine, or a
// state-store reset).

test.provider(
  "owned worker (matching alchemy tags) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Phase 1: deploy normally so a real Worker exists on Cloudflare,
      // tagged with this stack/stage/id.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("AdoptableWorker", {
            main,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: { date: "2024-01-01" },
          });
        }),
      );
      expect(yield* findWorker(initial.workerName, accountId)).toBeDefined();

      // Phase 2: wipe local state for this resource — the worker stays on
      // Cloudflare. From the next deploy's perspective this looks like a
      // fresh state store that has never seen this resource.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableWorker",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy *without* `adopt(true)`. The engine calls
      // `provider.read`, the Worker's read sees its own alchemy tags and
      // returns plain (owned) attrs, and the engine silently adopts.
      // No `--adopt` flag is required.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("AdoptableWorker", {
            main,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: { date: "2024-01-01" },
          });
        }),
      );

      expect(adopted.workerName).toEqual(initial.workerName);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableWorker",
        });
      }).pipe(Effect.provide(stack.state));

      expect(persisted?.status).toBeDefined();
      expect(persisted?.attr).toMatchObject({
        workerName: initial.workerName,
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(initial.workerName, accountId);
    }).pipe(logLevel),
);

test.provider(
  "unowned worker (foreign alchemy tags) requires adopt(true) to take over",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Phase 1: deploy under logical id "Original" with an explicit
      // physical name. The Cloudflare Worker is now tagged
      // `alchemy:id:Original` — i.e. owned by *that* logical resource.
      const physicalName = `alchemy-test-adopt-takeover-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("Original", {
            main,
            name: physicalName,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: { date: "2024-01-01" },
          });
        }),
      );
      expect(yield* findWorker(original.workerName, accountId)).toBeDefined();
      expect(yield* getWorkerTags(physicalName, accountId)).toContain(
        "alchemy:id:Original",
      );

      // Wipe state for the "Original" entry; the worker stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "Original",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 2: attempting to deploy the same physical worker under a
      // *different* logical id without `adopt(true)` must fail —
      // `Worker.read` returns `Unowned(attrs)` because the existing tags
      // identify a different logical id, and the engine raises
      // `OwnedBySomeoneElse`.
      const rejected = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("Different", {
              main,
              name: physicalName,
              subdomain: { enabled: true, previewsEnabled: true },
              compatibility: { date: "2024-01-01" },
            });
          }),
        )
        .pipe(Effect.exit);

      expect(Exit.isFailure(rejected)).toBe(true);
      if (Exit.isFailure(rejected)) {
        const reason = rejected.cause.reasons.find(Cause.isFailReason);
        expect((reason?.error as any)?._tag).toBe("OwnedBySomeoneElse");
      }

      // Phase 3: opt in via `adopt(true)`. The engine takes over even
      // though tags identify a different logical id. The next
      // create/update overwrites tags so the worker is now ours.
      const takenOver = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("Different", {
            main,
            name: physicalName,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: { date: "2024-01-01" },
          });
        }).pipe(adopt(true)),
      );

      expect(takenOver.workerName).toEqual(physicalName);

      const newTags = yield* getWorkerTags(physicalName, accountId);
      expect(newTags).toContain("alchemy:id:Different");
      expect(newTags).not.toContain("alchemy:id:Original");

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(physicalName, accountId);
    }).pipe(logLevel),
);
