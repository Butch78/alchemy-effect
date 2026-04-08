import * as Bundle from "@/Bundle/Bundle";
import { Account, fromEnv as accountFromEnv } from "@/Cloudflare/Account";
import {
  makeQueueClient,
  makeQueueConsumer,
  type QueueBatch,
} from "@/Cloudflare/Local/Bindings/queue";
import { makeR2Client } from "@/Cloudflare/Local/Bindings/r2";
import { connect } from "@/Cloudflare/Local/local-client";
import { LocalRpcs } from "@/Cloudflare/Local/rpc-schema";
import { CloudflareLogs, type TelemetryFilter } from "@/Cloudflare/Logs";
import type { LogLine } from "@/Provider";
import * as cf from "@distilled.cloud/cloudflare";
import cloudflarePlugin from "@distilled.cloud/cloudflare-rolldown-plugin";
import * as queuesApi from "@distilled.cloud/cloudflare/queues";
import * as r2Api from "@distilled.cloud/cloudflare/r2";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { NodeServices } from "@effect/platform-node";
import { afterAll, afterEach, describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodePath from "node:path";
const PROXY_WORKER_ENTRY = NodePath.resolve(
  import.meta.dirname,
  "../../../src/Cloudflare/Local/proxy-worker.ts",
);

const credentials = Layer.mergeAll(
  cf.CredentialsFromEnv,
  FetchHttpClient.layer,
);
const platform = NodeServices.layer;

const configProviderLayer = Layer.effect(
  ConfigProvider.ConfigProvider,
  Effect.map(ConfigProvider.fromDotEnv({ path: ".env" }), (dotEnv) =>
    ConfigProvider.orElse(dotEnv, ConfigProvider.fromEnv()),
  ),
);

const layers = Layer.provideMerge(
  Layer.mergeAll(credentials, accountFromEnv()),
  Layer.provideMerge(configProviderLayer, platform),
);

const bundleProxyWorker = Effect.gen(function* () {
  const { files } = yield* Bundle.build(
    {
      input: PROXY_WORKER_ENTRY,
      plugins: [
        cloudflarePlugin({
          compatibilityDate: "2026-03-10",
          compatibilityFlags: ["nodejs_compat"],
        }),
      ],
      checks: { unresolvedImport: false },
    },
    {
      format: "esm",
      sourcemap: "hidden",
      minify: true,
      keepNames: true,
    },
  );
  return {
    files: files.map(
      (file) =>
        new File([file.content as BlobPart], file.path, {
          type: file.path.endsWith(".js")
            ? "application/javascript+module"
            : file.path.endsWith(".map")
              ? "application/source-map"
              : "application/octet-stream",
        }),
    ),
    mainModule: files[0].path,
  };
});

const deployBundledProxyWorker = (
  scriptName: string,
  bundle: Effect.Success<typeof bundleProxyWorker>,
  extraBindings?: workers.PutScriptRequest["metadata"]["bindings"],
) =>
  Effect.gen(function* () {
    const accountId = yield* Account;
    const putScript = yield* workers.putScript;
    const createSubdomain = yield* workers.createScriptSubdomain;
    const getSubdomain = yield* workers.getSubdomain;

    const bindings: workers.PutScriptRequest["metadata"]["bindings"] = [
      {
        type: "durable_object_namespace",
        name: "SESSION",
        className: "Session",
      },
      ...(extraBindings ?? []),
    ];

    yield* Effect.logInfo(`Deploying proxy worker as ${scriptName}...`);

    const metadata = {
      mainModule: bundle.mainModule,
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      bindings,
      migrations: {
        newTag: "v1",
        newSqliteClasses: ["Session"],
        deletedClasses: [],
        renamedClasses: [],
        transferredClasses: [],
        newClasses: [],
      },
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true },
      },
    };

    yield* putScript({
      accountId,
      scriptName,
      metadata,
      files: bundle.files,
    }).pipe(
      Effect.catch((err) => {
        const msg = String(
          typeof err === "object" && err !== null && "message" in err
            ? err.message
            : err,
        );
        const expectedTag = msg.match(
          /when expected tag is ['"]?([^'"]+)['"]?/,
        )?.[1];
        const noTags = msg.includes("expected no tags");
        return putScript({
          accountId,
          scriptName,
          metadata: {
            ...metadata,
            migrations: noTags
              ? undefined
              : {
                  oldTag: expectedTag ?? "v1",
                  newTag: `v${Date.now()}`,
                  newSqliteClasses: [],
                  deletedClasses: [],
                  renamedClasses: [],
                  transferredClasses: [],
                  newClasses: [],
                },
          },
          files: bundle.files,
        });
      }),
    );

    yield* createSubdomain({
      accountId,
      scriptName,
      enabled: true,
    });
    const { subdomain } = yield* getSubdomain({ accountId });
    const workerUrl = `https://${scriptName}.${subdomain}.workers.dev`;

    yield* Effect.logInfo(`Proxy worker deployed at ${workerUrl}`);

    yield* Effect.logInfo("Waiting for worker to be reachable...");
    yield* Effect.retry(
      Effect.tryPromise(async () => {
        const res = await fetch(`${workerUrl}/health`);
        if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      }),
      Schedule.exponential("500 millis").pipe(Schedule.take(20)),
    );
    yield* Effect.logInfo("Worker is reachable");

    return workerUrl;
  });

