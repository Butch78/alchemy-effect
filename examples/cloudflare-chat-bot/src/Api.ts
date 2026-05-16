import * as Schema from "effect/Schema";
import { Response } from "effect/unstable/ai";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ChatToolkit } from "./Toolkit.ts";

export const ModelOptions = ["kimi", "gpt", "claude"] as const;
export type ModelOption = (typeof ModelOptions)[number];
export const isModelOption = (value: unknown): value is ModelOption =>
  typeof value === "string" &&
  (ModelOptions as readonly string[]).includes(value);

export const Model = Schema.Literals(ModelOptions);

export const ChatMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
});
export type ChatMessage = Schema.Schema.Type<typeof ChatMessage>;

export const MessagesResponse = Schema.Struct({
  messages: Schema.Array(ChatMessage),
});
export type MessagesResponse = Schema.Schema.Type<typeof MessagesResponse>;

export const StreamPart = Response.StreamPart(ChatToolkit);
export type StreamPart = Schema.Schema.Type<typeof StreamPart>;

/**
 * Generic server-side failure. RPC doesn't ship a built-in `InternalError`,
 * so we define one here and use it as the `error` schema for every rpc
 * until we have a reason to distinguish failure modes.
 */
export class InternalError extends Schema.TaggedClass<InternalError>()(
  "InternalError",
  { message: Schema.String },
) {}

/**
 * `sendChat` is a streaming RPC — `success: StreamPart` with `stream: true`
 * makes the client receive a `Stream<StreamPart, InternalError>` directly,
 * with framing handled by `RpcSerialization.layerNdjson` on the wire.
 */
const sendChat = Rpc.make("sendChat", {
  payload: {
    id: Schema.String,
    threadId: Schema.String,
    prompt: Schema.NonEmptyString,
    model: Schema.optional(Model),
  },
  success: StreamPart,
  error: InternalError,
  stream: true,
});

const getMessages = Rpc.make("getMessages", {
  payload: {
    id: Schema.String,
    threadId: Schema.String,
  },
  success: MessagesResponse,
  error: InternalError,
});

const resetThread = Rpc.make("resetThread", {
  payload: {
    id: Schema.String,
    threadId: Schema.String,
  },
  success: MessagesResponse,
  error: InternalError,
});

export class ChatRpcs extends RpcGroup.make(
  sendChat,
  getMessages,
  resetThread,
) {}

/**
 * RPC group exposed by the `ChatAgent` Durable Object itself. Same shape
 * as `ChatRpcs` but without the session `id` — the DO instance *is* the
 * session, so `id` is implicit in which stub you call.
 *
 * Routing the DO behind its own RPC server (via `fetch`) — instead of
 * alchemy's built-in DO RPC bridge — preserves `Schema.Class` identity
 * across the hop because both sides use the same `RpcSerialization`
 * codec instead of raw `JSON.stringify`/`JSON.parse`.
 */
const agentSendChat = Rpc.make("sendChat", {
  payload: {
    threadId: Schema.String,
    prompt: Schema.NonEmptyString,
    model: Schema.optional(Model),
  },
  success: StreamPart,
  error: InternalError,
  stream: true,
});

const agentGetMessages = Rpc.make("getMessages", {
  payload: { threadId: Schema.String },
  success: MessagesResponse,
  error: InternalError,
});

const agentResetThread = Rpc.make("resetThread", {
  payload: { threadId: Schema.String },
  success: MessagesResponse,
  error: InternalError,
});

export class AgentRpcs extends RpcGroup.make(
  agentSendChat,
  agentGetMessages,
  agentResetThread,
) {}
