import * as Cloudflare from "alchemy/Cloudflare";
import type { ResourceState } from "alchemy/State";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { STATE_STORE_SCRIPT_NAME } from "alchemy/State";
import StateStore from "./StateStore.ts";
import { AuthToken } from "./Token.ts";

class Unauthorized extends Data.TaggedError("Unauthorized")<{}> {}
class BadRequest extends Data.TaggedError("BadRequest")<{
  readonly message: string;
}> {}

/**
 * Timing-safe string comparison using the Workers runtime's built-in
 * `crypto.subtle.timingSafeEqual`.
 *
 * @see https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
};

const errorResponse = (
  code: string,
  message: string,
  status: number,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> =>
  HttpServerResponse.json(
    { ok: false, error: { code, message } },
    { status },
  ).pipe(Effect.orDie);

const okResponse = (
  result: unknown,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> =>
  HttpServerResponse.json({ ok: true, result: result ?? null }).pipe(
    Effect.orDie,
  );

const requireString = (
  body: Record<string, unknown>,
  field: string,
): Effect.Effect<string, BadRequest> => {
  const value = body[field];
  return typeof value === "string" && value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(
        new BadRequest({
          message: `field '${field}' is required and must be a non-empty string`,
        }),
      );
};

const requireObject = (
  body: Record<string, unknown>,
  field: string,
): Effect.Effect<ResourceState, BadRequest> => {
  const value = body[field];
  return value && typeof value === "object" && !Array.isArray(value)
    ? Effect.succeed(value as ResourceState)
    : Effect.fail(
        new BadRequest({
          message: `field '${field}' is required and must be an object`,
        }),
      );
};

/**
 * Parse the JSON body of the current request, normalising errors to
 * `BadRequest`. Reads `HttpServerRequest` from the Effect context.
 */
const parseBody: Effect.Effect<
  Record<string, unknown>,
  BadRequest,
  HttpServerRequest
> = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const text = yield* request.text.pipe(Effect.orDie);
  return yield* Effect.try({
    try: () => {
      const body = text ? JSON.parse(text) : {};
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("expected JSON object body");
      }
      return body as Record<string, unknown>;
    },
    catch: (e) =>
      new BadRequest({
        message: e instanceof Error ? e.message : "invalid JSON body",
      }),
  });
});

/** Read `:project` from the matched route path. */
const getProject = HttpRouter.params.pipe(
  Effect.map((params) => decodeURIComponent(params.project ?? "")),
);

/**
 * Wrap a handler so its tagged errors map to structured JSON
 * responses and any defect (e.g. from `Effect.orDie`ed DO calls)
 * returns a JSON 500 instead of Cloudflare's default plain-text error
 * page.
 *
 * Handlers declare their failure modes as `Unauthorized | BadRequest`
 * so `catchTag` can pattern-match concretely.
 */
const wrap = <R>(
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Unauthorized | BadRequest,
    R
  >,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  handler.pipe(
    Effect.catchTag("Unauthorized", () =>
      errorResponse("unauthorized", "invalid bearer token", 401),
    ),
    Effect.catchTag("BadRequest", (e) =>
      errorResponse("bad_request", e.message, 400),
    ),
    Effect.catchCause((cause) => errorResponse("internal", String(cause), 500)),
  );

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    name: STATE_STORE_SCRIPT_NAME,
    main: import.meta.path,
    url: true,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  },
  Effect.gen(function* () {
    const secret = yield* Cloudflare.Secret.bind(AuthToken);
    const stateStore = yield* StateStore;

    let cachedToken: string | undefined;

    const authenticate = Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const authHeader = request.headers.authorization ?? "";
      const prefix = "Bearer ";
      if (!authHeader.startsWith(prefix)) {
        return yield* Effect.fail(new Unauthorized());
      }
      const presented = authHeader.slice(prefix.length).trim();
      if (cachedToken === undefined) {
        cachedToken = yield* secret
          .get()
          .pipe(
            Effect.catchTag("SecretError", () =>
              Effect.fail(new Unauthorized()),
            ),
          );
      }
      if (!cachedToken || !timingSafeEqual(presented, cachedToken)) {
        return yield* Effect.fail(new Unauthorized());
      }
    });

    const routes = Layer.mergeAll(
      HttpRouter.add(
        "POST",
        "/projects/:project/state/listStacks",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const project = yield* getProject;
            const result = yield* stateStore
              .getByName(project)
              .listStacks()
              .pipe(Effect.orDie);
            return yield* okResponse(result);
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/projects/:project/state/listStages",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const project = yield* getProject;
            const body = yield* parseBody;
            const stack = yield* requireString(body, "stack");
            const result = yield* stateStore
              .getByName(project)
              .listStages({ stack })
              .pipe(Effect.orDie);
            return yield* okResponse(result);
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/projects/:project/state/list",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const project = yield* getProject;
            const body = yield* parseBody;
            const stack = yield* requireString(body, "stack");
            const stage = yield* requireString(body, "stage");
            const result = yield* stateStore
              .getByName(project)
              .list({ stack, stage })
              .pipe(Effect.orDie);
            return yield* okResponse(result);
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/projects/:project/state/get",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const project = yield* getProject;
            const body = yield* parseBody;
            const stack = yield* requireString(body, "stack");
            const stage = yield* requireString(body, "stage");
            const fqn = yield* requireString(body, "fqn");
            const result = yield* stateStore
              .getByName(project)
              .get({ stack, stage, fqn })
              .pipe(Effect.orDie);
            return yield* okResponse(result);
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/projects/:project/state/set",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const project = yield* getProject;
            const body = yield* parseBody;
            const stack = yield* requireString(body, "stack");
            const stage = yield* requireString(body, "stage");
            const fqn = yield* requireString(body, "fqn");
            const value = yield* requireObject(body, "value");
            const result = yield* stateStore
              .getByName(project)
              .set({ stack, stage, fqn, value })
              .pipe(Effect.orDie);
            return yield* okResponse(result);
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/projects/:project/state/delete",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const project = yield* getProject;
            const body = yield* parseBody;
            const stack = yield* requireString(body, "stack");
            const stage = yield* requireString(body, "stage");
            const fqn = yield* requireString(body, "fqn");
            // The DO method is `remove`, not `delete` — `delete` is
            // reserved by Cloudflare's RPC stub proxy.
            yield* stateStore
              .getByName(project)
              .remove({ stack, stage, fqn })
              .pipe(Effect.orDie);
            return yield* okResponse(null);
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/projects/:project/state/getReplacedResources",
        wrap(
          Effect.gen(function* () {
            yield* authenticate;
            const project = yield* getProject;
            const body = yield* parseBody;
            const stack = yield* requireString(body, "stack");
            const stage = yield* requireString(body, "stage");
            const result = yield* stateStore
              .getByName(project)
              .getReplacedResources({ stack, stage })
              .pipe(Effect.orDie);
            return yield* okResponse(result);
          }),
        ),
      ),
    ).pipe(Layer.provideMerge(HttpRouter.layer));

    const fetch = yield* HttpRouter.toHttpEffect(routes);

    return {
      // Any error from unmatched routes (`HttpServerError`) or a
      // leaked defect collapses to a JSON 500 instead of Cloudflare's
      // default plain-text 500 page.
      fetch: fetch.pipe(
        Effect.catchCause((cause) =>
          errorResponse("internal", String(cause), 500),
        ),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.SecretBindingLive))),
) {}
