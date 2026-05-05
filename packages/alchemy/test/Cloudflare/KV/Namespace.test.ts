import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as KV from "@/Cloudflare/KV/index";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete namespace with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const namespace = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* KV.KVNamespace("DefaultNamespace");
      }),
    );

    expect(namespace.title).toBeDefined();
    expect(namespace.namespaceId).toBeDefined();

    const actualNamespace = yield* kv.getNamespace({
      accountId,
      namespaceId: namespace.namespaceId,
    });
    expect(actualNamespace.id).toEqual(namespace.namespaceId);

    yield* stack.destroy();

    yield* waitForNamespaceToBeDeleted(namespace.namespaceId, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete namespace", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const namespace = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* KV.KVNamespace("TestNamespace", {
          title: "test-namespace-initial",
        });
      }),
    );

    const actualNamespace = yield* kv.getNamespace({
      accountId,
      namespaceId: namespace.namespaceId,
    });
    expect(actualNamespace.id).toEqual(namespace.namespaceId);
    expect(actualNamespace.title).toEqual(namespace.title);

    const updatedNamespace = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* KV.KVNamespace("TestNamespace", {
          title: "test-namespace-updated",
        });
      }),
    );

    const actualUpdatedNamespace = yield* kv.getNamespace({
      accountId,
      namespaceId: updatedNamespace.namespaceId,
    });
    expect(actualUpdatedNamespace.title).toEqual("test-namespace-updated");
    expect(actualUpdatedNamespace.id).toEqual(updatedNamespace.namespaceId);

    yield* stack.destroy();

    yield* waitForNamespaceToBeDeleted(namespace.namespaceId, accountId);
  }).pipe(logLevel),
);

