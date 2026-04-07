/**
 * Cloudflare Worker + Durable Object that acts as the remote side of the
 * bi-directional RPC bridge. This file is bundled with rolldown and deployed
 * via putScript.
 *
 * The worker routes incoming requests to a Session Durable Object which holds
 * a hibernatable WebSocket and runs Effect RPC over it.
 */

import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { RpcClient, RpcServer } from "effect/unstable/rpc";
import {
  type HibernatableProtocols,
  makeHibernatableProtocols,
  routeMessage,
} from "./rpc-protocol.ts";
import { LocalRpcs, RemoteRpcs } from "./rpc-schema.ts";

interface Env {
  SESSION: DurableObjectNamespace<Session>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const id = env.SESSION.idFromName("default");
      const stub = env.SESSION.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (url.pathname === "/test-call-local") {
      const id = env.SESSION.idFromName("default");
      const stub = env.SESSION.get(id);
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};

export class Session extends DurableObject<Env> {
  private protocols: HibernatableProtocols | null = null;
  private fiber: Fiber.Fiber<any> | null = null;
  // biome-ignore lint: complex inferred type
  private localClient: any = null;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/test-call-local") {
      if (!this.localClient) {
        return new Response("No active session", { status: 503 });
      }
      try {
        const pingResult = await Effect.runPromise(
          this.localClient.localPing(),
        );
        const echoResult = await Effect.runPromise(
          this.localClient.localEcho({ message: "hello from remote" }),
        );
        return new Response(
          JSON.stringify({ ping: pingResult, echo: echoResult }),
          { headers: { "content-type": "application/json" } },
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  private async ensureRuntime(ws: WebSocket) {
    if (this.protocols) return;

    const self = this;

    const rpcProgram = Effect.gen(function* () {
      const protos = yield* makeHibernatableProtocols(ws);
      self.protocols = protos;

      yield* RpcServer.make(RemoteRpcs).pipe(
        Effect.provideService(RpcServer.Protocol, protos.serverProtocol),
        Effect.provide(
          RemoteRpcs.toLayer({
            remotePing: () => Effect.succeed({ ts: Date.now() }),
            remoteEcho: ({ message }) => Effect.succeed({ message }),
          }),
        ),
        Effect.forkScoped,
      );

      self.localClient = yield* RpcClient.make(LocalRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protos.clientProtocol),
      );

      yield* Effect.never;
    }).pipe(Effect.scoped);

    this.fiber = Effect.runFork(rpcProgram);

    // Wait for the protocols to be initialized before returning
    while (!this.protocols) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private teardown() {
    if (this.fiber) {
      this.ctx.waitUntil(Effect.runPromise(Fiber.interrupt(this.fiber)));
      this.fiber = null;
      this.protocols = null;
      this.localClient = null;
    }
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.ensureRuntime(ws);
    routeMessage(this.protocols!, message);
  }

  override webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    this.teardown();
    ws.close(code, "session closed");
  }

  override webSocketError(ws: WebSocket, _error: unknown): void {
    this.teardown();
    ws.close(1011, "unexpected error");
  }
}
