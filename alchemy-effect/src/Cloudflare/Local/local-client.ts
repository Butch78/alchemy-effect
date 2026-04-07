/**
 * Local-side client that connects to the proxy worker's Durable Object via
 * WebSocket and runs bi-directional Effect RPC.
 *
 * - RpcClient for RemoteRpcs (call the remote DO)
 * - RpcServer for LocalRpcs  (serve calls from the remote DO)
 */

import * as Effect from "effect/Effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import { makeMultiplexedProtocols } from "./rpc-protocol.ts";
import { LocalRpcs, RemoteRpcs } from "./rpc-schema.ts";

export type LocalSession = Effect.Success<ReturnType<typeof connect>>;

/**
 * Connect to the proxy worker's DO via WebSocket and set up bi-directional
 * RPC. Returns a typed client for calling remote RPCs.
 *
 * The caller must provide LocalRpcs handlers via the layer context and a
 * WebSocketConstructor for creating the WebSocket connection.
 */
export const connect = (url: string) =>
  Effect.gen(function* () {
    const wsUrl = url.replace(/^http/, "ws");
    const socket = yield* Socket.makeWebSocket(wsUrl);
    const { clientProtocol, serverProtocol } =
      yield* makeMultiplexedProtocols(socket);

    const remoteClient = yield* RpcClient.make(RemoteRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, clientProtocol),
    );

    yield* RpcServer.make(LocalRpcs).pipe(
      Effect.provideService(RpcServer.Protocol, serverProtocol),
      Effect.forkScoped,
    );

    return { remoteClient };
  });