// Engine-level adoption: KV namespaces have no ownership signal (Cloudflare
// doesn't expose tags on KV), so a name match in `read` is treated as silent
// adoption. The test wipes local state mid-run while leaving the namespace
// on Cloudflare — this simulates a fresh state store seeing an existing
// resource with the same physical name.
test.provider(
  "existing namespace (matching title) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Use a fixed title so the namespace's identity persists across a
      // state-store wipe.
      const title = `alchemy-test-kv-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Phase 1: deploy normally so a real KV namespace exists on Cloudflare.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.KVNamespace("AdoptableNamespace", { title });
        }),
      );
      expect(initial.title).toEqual(title);
      const initialId = initial.namespaceId;
      expect(initialId).toBeDefined();

      // Phase 2: wipe local state — the namespace stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableNamespace",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy without `adopt(true)`. The engine calls
      // `provider.read`, which lists namespaces, matches by title, and
      // returns plain attrs — silent adoption.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.KVNamespace("AdoptableNamespace", { title });
        }),
      );

      // Same physical namespace — adoption, not re-creation.
      expect(adopted.namespaceId).toEqual(initialId);
      expect(adopted.title).toEqual(title);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableNamespace",
        });
      }).pipe(Effect.provide(stack.state));

      expect(persisted?.attr).toMatchObject({
        namespaceId: initialId,
        title,
      });

      yield* stack.destroy();
      yield* waitForNamespaceToBeDeleted(initialId, accountId);
    }).pipe(logLevel),
);

// ─────────────────────────────────────────────────────────────────────
// Lifecycle convergence
//
// Reconcile must converge from any starting state — pristine, drifted,
// out-of-band-deleted, or replaced — without leaning on `olds` as a
// source of truth. The tests below pin down each of those starting
// states for KV namespaces, where the only mutable property is `title`.
// ─────────────────────────────────────────────────────────────────────

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const title = `alchemy-test-kv-idempotent-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.KVNamespace("IdempotentNamespace", { title });
        }),
      );

      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.KVNamespace("IdempotentNamespace", { title });
        }),
      );

      // Same physical namespace — reconciler did not replace or rename.
      expect(v2.namespaceId).toEqual(v1.namespaceId);
      expect(v2.title).toEqual(v1.title);
      expect(v2.title).toEqual(title);

      const live = yield* kv.getNamespace({
        accountId,
        namespaceId: v2.namespaceId,
      });
      expect(live.id).toEqual(v1.namespaceId);
      expect(live.title).toEqual(title);

      yield* stack.destroy();
      yield* waitForNamespaceToBeDeleted(v1.namespaceId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets title mutated out-of-band via the raw KV API",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const desiredTitle = `alchemy-test-kv-drift-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.KVNamespace("DriftNamespace", {
            title: desiredTitle,
          });
        }),
      );
      expect(v1.title).toEqual(desiredTitle);

      // Mutate the title out-of-band — this is the kind of drift you'd
      // see if someone renames the namespace via the Cloudflare
      // dashboard or `wrangler kv:namespace rename`.
      yield* kv.updateNamespace({
        accountId,
        namespaceId: v1.namespaceId,
        title: `${desiredTitle}-tampered`,
      });
      const drifted = yield* kv.getNamespace({
        accountId,
        namespaceId: v1.namespaceId,
      });
      expect(drifted.title).toEqual(`${desiredTitle}-tampered`);

      // Re-deploy with the original desired title — reconcile observes
      // the live title, sees it doesn't match, and renames back.
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.KVNamespace("DriftNamespace", {
            title: desiredTitle,
          });
        }),
      );
      expect(v2.namespaceId).toEqual(v1.namespaceId);
      expect(v2.title).toEqual(desiredTitle);

      const repaired = yield* kv.getNamespace({
        accountId,
        namespaceId: v2.namespaceId,
      });
      expect(repaired.title).toEqual(desiredTitle);

      yield* stack.destroy();
      yield* waitForNamespaceToBeDeleted(v1.namespaceId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a namespace deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const title = `alchemy-test-kv-recreate-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.KVNamespace("RecreateNamespace", { title });
        }),
      );
      const initialId = v1.namespaceId;

      // Delete the namespace out-of-band — local state still says it
      // exists, but Cloudflare disagrees. The KV API removes the
      // namespace immediately; there is no "recently deleted" cooldown.
      yield* kv.deleteNamespace({
        accountId,
        namespaceId: initialId,
      });
      yield* waitForNamespaceToBeDeleted(initialId, accountId);

      // Reconcile must observe the missing namespace via getNamespace
      // (returns NamespaceNotFound), fall back to a fresh
      // createNamespace, and converge.
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.KVNamespace("RecreateNamespace", { title });
        }),
      );
      expect(v2.title).toEqual(title);

      const live = yield* kv.getNamespace({
        accountId,
        namespaceId: v2.namespaceId,
      });
      expect(live.id).toEqual(v2.namespaceId);
      expect(live.title).toEqual(title);

      yield* stack.destroy();
      yield* waitForNamespaceToBeDeleted(v2.namespaceId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "changing title triggers in-place rename, not replace",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const titleA = `alchemy-test-kv-rename-a-${suffix}`;
      const titleB = `alchemy-test-kv-rename-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.KVNamespace("RenameNamespace", { title: titleA });
        }),
      );
      expect(a.title).toEqual(titleA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.KVNamespace("RenameNamespace", { title: titleB });
        }),
      );

      // Same physical namespace — the diff returns `update`, not
      // `replace`, and reconcile renames in place via updateNamespace.
      expect(b.namespaceId).toEqual(a.namespaceId);
      expect(b.title).toEqual(titleB);

      const live = yield* kv.getNamespace({
        accountId,
        namespaceId: b.namespaceId,
      });
      expect(live.title).toEqual(titleB);

      yield* stack.destroy();
      yield* waitForNamespaceToBeDeleted(a.namespaceId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "destroying an already-deleted namespace is a no-op",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const namespace = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KV.KVNamespace("DoubleDestroyNamespace");
        }),
      );

      // Delete the namespace out-of-band so the next destroy hits the
      // `NamespaceNotFound` path inside provider.delete. It must succeed.
      yield* kv.deleteNamespace({
        accountId,
        namespaceId: namespace.namespaceId,
      });
      yield* waitForNamespaceToBeDeleted(namespace.namespaceId, accountId);

      // First destroy: state says the namespace exists, cloud disagrees.
      // delete catches NamespaceNotFound and completes cleanly.
      yield* stack.destroy();

      // Second destroy: state is gone; this is a true no-op. Repeated
      // destroys must never throw.
      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "adopt(true) re-claims a foreign namespace by title",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Phase 1: pre-create the namespace via the raw KV API so it has
      // no Alchemy ownership. Cloudflare KV doesn't expose tags, so a
      // foreign namespace looks identical to a silently-adoptable one;
      // we use `adopt(true)` to make the takeover explicit.
      const title = `alchemy-test-kv-takeover-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const foreign = yield* kv.createNamespace({ accountId, title });
      const foreignId = foreign.id;
      expect(foreignId).toBeDefined();

      // Phase 2: deploy under a logical id that has never seen this
      // namespace. With `adopt(true)` the engine's `read` returns plain
      // attrs and reconcile binds to the existing namespace rather than
      // creating a new one.
      const adopted = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* KV.KVNamespace("ForeignAdopt", { title });
          }),
        )
        .pipe(adopt(true));

      expect(adopted.namespaceId).toEqual(foreignId);
      expect(adopted.title).toEqual(title);

      yield* stack.destroy();
      yield* waitForNamespaceToBeDeleted(foreignId, accountId);
    }).pipe(logLevel),
);

const waitForNamespaceToBeDeleted = Effect.fn(function* (
  namespaceId: string,
  accountId: string,
) {
  yield* kv
    .getNamespace({
      accountId,
      namespaceId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new NamespaceStillExists())),
      Effect.retry({
        while: (e): e is NamespaceStillExists =>
          e instanceof NamespaceStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NamespaceNotFound", () => Effect.void),
    );
});

class NamespaceStillExists extends Data.TaggedError("NamespaceStillExists") {}
