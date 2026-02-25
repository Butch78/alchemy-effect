import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import {
  type HttpServerResponse,
  text,
} from "effect/unstable/http/HttpServerResponse";

export const serve = Effect.fn(function* (
  handler: Effect.Effect<
    HttpServerResponse,
    HttpServerError,
    HttpServerRequest | Scope
  >,
) {
  const eff = handler.pipe(
    Effect.catch((error) =>
      Effect.succeed(
        text(`Error: ${error.message}`, {
          status: 500,
        }),
      ),
    ),
  );
});
