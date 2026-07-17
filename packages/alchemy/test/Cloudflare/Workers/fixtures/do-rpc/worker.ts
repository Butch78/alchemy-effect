import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { WorkerEnvironmentKVObject } from "./object.ts";

export default class DurableObjectWorkerEnvironmentWorker extends Cloudflare.Worker<DurableObjectWorkerEnvironmentWorker>()(
  "DurableObjectWorkerEnvironmentWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* WorkerEnvironmentKVObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "POST" && url.pathname === "/roundtrip") {
          const object = objects.getByName("default");
          const key = "durable-object-worker-environment";
          yield* object.put(key, "ok").pipe(Effect.orDie);
          const value = yield* object.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value });
        }

        // Create a DO instance under a `locationHint` and report the colo it
        // actually landed in. The name must be one no request has addressed
        // before: a hint only steers *creation*.
        if (request.method === "GET" && url.pathname === "/colo") {
          const name = url.searchParams.get("name")!;
          const hint = url.searchParams.get(
            "hint",
          ) as Cloudflare.DurableObjectLocationHint | null;
          const object = objects.getByName(
            name,
            hint ? { locationHint: hint } : undefined,
          );
          const colo = yield* object.colo().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ colo });
        }

        // Mirrors the tutorial's `/tick/:n` route verbatim — forwards the
        // Stream returned by the DO's `tick` RPC method straight onto the
        // HTTP response.
        // https://alchemy.run/cloudflare/compute/durable-objects
        if (request.method === "GET" && url.pathname.startsWith("/tick/")) {
          const n = Number(url.pathname.split("/").pop()!);
          const stream = objects
            .getByName("tick")
            .tick(n)
            .pipe(
              Stream.map((i) => `${i}\n`),
              Stream.encodeText,
            );
          return HttpServerResponse.stream(stream, {
            headers: { "content-type": "text/plain" },
          });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}
