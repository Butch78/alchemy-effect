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

const getMonitor = (id: string) =>
  AxiomSdk.getMonitor({ id }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const assertMonitorDeleted = Effect.fn(function* (id: string) {
  const found = yield* getMonitor(id);
  expect(found).toBeUndefined();
});

const monitorAplFor = (datasetName: string) =>
  `['${datasetName}'] | summarize count() by bin_auto(_time)`;

test.provider(
  "create and delete monitor with default props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const datasetName = `alchemy-test-monitor-default-${suffix}`;
      const monitorName = `alchemy-test-monitor-default-${suffix}`;

      const monitor = yield* stack.deploy(
        Effect.gen(function* () {
          const ds = yield* Axiom.Dataset("DefaultDS", { name: datasetName });
          return yield* Axiom.Monitor("DefaultMonitor", {
            name: monitorName,
            description: "default-test",
            type: "Threshold",
            aplQuery: monitorAplFor(datasetName),
            operator: "Above",
            threshold: 100,
            intervalMinutes: 5,
            rangeMinutes: 5,
            alertOnNoData: false,
            resolvable: true,
            notifierIds: [],
          });
        }),
      );

      expect(monitor.id).toBeDefined();
      expect(monitor.name).toEqual(monitorName);
      expect(monitor.threshold).toEqual(100);

      const observed = yield* getMonitor(monitor.id);
      expect(observed?.name).toEqual(monitorName);

      const monitorId = monitor.id;
      yield* stack.destroy();
      yield* assertMonitorDeleted(monitorId);
    }).pipe(logLevel),
);

test.provider(
  "redeploy monitor with same props is a no-op (id stable)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const datasetName = `alchemy-test-monitor-idem-${suffix}`;
      const monitorName = `alchemy-test-monitor-idem-${suffix}`;

      const props = (apl: string) => ({
        name: monitorName,
        description: "stable",
        type: "Threshold" as const,
        aplQuery: apl,
        operator: "Above" as const,
        threshold: 50,
        intervalMinutes: 5,
        rangeMinutes: 5,
        alertOnNoData: false,
        resolvable: true,
        notifierIds: [] as string[],
      });

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const ds = yield* Axiom.Dataset("IdemDS", { name: datasetName });
          return yield* Axiom.Monitor(
            "IdemMonitor",
            props(monitorAplFor(datasetName)),
          );
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const ds = yield* Axiom.Dataset("IdemDS", { name: datasetName });
          return yield* Axiom.Monitor(
            "IdemMonitor",
            props(monitorAplFor(datasetName)),
          );
        }),
      );

      expect(second.id).toEqual(initial.id);
      expect(second.name).toEqual(initial.name);
      expect(second.threshold).toEqual(50);

      const monitorId = initial.id;
      yield* stack.destroy();
      yield* assertMonitorDeleted(monitorId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets monitor settings mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const datasetName = `alchemy-test-monitor-drift-${suffix}`;
      const monitorName = `alchemy-test-monitor-drift-${suffix}`;

      const desired = (apl: string) => ({
        name: monitorName,
        description: "managed",
        type: "Threshold" as const,
        aplQuery: apl,
        operator: "Above" as const,
        threshold: 100,
        intervalMinutes: 5,
        rangeMinutes: 5,
        alertOnNoData: false,
        resolvable: true,
        notifierIds: [] as string[],
      });

      const monitor = yield* stack.deploy(
        Effect.gen(function* () {
          const ds = yield* Axiom.Dataset("DriftDS", { name: datasetName });
          return yield* Axiom.Monitor(
            "DriftMonitor",
            desired(monitorAplFor(datasetName)),
          );
        }),
      );

      // Mutate threshold + description out-of-band.
      yield* AxiomSdk.updateMonitor({
        ...desired(monitorAplFor(datasetName)),
        id: monitor.id,
        description: "drifted",
        threshold: 999,
      });

      const drifted = yield* getMonitor(monitor.id);
      expect(drifted?.threshold).toEqual(999);
      expect(drifted?.description).toEqual("drifted");

      // Re-deploy with original props — reconcile must converge it back.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          const ds = yield* Axiom.Dataset("DriftDS", { name: datasetName });
          return yield* Axiom.Monitor(
            "DriftMonitor",
            desired(monitorAplFor(datasetName)),
          );
        }),
      );

      expect(redeployed.id).toEqual(monitor.id);
      const reconverged = yield* getMonitor(monitor.id);
      expect(reconverged?.threshold).toEqual(100);
      expect(reconverged?.description).toEqual("managed");

      const monitorId = monitor.id;
      yield* stack.destroy();
      yield* assertMonitorDeleted(monitorId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a monitor deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const datasetName = `alchemy-test-monitor-recreate-${suffix}`;
      const monitorName = `alchemy-test-monitor-recreate-${suffix}`;

      const desired = (apl: string) => ({
        name: monitorName,
        description: "recreate",
        type: "Threshold" as const,
        aplQuery: apl,
        operator: "Above" as const,
        threshold: 10,
        intervalMinutes: 5,
        rangeMinutes: 5,
        alertOnNoData: false,
        resolvable: true,
        notifierIds: [] as string[],
      });

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const ds = yield* Axiom.Dataset("RecreateDS", { name: datasetName });
          return yield* Axiom.Monitor(
            "RecreateMonitor",
            desired(monitorAplFor(datasetName)),
          );
        }),
      );

      yield* AxiomSdk.deleteMonitor({ id: initial.id });
      yield* assertMonitorDeleted(initial.id);

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          const ds = yield* Axiom.Dataset("RecreateDS", { name: datasetName });
          return yield* Axiom.Monitor(
            "RecreateMonitor",
            desired(monitorAplFor(datasetName)),
          );
        }),
      );

      // New server-assigned id since the old one is gone.
      expect(recreated.id).toBeDefined();
      expect(recreated.name).toEqual(monitorName);
      const live = yield* getMonitor(recreated.id);
      expect(live?.name).toEqual(monitorName);

      const recreatedId = recreated.id;
      yield* stack.destroy();
      yield* assertMonitorDeleted(recreatedId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "changing monitor name updates in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const datasetName = `alchemy-test-monitor-rename-${suffix}`;
      const nameA = `alchemy-test-monitor-rename-a-${suffix}`;
      const nameB = `alchemy-test-monitor-rename-b-${suffix}`;

      const desired = (apl: string, name: string) => ({
        name,
        description: "rename",
        type: "Threshold" as const,
        aplQuery: apl,
        operator: "Above" as const,
        threshold: 10,
        intervalMinutes: 5,
        rangeMinutes: 5,
        alertOnNoData: false,
        resolvable: true,
        notifierIds: [] as string[],
      });

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          const ds = yield* Axiom.Dataset("RenameDS", { name: datasetName });
          return yield* Axiom.Monitor(
            "RenameMonitor",
            desired(monitorAplFor(datasetName), nameA),
          );
        }),
      );
      expect(a.name).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          const ds = yield* Axiom.Dataset("RenameDS", { name: datasetName });
          return yield* Axiom.Monitor(
            "RenameMonitor",
            desired(monitorAplFor(datasetName), nameB),
          );
        }),
      );

      // Rename is in-place — id stays stable, server takes the new name.
      expect(b.id).toEqual(a.id);
      expect(b.name).toEqual(nameB);

      const monitorId = b.id;
      yield* stack.destroy();
      yield* assertMonitorDeleted(monitorId);
    }).pipe(logLevel),
);

