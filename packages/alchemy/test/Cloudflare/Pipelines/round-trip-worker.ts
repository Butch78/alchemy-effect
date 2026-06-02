import * as Cloudflare from "@/Cloudflare/index.ts";
import * as SQL from "@/Cloudflare/SQL.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * R2 bucket used as the sink target. Declared once at the module level so
 * every yield reuses the same logical id across stack-deploy iterations.
 */
export const Lake = Cloudflare.R2Bucket("Lake");

/**
 * Structured event stream the worker writes to. The schema is what
 * `Stream.bind(...).send(...)` typechecks `records` against in user code.
 */
export const Events = Cloudflare.Stream("Events", {
  schema: {
    user_id: SQL.String,
    amount: SQL.Float64,
  },
});

/**
 * End-to-end test fixture: a Worker that binds the {@link Events} stream
 * via `Cloudflare.Stream.bind(...)`, declares the sink + pipeline siblings
 * inline so the engine pulls in the whole graph, and exposes `POST /send`
 * for the test to produce records.
 */
export default class PipelinesRoundTripWorker extends Cloudflare.Worker<PipelinesRoundTripWorker>()(
  "PipelinesRoundTripWorker",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const events = yield* Events;
    const sink = yield* Cloudflare.Sink("Lakehouse", {
      type: "r2",
      bucket: Lake,
      format: { type: "parquet", compression: "zstd" },
    });
    yield* Cloudflare.Pipeline("Ingest", {
      sql: Cloudflare.pipelineSql`
        INSERT INTO ${sink}
        SELECT user_id, amount FROM ${events}`,
    });

    const send = yield* Cloudflare.Stream.bind(events);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "POST" && url.pathname === "/send") {
          const body = (yield* request.json) as
            | { user_id: string; amount: number }
            | ReadonlyArray<{ user_id: string; amount: number }>;
          const records = Array.isArray(body) ? body : [body];
          yield* send.sendBatch(records).pipe(Effect.orDie);
          return yield* HttpServerResponse.json(
            { sent: records.length },
            { status: 202 },
          );
        }

        if (request.method === "GET" && url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.StreamBindingLive)),
) {}
