import cloudflarePlugin from "@distilled.cloud/cloudflare-rolldown-plugin";
import * as cf from "@distilled.cloud/cloudflare";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodePath from "node:path";
import * as Bundle from "@/Bundle/Bundle";
import { Account, fromEnv as accountFromEnv } from "@/Cloudflare/Account";
import { connect } from "@/Cloudflare/Local/local-client";
import { LocalRpcs } from "@/Cloudflare/Local/rpc-schema";

const PROXY_WORKER_ENTRY = NodePath.resolve(
  import.meta.dirname,
  "../../../src/Cloudflare/Local/proxy-worker.ts",
);

const SCRIPT_NAME = "alchemy-local-rpc-test";

const credentials = Layer.mergeAll(cf.CredentialsFromEnv, FetchHttpClient.layer);
const platform = NodeServices.layer;

const configProviderLayer = Layer.effect(
  ConfigProvider.ConfigProvider,
  Effect.map(
    ConfigProvider.fromDotEnv({ path: ".env" }),
    (dotEnv) => ConfigProvider.orElse(dotEnv, ConfigProvider.fromEnv()),
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

const deployProxyWorker = Effect.gen(function* () {
  const accountId = yield* Account;
  const putScript = yield* workers.putScript;
  const createSubdomain = yield* workers.createScriptSubdomain;
  const getSubdomain = yield* workers.getSubdomain;

  yield* Effect.logInfo("Bundling proxy worker...");
  const bundle = yield* bundleProxyWorker;
  yield* Effect.logInfo(
    `Bundled ${bundle.files.length} files, main: ${bundle.mainModule}`,
  );

  yield* Effect.logInfo(`Deploying proxy worker as ${SCRIPT_NAME}...`);
  yield* putScript({
    accountId,
    scriptName: SCRIPT_NAME,
    metadata: {
      mainModule: bundle.mainModule,
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      bindings: [
        {
          type: "durable_object_namespace",
          name: "SESSION",
          className: "Session",
        },
      ],
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
    },
    files: bundle.files,
  });

  yield* createSubdomain({ accountId, scriptName: SCRIPT_NAME, enabled: true });
  const { subdomain } = yield* getSubdomain({ accountId });
  const workerUrl = `https://${SCRIPT_NAME}.${subdomain}.workers.dev`;

  yield* Effect.logInfo(`Proxy worker deployed at ${workerUrl}`);

  // Wait for the worker to be reachable
  yield* Effect.logInfo("Waiting for worker to be reachable...");
  yield* Effect.retry(
    Effect.tryPromise(async () => {
      const res = await fetch(`${workerUrl}/health`);
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    }),
    Schedule.exponential("500 millis").pipe(
      Schedule.compose(Schedule.recurs(20)),
    ),
  );
  yield* Effect.logInfo("Worker is reachable");

  return workerUrl;
});

const deleteProxyWorker = Effect.gen(function* () {
  const accountId = yield* Account;
  const deleteScript = yield* workers.deleteScript;
  yield* deleteScript({ accountId, scriptName: SCRIPT_NAME }).pipe(
    Effect.catchTag("WorkerNotFound", () => Effect.void),
  );
  yield* Effect.logInfo("Proxy worker deleted");
});

describe("Cloudflare Local RPC", () => {
  it.live(
    "bi-directional RPC over WebSocket",
    () =>
      Effect.gen(function* () {
        // Clean up any leftover from a previous run
        yield* deleteProxyWorker.pipe(Effect.ignore);

        const workerUrl = yield* deployProxyWorker;

        try {
          // Connect to the DO via WebSocket
          const wsUrl = `${workerUrl}/ws`;
          yield* Effect.logInfo(`Connecting to ${wsUrl}...`);

          const { remoteClient } = yield* connect(wsUrl).pipe(
            Effect.provide(
              LocalRpcs.toLayer({
                localPing: () => Effect.succeed({ ts: Date.now() }),
                localEcho: ({ message }) => Effect.succeed({ message }),
              }),
            ),
            Effect.provide(Socket.layerWebSocketConstructorGlobal),
          );

          // --- Test local -> remote RPC ---
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

          // --- Test remote -> local RPC ---
          yield* Effect.logInfo(
            "Testing remote -> local via /test-call-local...",
          );
          yield* Effect.sleep("1 second");

          const callLocalResult = yield* Effect.tryPromise(async () => {
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
          });

          expect(callLocalResult.ping.ts).toBeTypeOf("number");
          expect(callLocalResult.ping.ts).toBeGreaterThan(0);
          expect(callLocalResult.echo.message).toBe("hello from remote");
          yield* Effect.logInfo(
            `remote->local ping.ts=${callLocalResult.ping.ts}, echo="${callLocalResult.echo.message}"`,
          );

          yield* Effect.logInfo("All RPC tests passed!");
        } finally {
          yield* deleteProxyWorker.pipe(Effect.ignore);
        }
      }).pipe(Effect.scoped, Effect.provide(layers)),
    { timeout: 120_000 },
  );
});