const deployProxyWorker = (
  scriptName: string,
  extraBindings?: workers.PutScriptRequest["metadata"]["bindings"],
) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Bundling proxy worker...");
    const bundle = yield* bundleProxyWorker;
    yield* Effect.logInfo(
      `Bundled ${bundle.files.length} files, main: ${bundle.mainModule}`,
    );
    return yield* deployBundledProxyWorker(scriptName, bundle, extraBindings);
  });

const forceDeleteScript = (accountId: string, scriptName: string) =>
  workers.deleteScript({ accountId, scriptName, force: true }).pipe(
    Effect.tapError((err) =>
      Effect.logWarning(`Error deleting worker ${scriptName}: ${String(err)}`),
    ),
    Effect.retry({
      while: (err) => err._tag === "QueueConsumerConflict",
      schedule: Schedule.fixed("500 millis").pipe(Schedule.take(10)),
    }),
    Effect.catchTag("WorkerNotFound", () => Effect.void),
  );

const deleteProxyWorker = (scriptName: string) =>
  Effect.gen(function* () {
    const accountId = yield* Account;
    yield* forceDeleteScript(accountId, scriptName);
    yield* Effect.logInfo(`Proxy worker ${scriptName} deleted`);
  });

const noopQueueHandler = {
  localQueueBatch: () =>
    Effect.succeed({
      ackedIds: [],
      retriedIds: [],
      ackAll: false,
      retryAll: false,
    }),
};

const workerScriptFilters = (scriptName: string): TelemetryFilter[] => [
  {
    key: "$workers.scriptName",
    operation: "eq",
    type: "string",
    value: scriptName,
  },
];

/** Set from each live test; failures are queued for `afterAll` telemetry dump. */
let telemetryDumpTarget:
  | { accountId: string; scriptName: string; since: Date }
  | undefined;

const pendingFailedTelemetryDumps: Array<{
  accountId: string;
  scriptName: string;
  since: Date;
}> = [];

const registerTelemetryDumpTarget = (
  accountId: string,
  scriptName: string,
  since = new Date(),
) =>
  Effect.sync(() => {
    telemetryDumpTarget = { accountId, scriptName, since };
  });

const dumpWorkerLogsToConsole = (
  accountId: string,
  scriptName: string,
  since: Date,
) =>
  Effect.gen(function* () {
    // Cloudflare observability can lag slightly behind the test process.
    yield* Effect.sleep("2 seconds");
    const telemetry = yield* CloudflareLogs;
    const lines = yield* telemetry
      .queryLogs({
        accountId,
        filters: workerScriptFilters(scriptName),
        options: { since, limit: 200 },
      })
      .pipe(
        Effect.catch((e) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(
              `CloudflareLogs.queryLogs failed: ${String(e)}`,
            );
            return [] as LogLine[];
          }),
        ),
      );

    yield* Effect.logError(
      `--- Cloudflare worker logs (script=${scriptName}, since=${since.toISOString()}, limit=200) ---`,
    );
    for (const line of [...lines].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    )) {
      const row = `[${line.timestamp.toISOString()}] ${line.message}`;
      console.error(row);
      yield* Effect.logError(row);
    }
    console.error("--- end Cloudflare worker logs ---");
    yield* Effect.logError("--- end Cloudflare worker logs ---");
  });

const QUEUE_NAME_PREFIX = "alchemy-local-queue-test-";
const PROXY_WORKER_PREFIX = "alchemy-local-rpc-queue-";

