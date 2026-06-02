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

test.provider("create and delete an unstructured stream", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const stream = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Stream("Events");
      }),
    );

    expect(stream.streamId).toBeDefined();
    expect(stream.streamName).toContain("events");
    expect(stream.http.enabled).toBe(true);
    expect(stream.workerBinding.enabled).toBe(true);

    const observed = yield* pipelines.getStream({
      accountId,
      streamId: stream.streamId,
    });
    expect(observed.id).toBe(stream.streamId);
    expect(observed.name).toBe(stream.streamName);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("patches http auth + workerBinding without replace", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Stream("Events", {
          http: { enabled: true, authentication: false },
          workerBinding: { enabled: true },
        });
      }),
    );

    expect(initial.http.authentication).toBe(false);

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Stream("Events", {
          http: { enabled: true, authentication: true },
          workerBinding: { enabled: false },
        });
      }),
    );

    expect(updated.streamId).toBe(initial.streamId);
    expect(updated.http.authentication).toBe(true);
    expect(updated.workerBinding.enabled).toBe(false);

    const observed = yield* pipelines.getStream({
      accountId,
      streamId: updated.streamId,
    });
    expect(observed.http.authentication).toBe(true);
    expect(observed.workerBinding.enabled).toBe(false);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("schema change triggers replace", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Stream("Events", {
          schema: { user_id: SQL.String },
        });
      }),
    );

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Stream("Events", {
          schema: {
            user_id: SQL.String,
            amount: SQL.Float64,
          },
        });
      }),
    );

    // Schema is immutable, so the stream id must change on replace.
    expect(replaced.streamId).not.toBe(initial.streamId);

    yield* stack.destroy();
  }).pipe(logLevel),
);
