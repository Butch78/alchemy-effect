import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as SQL from "@/Cloudflare/SQL";
import * as Test from "@/Test/Vitest";
import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "stream + r2 sink + pipeline smoke test",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Cloudflare.R2Bucket("Lake");

          const events = yield* Cloudflare.Stream("Events", {
            schema: {
              user_id: SQL.String,
              amount: SQL.Float64,
            },
          });

          const sink = yield* Cloudflare.Sink("Lakehouse", {
            type: "r2",
            bucket,
            format: { type: "parquet", compression: "zstd" },
          });

          const pipeline = yield* Cloudflare.Pipeline("Ingest", {
            sql: Cloudflare.pipelineSql`
              INSERT INTO ${sink}
              SELECT user_id, amount FROM ${events}`,
          });

          return { bucket, events, sink, pipeline };
        }),
      );

      expect(result.events.streamId).toBeDefined();
      expect(result.sink.sinkId).toBeDefined();
      expect(result.sink.sinkType).toBe("r2");
      expect(result.pipeline.pipelineId).toBeDefined();
      // Pipeline.sql is the rendered, interpolated SQL.
      expect(result.pipeline.sql).toContain(result.sink.sinkName);
      expect(result.pipeline.sql).toContain(result.events.streamName);

      const observed = yield* pipelines.getV1Pipeline({
        accountId,
        pipelineId: result.pipeline.pipelineId,
      });
      expect(observed.id).toBe(result.pipeline.pipelineId);
      const tableNames = observed.tables.map((t) => t.name);
      expect(tableNames).toContain(result.events.streamName);
      expect(tableNames).toContain(result.sink.sinkName);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "sql change replaces the pipeline",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Cloudflare.R2Bucket("Lake");
          const events = yield* Cloudflare.Stream("Events");
          const sink = yield* Cloudflare.Sink("Lakehouse", {
            type: "r2",
            bucket,
          });
          const pipeline = yield* Cloudflare.Pipeline("Ingest", {
            sql: Cloudflare.pipelineSql`INSERT INTO ${sink} SELECT * FROM ${events}`,
          });
          return { pipeline };
        }),
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Cloudflare.R2Bucket("Lake");
          const events = yield* Cloudflare.Stream("Events");
          const sink = yield* Cloudflare.Sink("Lakehouse", {
            type: "r2",
            bucket,
          });
          const pipeline = yield* Cloudflare.Pipeline("Ingest", {
            sql: Cloudflare.pipelineSql`
              INSERT INTO ${sink} SELECT * FROM ${events} WHERE user_id IS NOT NULL`,
          });
          return { pipeline };
        }),
      );

      expect(replaced.pipeline.pipelineId).not.toBe(
        initial.pipeline.pipelineId,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
