import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { ReplacedResourceState, ResourceState } from "./ResourceState.ts";
import { RPC_PATH, StateRpcs } from "./RpcStateApi.ts";
import {
  StateStoreError,
  type PersistedState,
  type StateService,
} from "./State.ts";
import { encodeState, reviveStateRecursive } from "./StateEncoding.ts";

/**
 * Credentials for the RPC-flavoured remote state store. Wire-compatible
 * with the legacy HTTP store credentials so existing on-disk files can
 * be reused as-is — the `url` always points at the worker's root and
 * the RPC handler is mounted at {@link RPC_PATH} internally.
 */
export interface RpcStateStoreCredentials {
  url: string;
  /** Bearer token used to authenticate every request. */
  authToken: string;
}

export interface RpcStateStoreProps extends RpcStateStoreCredentials {
  /**
   * `StateService.id` slug for telemetry. Mirrors the HTTP store's
   * `id` prop so each concrete deployment shows up distinctly on the
   * adoption dashboard.
   */
  id: string;
  transformClient?: (
    client: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest;
}

export const makeRpcStateStore = ({
  url,
  authToken,
  transformClient,
  id,
}: RpcStateStoreProps) =>
  Effect.gen(function* () {
    const protocol = RpcClient.layerProtocolHttp({
      url: `${url}${RPC_PATH}`,
      transformClient: (client) =>
        HttpClient.mapRequest(client, (req) =>
          req.pipe(
            HttpClientRequest.bearerToken(authToken),
            transformClient ?? identity,
          ),
        ),
    }).pipe(Layer.provide(RpcSerialization.layerJson));

    const client = yield* RpcClient.make(StateRpcs).pipe(
      Effect.provide(protocol),
    );

    const service: StateService = {
      id,
      listStacks: () =>
        client.listStacks().pipe(
          Effect.map((stacks) => [...stacks]),
          mapStateStoreError,
        ),
      listStages: (stack) =>
        client.listStages({ stack }).pipe(
          Effect.map((stages) => [...stages]),
          mapStateStoreError,
        ),
      list: (request) =>
        client.listResources(request).pipe(
          Effect.map((fqns) => [...fqns]),
          mapStateStoreError,
        ),
      get: (request) =>
        client.getState(request).pipe(
          Effect.map((s) =>
            s == null ? undefined : (reviveStateRecursive(s) as ResourceState),
          ),
          mapStateStoreError,
        ),
      getReplacedResources: (request) =>
        client.getReplacedResources(request).pipe(
          Effect.map((resources) =>
            resources.map(
              (s) => reviveStateRecursive(s) as ReplacedResourceState,
            ),
          ),
          mapStateStoreError,
        ),
      set: <V extends PersistedState>(request: {
        stack: string;
        stage: string;
        fqn: string;
        value: V;
      }) =>
        client
          .setState({
            stack: request.stack,
            stage: request.stage,
            fqn: request.fqn,
            value: encodeState(request.value),
          })
          .pipe(
            // Server echoes the stored value, but the client already
            // has the canonical object (including any Redacted<T>
            // instances); returning the input avoids a lossy round-trip.
            Effect.map(() => request.value),
            mapStateStoreError,
          ),
      delete: (request) =>
        client.deleteState(request).pipe(Effect.asVoid, mapStateStoreError),
      deleteStack: (request) =>
        client
          .deleteStack({ stack: request.stack, stage: request.stage })
          .pipe(Effect.asVoid, mapStateStoreError),
      getOutput: (request) =>
        client.getStackOutput(request).pipe(
          Effect.map((s) => (s == null ? undefined : reviveStateRecursive(s))),
          mapStateStoreError,
        ),
      setOutput: (request) =>
        client
          .setStackOutput({
            stack: request.stack,
            stage: request.stage,
            value: encodeState(request.value as any),
          })
          .pipe(
            Effect.map(() => request.value),
            mapStateStoreError,
          ),
    };
    return service;
  });

/**
 * Predicate over an `RpcClientError` (or underlying transport error)
 * that returns `true` for failures we expect to clear up on their own.
 * Mirrors {@link HttpStateStore.isTransient}: transport-level errors,
 * 404 / 408 / 429, and every 5xx are retried; everything else surfaces.
 */
const isTransient = (e: any): boolean => {
  const reason = e?.reason ?? e;
  if (reason?._tag === "HttpClientError" || e?._tag === "HttpClientError") {
    const status: number | undefined =
      reason?.response?.status ?? e?.response?.status;
    if (status == null) return true;
    if (status === 404 || status === 408 || status === 429) return true;
    return status >= 500 && status < 600;
  }
  // RpcClientError without an embedded HttpClientError is treated as
  // transient too — the most common shape is a transport-level blip
  // surfaced through the protocol layer.
  if (e?._tag === "RpcClientError") return true;
  return false;
};

const retryTransient = <A, Err, Req>(eff: Effect.Effect<A, Err, Req>) =>
  Effect.retry(eff, {
    while: isTransient,
    schedule: Schedule.exponential(100).pipe(
      Schedule.either(Schedule.spaced("2 seconds")),
      Schedule.both(Schedule.recurs(5)),
    ),
  });

const mapStateStoreError = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    Effect.tapError(Effect.log),
    retryTransient,
    Effect.catch((e: E) =>
      Effect.fail(
        new StateStoreError({
          message: e instanceof Error ? e.message : String(e),
          cause: e instanceof Error ? e : undefined,
        }),
      ),
    ),
  ) as Effect.Effect<A, StateStoreError, R>;