const deleteConsumersForQueue = (accountId: string, queueId: string) =>
  Stream.runForEach(
    queuesApi.listConsumers.pages({ accountId, queueId }),
    (page) =>
      Effect.forEach(
        (page.result ?? []).filter((c) => !!c.consumerId),
        (c) =>
          Effect.gen(function* () {
            yield* Effect.logInfo(
              `Deleting consumer ${c.consumerId} on queue ${queueId}...`,
            );
            yield* queuesApi
              .deleteConsumer({
                accountId,
                queueId,
                consumerId: c.consumerId!,
              })
              .pipe(Effect.ignore);
          }),
        { concurrency: 8, discard: true },
      ),
  );

const deleteQueuesByPrefix = (accountId: string, prefix: string) =>
  Stream.runForEach(queuesApi.listQueues.pages({ accountId }), (page) =>
    Effect.forEach(
      (page.result ?? []).filter(
        (queue) =>
          !!queue.queueId &&
          !!queue.queueName &&
          queue.queueName.startsWith(prefix),
      ),
      (queue) =>
        Effect.gen(function* () {
          yield* deleteConsumersForQueue(accountId, queue.queueId!);
          yield* Effect.logInfo(
            `Deleting queue ${queue.queueName} (${queue.queueId})...`,
          );
          yield* queuesApi
            .deleteQueue({ accountId, queueId: queue.queueId! })
            .pipe(Effect.ignore);
        }),
      { concurrency: 8, discard: true },
    ),
  );

const deleteProxyWorkersByPrefix = (accountId: string, prefix: string) =>
  Stream.runForEach(workers.listScripts.pages({ accountId }), (page) =>
    Effect.forEach(
      (page.result ?? []).filter(
        (script) => !!script.id && script.id.startsWith(prefix),
      ),
      (script) =>
        Effect.gen(function* () {
          yield* Effect.logInfo(`Deleting proxy worker ${script.id}...`);
          yield* forceDeleteScript(accountId, script.id!);
        }),
      { concurrency: 8, discard: true },
    ),
  );

const cleanupOrphanedResources = (accountId: string) =>
  Effect.gen(function* () {
    yield* deleteQueuesByPrefix(accountId, QUEUE_NAME_PREFIX);
    yield* deleteProxyWorkersByPrefix(accountId, PROXY_WORKER_PREFIX);
  });

