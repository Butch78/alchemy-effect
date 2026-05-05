import * as Axiom from "@/Axiom";
import * as Test from "@/Test/Vitest";
import * as AxiomSdk from "@distilled.cloud/axiom";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Axiom.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

const getNotifier = (id: string) =>
  AxiomSdk.getNotifier({ id }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const assertNotifierDeleted = Effect.fn(function* (id: string) {
  const found = yield* getNotifier(id);
  expect(found).toBeUndefined();
});

test.provider(
  "create and delete notifier with default props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const notifierName = `alchemy-test-notifier-default-${randomSuffix()}`;

      const notifier = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Notifier("DefaultNotifier", {
            name: notifierName,
            properties: {
              email: { emails: ["alchemy-test@example.com"] },
            },
          });
        }),
      );

      expect(notifier.id).toBeDefined();
      expect(notifier.name).toEqual(notifierName);

      const observed = yield* getNotifier(notifier.id);
      expect(observed?.name).toEqual(notifierName);

      const notifierId = notifier.id;
      yield* stack.destroy();
      yield* assertNotifierDeleted(notifierId);
    }).pipe(logLevel),
);

test.provider(
  "redeploy notifier with same props is a no-op (id stable)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const notifierName = `alchemy-test-notifier-idem-${randomSuffix()}`;
      const props = {
        name: notifierName,
        properties: {
          email: { emails: ["a@example.com", "b@example.com"] },
        },
      };

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Notifier("IdemNotifier", props);
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Notifier("IdemNotifier", props);
        }),
      );

      expect(second.id).toEqual(initial.id);
      expect(second.name).toEqual(initial.name);

      const notifierId = initial.id;
      yield* stack.destroy();
      yield* assertNotifierDeleted(notifierId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets notifier settings mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const notifierName = `alchemy-test-notifier-drift-${randomSuffix()}`;
      const desired = {
        name: notifierName,
        properties: {
          email: { emails: ["managed@example.com"] },
        },
      };

      const notifier = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Notifier("DriftNotifier", desired);
        }),
      );

      // Mutate emails out-of-band.
      yield* AxiomSdk.updateNotifier({
        id: notifier.id,
        name: notifierName,
        properties: { email: { emails: ["drifted@example.com"] } },
      });

      const drifted = yield* getNotifier(notifier.id);
      expect(drifted?.properties.email?.emails).toEqual(["drifted@example.com"]);

      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Notifier("DriftNotifier", desired);
        }),
      );

      expect(redeployed.id).toEqual(notifier.id);
      const reconverged = yield* getNotifier(notifier.id);
      expect(reconverged?.properties.email?.emails).toEqual([
        "managed@example.com",
      ]);

      const notifierId = notifier.id;
      yield* stack.destroy();
      yield* assertNotifierDeleted(notifierId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a notifier deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const notifierName = `alchemy-test-notifier-recreate-${randomSuffix()}`;
      const desired = {
        name: notifierName,
        properties: {
          email: { emails: ["x@example.com"] },
        },
      };

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Notifier("RecreateNotifier", desired);
        }),
      );

      yield* AxiomSdk.deleteNotifier({ id: initial.id });
      yield* assertNotifierDeleted(initial.id);

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Notifier("RecreateNotifier", desired);
        }),
      );

      expect(recreated.name).toEqual(notifierName);
      const live = yield* getNotifier(recreated.id);
      expect(live?.name).toEqual(notifierName);

      const recreatedId = recreated.id;
      yield* stack.destroy();
      yield* assertNotifierDeleted(recreatedId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "changing notifier name updates in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const nameA = `alchemy-test-notifier-rename-a-${suffix}`;
      const nameB = `alchemy-test-notifier-rename-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Notifier("RenameNotifier", {
            name: nameA,
            properties: { email: { emails: ["a@example.com"] } },
          });
        }),
      );
      expect(a.name).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Notifier("RenameNotifier", {
            name: nameB,
            properties: { email: { emails: ["a@example.com"] } },
          });
        }),
      );

      // In-place rename — id stays stable.
      expect(b.id).toEqual(a.id);
      expect(b.name).toEqual(nameB);

      const notifierId = b.id;
      yield* stack.destroy();
      yield* assertNotifierDeleted(notifierId);
    }).pipe(logLevel),
);

test.provider(
  "destroying an already-deleted notifier is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const notifierName = `alchemy-test-notifier-doubledel-${randomSuffix()}`;

      const notifier = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Notifier("DoubleDelNotifier", {
            name: notifierName,
            properties: { email: { emails: ["x@example.com"] } },
          });
        }),
      );

      yield* AxiomSdk.deleteNotifier({ id: notifier.id });
      yield* assertNotifierDeleted(notifier.id);

      yield* stack.destroy();
    }).pipe(logLevel),
);
