import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { RpcClient, RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import type * as Socket from "effect/unstable/socket/Socket";

type FromClientEncoded = RpcMessage.FromClientEncoded;
type FromServerEncoded = RpcMessage.FromServerEncoded;

const FROM_CLIENT_TAGS = new Set([
  "Request",
  "Ack",
  "Interrupt",
  "Ping",
  "Eof",
]);

function isFromClient(msg: { _tag: string }): msg is FromClientEncoded {
  return FROM_CLIENT_TAGS.has(msg._tag);
}

// ---------------------------------------------------------------------------
// Hibernatable WebSocket Protocol (for the Durable Object side)
// ---------------------------------------------------------------------------

export interface HibernatableProtocols {
  readonly serverProtocol: RpcServer.Protocol["Service"];
  readonly clientProtocol: RpcClient.Protocol["Service"];
  readonly serverInbox: Queue.Queue<FromClientEncoded>;
  readonly clientInbox: Queue.Queue<FromServerEncoded>;
  readonly disconnects: Queue.Queue<number>;
}

/**
 * Build RpcServer.Protocol + RpcClient.Protocol for a hibernatable Durable
 * Object WebSocket.
 *
 * The caller pushes messages from `webSocketMessage` into the returned inbox
 * queues via `Queue.offerUnsafe`. The protocols read from those queues and
 * write responses through `ws.send()`.
 */
export const makeHibernatableProtocols = (ws: { send(data: string | Uint8Array): void }) =>
  Effect.gen(function* () {
    const serverInbox = yield* Queue.unbounded<FromClientEncoded>();
    const clientInbox = yield* Queue.unbounded<FromServerEncoded>();
    const disconnects = yield* Queue.unbounded<number>();

    const serialization = RpcSerialization.json;
    const serverParser = serialization.makeUnsafe();
    const clientParser = serialization.makeUnsafe();

    const writeSerialized = (parser: ReturnType<typeof serialization.makeUnsafe>, msg: unknown) => {
      const encoded = parser.encode(msg);
      if (encoded === undefined) return Effect.void;
      return Effect.sync(() => ws.send(encoded));
    };

    const serverProtocol = yield* RpcServer.Protocol.make((onRequest) =>
      Effect.gen(function* () {
        yield* Effect.forever(
          Queue.take(serverInbox).pipe(
            Effect.flatMap((msg) => onRequest(0, msg)),
          ),
        ).pipe(Effect.forkScoped);

        return {
          disconnects,
          send: (_clientId: number, response: FromServerEncoded) =>
            writeSerialized(serverParser, response),
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set([0])),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: false,
        };
      }),
    );

    const clientProtocol = yield* RpcClient.Protocol.make((onResponse) =>
      Effect.gen(function* () {
        yield* Effect.forever(
          Queue.take(clientInbox).pipe(Effect.flatMap(onResponse)),
        ).pipe(Effect.forkScoped);

        return {
          send: (request: FromClientEncoded) =>
            writeSerialized(clientParser, request),
          supportsAck: true,
          supportsTransferables: false,
        };
      }),
    );

    return {
      serverProtocol,
      clientProtocol,
      serverInbox,
      clientInbox,
      disconnects,
    };
  });

/**
 * Route a raw WebSocket message into the correct inbox queue.
 * Called from `webSocketMessage` via `Queue.offerUnsafe`.
 */
export const routeMessage = (
  protos: HibernatableProtocols,
  message: string | ArrayBuffer,
) => {
  const parser = RpcSerialization.json.makeUnsafe();
  const raw = typeof message === "string" ? message : new Uint8Array(message);
  const decoded = parser.decode(raw) as Array<{ _tag: string }>;
  for (const msg of decoded) {
    if (isFromClient(msg)) {
      Queue.offerUnsafe(protos.serverInbox, msg);
    } else {
      Queue.offerUnsafe(protos.clientInbox, msg as FromServerEncoded);
    }
  }
};

// ---------------------------------------------------------------------------
// Multiplexed Socket Protocol (for the local/Bun side)
// ---------------------------------------------------------------------------

export interface MultiplexedProtocols {
  readonly clientProtocol: RpcClient.Protocol["Service"];
  readonly serverProtocol: RpcServer.Protocol["Service"];
}

/**
 * Build multiplexed RpcClient.Protocol + RpcServer.Protocol over a single
 * Effect Socket. A single `socket.runRaw` loop routes incoming messages by
 * `_tag` to the correct protocol inbox.
 */
export const makeMultiplexedProtocols = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const clientInbox = yield* Queue.unbounded<FromServerEncoded>();
    const serverInbox = yield* Queue.unbounded<FromClientEncoded>();
    const disconnects = yield* Queue.unbounded<number>();
    const write = yield* socket.writer;

    const serialization = RpcSerialization.json;
    const recvParser = serialization.makeUnsafe();
    const sendParser = serialization.makeUnsafe();

    yield* socket
      .runRaw((data) => {
        const decoded = recvParser.decode(data) as Array<{ _tag: string }>;
        return Effect.forEach(
          decoded,
          (m) => {
            if (isFromClient(m)) {
              return Queue.offer(serverInbox, m as FromClientEncoded);
            }
            return Queue.offer(clientInbox, m as FromServerEncoded);
          },
          { discard: true },
        );
      })
      .pipe(
        Effect.ensuring(Queue.offer(disconnects, 0)),
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );

    const writeSerialized = (msg: unknown) => {
      const encoded = sendParser.encode(msg);
      if (encoded === undefined) return Effect.void;
      return Effect.orDie(write(encoded));
    };

    const clientProtocol = yield* RpcClient.Protocol.make((onResponse) =>
      Effect.gen(function* () {
        yield* Effect.forever(
          Queue.take(clientInbox).pipe(Effect.flatMap(onResponse)),
        ).pipe(Effect.forkScoped);

        return {
          send: (request: FromClientEncoded) => writeSerialized(request),
          supportsAck: true,
          supportsTransferables: false,
        };
      }),
    );

    const serverProtocol = yield* RpcServer.Protocol.make((onRequest) =>
      Effect.gen(function* () {
        yield* Effect.forever(
          Queue.take(serverInbox).pipe(
            Effect.flatMap((msg) => onRequest(0, msg)),
          ),
        ).pipe(Effect.forkScoped);

        return {
          disconnects,
          send: (_clientId: number, response: FromServerEncoded) =>
            writeSerialized(response),
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set([0])),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: false,
        };
      }),
    );

    return { clientProtocol, serverProtocol };
  });
