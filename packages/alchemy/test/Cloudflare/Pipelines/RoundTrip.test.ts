import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import PipelinesRoundTripWorker, { Events } from "./round-trip-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * End-to-end Pipelines round-trip via a deployed Cloudflare Worker.
 *
 * Stack (defined in {@link "./round-trip-worker.ts"}):
 *
 * - `Lake` — `Cloudflare.R2Bucket`.
 * - `Events` — `Cloudflare.Stream` with an `effect/Schema` struct.
 * - `Lakehouse` — `Cloudflare.Sink` (R2) with auto-provisioned credentials.
 * - `Ingest` — `Cloudflare.Pipeline` wiring Events → Lakehouse via SQL.
 * - `PipelinesRoundTripWorker` — binds `Events` via `Stream.bind(...)` and
 *   exposes `POST /send` so the test can produce records, plus
 *   `GET /health` so we can confirm the worker came up.
 *
 * The test deploys, then redeploys without changes to prove the create →
 * update path is idempotent for every resource in the graph, then exercises
 * the producer binding via HTTP and confirms the live stream survives.
 */
test.provider(
  "deploy → redeploy → send via Stream.bind → tear down",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      // First deploy — brings up R2, Stream, Sink (+ auto AccountApiToken),
      // Pipeline, and the Worker.
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* PipelinesRoundTripWorker;
          const events = yield* Events;
          return {
            url: worker.url,
            streamId: events.streamId,
            streamName: events.streamName,
          };
        }),
      );

      expect(first.url).toBeTypeOf("string");
      expect(first.streamId).toBeTypeOf("string");

      // Second deploy with the same inputs — every resource should
      // converge to a no-op (or in-place update), and ids must stay the
      // same. This is the create/update side of the matrix.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* PipelinesRoundTripWorker;
          const events = yield* Events;
          return {
            url: worker.url,
            streamId: events.streamId,
          };
        }),
      );

      expect(second.url).toEqual(first.url);
      expect(second.streamId).toEqual(first.streamId);

      // Confirm the live stream actually exists in Cloudflare.
      const observedStream = yield* pipelines.getStream({
        accountId,
        streamId: first.streamId,
      });
      expect(observedStream.id).toEqual(first.streamId);
      expect(observedStream.workerBinding.enabled).toBe(true);
      expect(observedStream.name).toEqual(first.streamName);

      // Locate the pipeline by stream and confirm its `tables` list
      // resolves the stream + sink ends.
      const pipelineList = yield* pipelines.listV1Pipeline({ accountId });
      const ingest = pipelineList.result.find((p) =>
        p.sql.includes(first.streamName!),
      );
      expect(ingest).toBeDefined();
      const observedPipeline = yield* pipelines.getV1Pipeline({
        accountId,
        pipelineId: ingest!.id,
      });
      const tableNames = observedPipeline.tables.map((t) => t.name);
      expect(tableNames).toContain(first.streamName);

      // Drive the runtime path: produce a few records via the deployed
      // worker's Stream binding. The first call is retried while
      // workers.dev propagates the new URL.
      const baseUrl = first.url as string;
      const records = [
        { user_id: "alpha", amount: 11.5 },
        { user_id: "beta", amount: 42 },
        { user_id: "gamma", amount: 1234.56 },
      ];
      const sendResponse = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/send`).pipe(
          HttpClientRequest.bodyJsonUnsafe(records),
        ),
      ).pipe(
        Effect.flatMap((res) =>
          res.status === 202
            ? Effect.succeed(res)
            : Effect.fail(new Error(`Worker /send not ready: ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.exponential("500 millis").pipe(
            Schedule.both(Schedule.recurs(20)),
          ),
        }),
      );
      const body = (yield* sendResponse.json) as { sent: number };
      expect(body.sent).toBe(records.length);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 360_000 },
);