describe.sequential("Cloudflare Local RPC", () => {
  afterEach((ctx) => {
    const target = telemetryDumpTarget;
    telemetryDumpTarget = undefined;
    if (!target) return;
    const failed =
      (ctx as { task?: { result?: { state?: string } } }).task?.result
        ?.state === "fail";
    if (!failed) return;
    pendingFailedTelemetryDumps.push(target);
  });

  afterAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const targets = pendingFailedTelemetryDumps.splice(
          0,
          pendingFailedTelemetryDumps.length,
        );
        for (const t of targets) {
          yield* dumpWorkerLogsToConsole(t.accountId, t.scriptName, t.since);
        }
      }).pipe(
        Effect.provide(layers),
        Effect.scoped,
        Effect.catch((e) =>
          Effect.sync(() => {
            console.error("[telemetry dump]", e);
          }),
        ),
      ),
    ),
  );

  it.live(
    "bi-directional RPC over WebSocket",
    () =>
      Effect.gen(function* () {
        const accountId = yield* Account;
        const scriptName = "alchemy-local-rpc-ws";
        yield* registerTelemetryDumpTarget(accountId, scriptName);
        yield* deleteProxyWorker(scriptName).pipe(Effect.ignore);

        const workerUrl = yield* deployProxyWorker(scriptName);

        try {
          const wsUrl = `${workerUrl}/ws`;
          yield* Effect.logInfo(`Connecting to ${wsUrl}...`);

          const { remoteClient } = yield* connect(wsUrl).pipe(
            Effect.provide(
              LocalRpcs.toLayer({
                localPing: () => Effect.succeed({ ts: Date.now() }),
                localEcho: ({ message }) => Effect.succeed({ message }),
                ...noopQueueHandler,
              }),
            ),
            Effect.provide(Socket.layerWebSocketConstructorGlobal),
          );

          yield* Effect.logInfo("Testing remotePing...");
          const pingResult = yield* remoteClient.remotePing();
          expect(pingResult.ts).toBeTypeOf("number");
          expect(pingResult.ts).toBeGreaterThan(0);
          yield* Effect.logInfo(`remotePing returned ts=${pingResult.ts}`);

          yield* Effect.logInfo("Testing remoteEcho...");
          const echoResult = yield* remoteClient.remoteEcho({
            message: "hello from local",
          });
          expect(echoResult.message).toBe("hello from local");
          yield* Effect.logInfo(
            `remoteEcho returned message="${echoResult.message}"`,
          );

          yield* Effect.logInfo(
            "Testing remote -> local via /test-call-local...",
          );
          yield* Effect.sleep("1 second");

          const callLocalResult = yield* Effect.retry(
            Effect.tryPromise(async () => {
              const res = await fetch(`${workerUrl}/test-call-local`);
              if (!res.ok) {
                const body = await res.text();
                throw new Error(
                  `test-call-local failed: ${res.status} ${body}`,
                );
              }
              return res.json() as Promise<{
                ping: { ts: number };
                echo: { message: string };
              }>;
            }),
            Schedule.exponential("500 millis").pipe(Schedule.take(5)),
          );

          expect(callLocalResult.ping.ts).toBeTypeOf("number");
          expect(callLocalResult.ping.ts).toBeGreaterThan(0);
          expect(callLocalResult.echo.message).toBe("hello from remote");
          yield* Effect.logInfo("All WebSocket RPC tests passed!");
        } finally {
          yield* deleteProxyWorker(scriptName).pipe(Effect.ignore);
        }
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: 30_000 },
  );

  it.live(
    "R2 binding proxy over HTTP",
    () =>
      Effect.gen(function* () {
        const accountId = yield* Account;
        const scriptName = "alchemy-local-rpc-r2";
        yield* registerTelemetryDumpTarget(accountId, scriptName);
        yield* deleteProxyWorker(scriptName).pipe(Effect.ignore);

        const R2_BUCKET_NAME = "alchemy-local-r2-test";

        yield* Effect.logInfo(`Creating R2 bucket ${R2_BUCKET_NAME}...`);
        yield* r2Api
          .createBucket({ accountId, name: R2_BUCKET_NAME })
          .pipe(Effect.catchTag("BucketAlreadyExists", () => Effect.void));

        try {
          const workerUrl = yield* deployProxyWorker(scriptName, [
            {
              type: "r2_bucket",
              name: "BUCKET",
              bucketName: R2_BUCKET_NAME,
            },
          ]);

          const { r2 } = yield* makeR2Client(workerUrl);
          const bucket = r2("BUCKET");

          yield* Effect.logInfo("Testing streaming r2 put...");
          const encoder = new TextEncoder();
          const uploadStream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("Hello, "));
              controller.enqueue(encoder.encode("R2!"));
              controller.close();
            },
          });
          const putResult = yield* Effect.promise(() =>
            bucket.put("hello.txt", uploadStream, {
              httpMetadata: { contentType: "text/plain" },
              customMetadata: { source: "stream" },
            }),
          );
          expect(putResult.key).toBe("hello.txt");
          expect(putResult.size).toBeGreaterThan(0);
          yield* Effect.logInfo(`Put hello.txt, size=${putResult.size}`);

          yield* Effect.logInfo("Testing streaming r2 get...");
          const getResult = yield* Effect.promise(() =>
            bucket.get("hello.txt"),
          );
          expect(getResult).not.toBeNull();
          expect(getResult!.body).toBeInstanceOf(ReadableStream);
          expect(getResult!.customMetadata?.source).toBe("stream");
          const text = yield* Effect.promise(() =>
            new Response(getResult!.body).text(),
          );
          expect(text).toBe("Hello, R2!");
          yield* Effect.logInfo(`Get hello.txt, body="${text}"`);

          yield* Effect.logInfo("Testing r2 head...");
          const headResult = yield* Effect.promise(() =>
            bucket.head("hello.txt"),
          );
          expect(headResult).not.toBeNull();
          expect(headResult!.key).toBe("hello.txt");
          expect(headResult!.size).toBe(putResult.size);
          expect(headResult!.customMetadata?.source).toBe("stream");
          yield* Effect.logInfo(`Head hello.txt, size=${headResult!.size}`);

          yield* Effect.logInfo("Testing r2 list...");
          const listResult = yield* Effect.promise(() => bucket.list());
          expect(listResult.objects.length).toBeGreaterThanOrEqual(1);
          expect(listResult.objects.some((o) => o.key === "hello.txt")).toBe(
            true,
          );
          yield* Effect.logInfo(
            `List returned ${listResult.objects.length} objects`,
          );

          yield* Effect.logInfo("Testing r2 delete...");
          yield* Effect.promise(() => bucket.delete("hello.txt"));
          const afterDelete = yield* Effect.promise(() =>
            bucket.get("hello.txt"),
          );
          expect(afterDelete).toBeNull();
          yield* Effect.logInfo("Delete confirmed - object is gone");

          yield* Effect.logInfo("All R2 tests passed!");
        } finally {
          yield* deleteProxyWorker(scriptName).pipe(Effect.ignore);
          yield* r2Api
            .deleteBucket({ accountId, bucketName: R2_BUCKET_NAME })
            .pipe(Effect.ignore);
        }
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: 30_000 },
  );

  it.live(
    "Queue binding: send via HTTP, receive via WebSocket RPC",
    () =>
      Effect.gen(function* () {
        const accountId = yield* Account;
        const startedAt = new Date();
        const suffix = crypto.randomUUID().slice(0, 8);
        const scriptName = `${PROXY_WORKER_PREFIX}${suffix}`;
        const QUEUE_NAME = `${QUEUE_NAME_PREFIX}${suffix}`;
        yield* registerTelemetryDumpTarget(accountId, scriptName, startedAt);

        yield* Effect.logInfo("Cleaning up orphaned resources...");
        yield* cleanupOrphanedResources(accountId);

        yield* Effect.logInfo(`Creating queue ${QUEUE_NAME}...`);
        const queueResult = yield* queuesApi.createQueue({
          accountId,
          queueName: QUEUE_NAME,
        });
        const queueId = queueResult.queueId!;
        yield* Effect.logInfo(`Queue created: ${queueId}`);

        yield* Effect.logInfo("Deploying worker...");
        const workerUrl = yield* deployProxyWorker(scriptName, [
          {
            type: "queue",
            name: "MY_QUEUE",
            queueName: QUEUE_NAME,
          },
        ]);

        yield* Effect.logInfo(`Registering consumer ${scriptName} on queue...`);
        yield* queuesApi.createConsumer({
          accountId,
          queueId,
          scriptName,
          type: "worker",
          settings: { batchSize: 1, maxWaitTimeMs: 1000 },
        });
        yield* Effect.logInfo("Consumer registered");

        try {
          let resolveReceived: () => void;
          const receivedPromise = new Promise<void>(
            (r) => (resolveReceived = r),
          );
          const received: Array<{ id: string; body: unknown; acked: boolean }> =
            [];

          yield* Effect.logInfo("Connecting WebSocket session...");
          yield* connect(`${workerUrl}/ws`).pipe(
            Effect.provide(
              LocalRpcs.toLayer({
                localPing: () => Effect.succeed({ ts: Date.now() }),
                localEcho: ({ message }) => Effect.succeed({ message }),
                ...makeQueueConsumer(async (batch: QueueBatch) => {
                  for (const msg of batch.messages) {
                    await msg.ack();
                    received.push({
                      id: msg.id,
                      body: msg.body,
                      acked: true,
                    });
                  }
                  resolveReceived!();
                }),
              }),
            ),
            Effect.provide(Socket.layerWebSocketConstructorGlobal),
          );

          yield* Effect.logInfo("Verifying consumer is registered...");
          const consumers = yield* queuesApi
            .listConsumers({ accountId, queueId })
            .pipe(Effect.map((r) => r.result ?? []));
          yield* Effect.logInfo(
            `Consumers: ${JSON.stringify(consumers.map((c) => ({ id: c.consumerId, script: "script" in c ? c.script : undefined })))}`,
          );

          yield* Effect.logInfo("Sending message via worker RPC...");
          const { queue: queueFacade } = yield* makeQueueClient(workerUrl);
          yield* Effect.promise(() =>
            queueFacade("MY_QUEUE").send(
              { hello: "world" },
              { contentType: "json" },
            ),
          );
          yield* Effect.logInfo("Message sent");

          yield* Effect.logInfo("Waiting for delivery...");
          yield* Effect.tryPromise(() => receivedPromise);

          expect(received.length).toBeGreaterThanOrEqual(1);
          const body = received[0].body as Record<string, unknown>;
          expect(body.hello).toBe("world");
          expect(received[0].acked).toBe(true);
          yield* Effect.logInfo("Queue message received and acked!");
        } finally {
          yield* cleanupOrphanedResources(accountId);
        }
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: 300_000 },
  );
});