test.provider(
  "changing monitor type triggers replace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const datasetName = `alchemy-test-monitor-replace-${suffix}`;
      const monitorName = `alchemy-test-monitor-replace-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          const ds = yield* Axiom.Dataset("ReplaceDS", { name: datasetName });
          return yield* Axiom.Monitor("ReplaceMonitor", {
            name: monitorName,
            type: "Threshold",
            aplQuery: monitorAplFor(datasetName),
            operator: "Above",
            threshold: 10,
            intervalMinutes: 5,
            rangeMinutes: 5,
            notifierIds: [],
          });
        }),
      );
      expect(a.type).toEqual("Threshold");

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          const ds = yield* Axiom.Dataset("ReplaceDS", { name: datasetName });
          return yield* Axiom.Monitor("ReplaceMonitor", {
            name: monitorName,
            type: "MatchEvent",
            aplQuery: monitorAplFor(datasetName),
            intervalMinutes: 1,
            rangeMinutes: 1,
            notifierIds: [],
          });
        }),
      );

      expect(b.type).toEqual("MatchEvent");
      expect(b.id).not.toEqual(a.id);

      // Old monitor (different id) is deleted as part of the replacement.
      const oldId = a.id;
      yield* assertMonitorDeleted(oldId);

      const newId = b.id;
      yield* stack.destroy();
      yield* assertMonitorDeleted(newId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "destroying an already-deleted monitor is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const suffix = randomSuffix();
      const datasetName = `alchemy-test-monitor-doubledel-${suffix}`;
      const monitorName = `alchemy-test-monitor-doubledel-${suffix}`;

      const monitor = yield* stack.deploy(
        Effect.gen(function* () {
          const ds = yield* Axiom.Dataset("DoubleDelDS", { name: datasetName });
          return yield* Axiom.Monitor("DoubleDelMonitor", {
            name: monitorName,
            type: "Threshold",
            aplQuery: monitorAplFor(datasetName),
            operator: "Above",
            threshold: 1,
            intervalMinutes: 5,
            rangeMinutes: 5,
            notifierIds: [],
          });
        }),
      );

      yield* AxiomSdk.deleteMonitor({ id: monitor.id });
      yield* assertMonitorDeleted(monitor.id);

      // Provider's delete must catch NotFound and complete cleanly.
      yield* stack.destroy();
    }).pipe(logLevel),
);
