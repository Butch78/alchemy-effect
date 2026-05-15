import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import crypto from "node:crypto";
import { RPC_PATH, StateRpcs } from "../../State/RpcStateApi.ts";
import * as Secret from "../SecretsStore/Secret.ts";
import { SecretBindingLive } from "../SecretsStore/SecretBinding.ts";
import { Worker } from "../Workers/Worker.ts";
import Store from "./Store.ts";
import { AuthToken } from "./Token.ts";

export const STATE_STORE_SCRIPT_NAME = "alchemy-state-store" as const;

/**
 * Version of the deployed Cloudflare State Store worker contract.
 *
 * Bump this whenever the wire format or runtime behaviour of the
 * worker changes in a way that an older deployed copy can no longer
 * satisfy. Clients query `/version` on the deployed worker and
 * compare against this constant; a mismatch (or 404) triggers a
 * forced redeploy via the bootstrap flow.
 */
export const STATE_STORE_VERSION = 5 as const;

export default Worker(
  "Api",
  {
    name: STATE_STORE_SCRIPT_NAME,
    main: import.meta.filename,
    url: true,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  },
  Effect.gen(function* () {
    const secret = yield* Secret.Secret.bind(AuthToken);
    const store = yield* Store;

    const StateRpcsLive = StateRpcs.toLayer(
      Effect.succeed({
        listStacks: () =>
          store
            .getByName(Store.ROOT_DO_NAME)
            .listStacks()
            .pipe(
              Effect.withSpan("state_store.listStacks", {
                attributes: { "alchemy.state_store.op": "listStacks" },
              }),
            ),
        listStages: ({ stack }) =>
          store
            .getByName(stack)
            .listStages()
            .pipe(
              Effect.withSpan("state_store.listStages", {
                attributes: {
                  "alchemy.state_store.op": "listStages",
                  "alchemy.state_store.stack": stack,
                },
              }),
            ),
        listResources: ({ stack, stage }) =>
          store
            .getByName(stack)
            .listResources({ stage })
            .pipe(
              Effect.withSpan("state_store.listResources", {
                attributes: {
                  "alchemy.state_store.op": "listResources",
                  "alchemy.state_store.stack": stack,
                  "alchemy.state_store.stage": stage,
                },
              }),
            ),
        getState: ({ stack, stage, fqn }) =>
          store
            .getByName(stack)
            .get({ stage, fqn })
            .pipe(
              Effect.withSpan("state_store.getState", {
                attributes: {
                  "alchemy.state_store.op": "getState",
                  "alchemy.state_store.stack": stack,
                  "alchemy.state_store.stage": stage,
                  "alchemy.state_store.fqn": fqn,
                },
              }),
            ),
        setState: ({ stack, stage, fqn, value }) =>
          store
            .getByName(stack)
            .set({ stage, fqn, value: value as any })
            .pipe(
              Effect.tap(() =>
                store.getByName(Store.ROOT_DO_NAME).registerStack({ stack }),
              ),
              Effect.withSpan("state_store.setState", {
                attributes: {
                  "alchemy.state_store.op": "setState",
                  "alchemy.state_store.stack": stack,
                  "alchemy.state_store.stage": stage,
                  "alchemy.state_store.fqn": fqn,
                },
              }),
            ),
        deleteState: ({ stack, stage, fqn }) =>
          // The DO method is `remove`, not `delete` — `delete` is
          // reserved by Cloudflare's RPC stub proxy.
          store
            .getByName(stack)
            .remove({ stage, fqn })
            .pipe(
              Effect.asVoid,
              Effect.withSpan("state_store.deleteState", {
                attributes: {
                  "alchemy.state_store.op": "deleteState",
                  "alchemy.state_store.stack": stack,
                  "alchemy.state_store.stage": stage,
                  "alchemy.state_store.fqn": fqn,
                },
              }),
            ),
        deleteStack: ({ stack, stage }) =>
          store
            .getByName(stack)
            .deleteStack(stage === undefined ? {} : { stage })
            .pipe(
              Effect.flatMap(() =>
                stage === undefined
                  ? store
                      .getByName(Store.ROOT_DO_NAME)
                      .unregisterStack({ stack })
                  : Effect.void,
              ),
              Effect.asVoid,
              Effect.withSpan("state_store.deleteStack", {
                attributes: {
                  "alchemy.state_store.op": "deleteStack",
                  "alchemy.state_store.stack": stack,
                  "alchemy.state_store.stage": stage ?? "",
                  "alchemy.state_store.scope":
                    stage === undefined ? "stack" : "stage",
                },
              }),
            ),
        getReplacedResources: ({ stack, stage }) =>
          store
            .getByName(stack)
            .getReplacedResources({ stage })
            .pipe(
              Effect.withSpan("state_store.getReplacedResources", {
                attributes: {
                  "alchemy.state_store.op": "getReplacedResources",
                  "alchemy.state_store.stack": stack,
                  "alchemy.state_store.stage": stage,
                },
              }),
            ),
        getStackOutput: ({ stack, stage }) =>
          store
            .getByName(stack)
            .getOutput({ stage })
            .pipe(
              Effect.withSpan("state_store.getStackOutput", {
                attributes: {
                  "alchemy.state_store.op": "getStackOutput",
                  "alchemy.state_store.stack": stack,
                  "alchemy.state_store.stage": stage,
                },
              }),
            ),
        setStackOutput: ({ stack, stage, value }) =>
          store
            .getByName(stack)
            .setOutput({ stage, value: value as any })
            .pipe(
              Effect.tap(() =>
                store.getByName(Store.ROOT_DO_NAME).registerStack({ stack }),
              ),
              Effect.withSpan("state_store.setStackOutput", {
                attributes: {
                  "alchemy.state_store.op": "setStackOutput",
                  "alchemy.state_store.stack": stack,
                  "alchemy.state_store.stage": stage,
                },
              }),
            ),
      }),
    );

    const rpcHandler = yield* RpcServer.toHttpEffect(StateRpcs).pipe(
      Effect.provide(StateRpcsLive),
      Effect.provide(RpcSerialization.layerJson),
    );

    return {
      fetch: Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const path = pathnameOf(req.url);

        // Unauthenticated version probe.
        if (path === "/version") {
          return yield* HttpServerResponse.json({
            version: STATE_STORE_VERSION,
          });
        }

        // Bearer-token gate on every other route.
        const expected = yield* secret.get().pipe(Effect.orDie);
        const authHeader = req.headers.authorization ?? "";
        const provided = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        if (!expected || !timingSafeEqual(provided, expected)) {
          return HttpServerResponse.empty({ status: 401 });
        }

        if (path === RPC_PATH) {
          return yield* rpcHandler;
        }

        return HttpServerResponse.empty({ status: 404 });
      }),
    };
  }).pipe(Effect.provide(Layer.mergeAll(SecretBindingLive))),
);

/** Extract the pathname from a request URL that may be relative or absolute. */
const pathnameOf = (url: string): string => {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    const q = url.indexOf("?");
    return q >= 0 ? url.slice(0, q) : url;
  }
};

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
  // @ts-expect-error - TODO(sam)
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
};
