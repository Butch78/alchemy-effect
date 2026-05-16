import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { Chat, Prompt } from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { BackingPersistence } from "effect/unstable/persistence/Persistence";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import {
  AgentRpcs,
  ChatMessage,
  InternalError,
  type ModelOption,
} from "./Api.ts";
import { ChatToolkit, ChatToolkitLayer, SYSTEM_PROMPT } from "./Toolkit.ts";

export { ChatMessage, isModelOption, ModelOptions } from "./Api.ts";
export type { ModelOption } from "./Api.ts";

export const Gateway = Cloudflare.AiGateway("Gateway", {
  cacheTtl: 60,
  collectLogs: true,
});

/**
 * A Durable Object that owns one persisted chat session per DO instance.
 *
 * The DO's surface is the typed {@link AgentRpcs} group, served over its
 * own `fetch` handler by `Cloudflare.RpcDurableObjectNamespace` and the
 * shared `RpcSerialization.layerNdjson` codec. Consumers see
 * `agents.getByName(id)` as a typed `RpcClient<AgentRpcs>` directly —
 * no manual `bindEffectRpc` glue.
 */
export default class ChatAgent extends Cloudflare.RpcDurableObjectNamespace<ChatAgent>()(
  "ChatAgent",
  { schema: AgentRpcs },
  Effect.gen(function* () {
    const ai = yield* Cloudflare.AiGateway.bind(Gateway);

    const anthropicKey = yield* Alchemy.Secret("ANTHROPIC_API_KEY");

    const openAiKey = yield* Alchemy.Secret("OPENAI_API_KEY");

    const gpt = Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* openAiKey;
        return OpenAiLanguageModel.layer({
          model: "gpt-5.4-nano",
          config: { temperature: 0.3 },
        }).pipe(
          Layer.provide(OpenAiClient.layer({ apiKey })),
          Layer.provide(FetchHttpClient.layer),
        );
      }),
    );

    const kimi = ai.model({
      client: ai,
      model: "@cf/moonshotai/kimi-k2.6",
      parameters: { temperature: 0.3, maxTokens: 1024 },
    });

    const claude = Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* anthropicKey;
        return AnthropicLanguageModel.layer({
          model: "claude-haiku-4-5",
          config: { max_tokens: 1024, temperature: 0.3 },
        }).pipe(
          Layer.provide(AnthropicClient.layer({ apiKey })),
          Layer.provide(FetchHttpClient.layer),
        );
      }),
    );

    const modelLayer = (option: ModelOption) => {
      switch (option) {
        case "kimi":
          return kimi;
        case "gpt":
          return gpt;
        case "claude":
          return claude;
      }
    };

    return Effect.gen(function* () {
      const persistence = yield* Chat.Persistence;
      const backing = yield* BackingPersistence;
      const store = yield* backing.make("chat");
      const env = yield* Cloudflare.WorkerEnvironment;

      const handlersLayer = AgentRpcs.toLayer({
        sendChat: ({ threadId, prompt, model }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const chat = yield* persistence.getOrCreate(threadId);
              const history = yield* Ref.get(chat.history);
              if (history.content.length === 0) {
                yield* Ref.update(chat.history, (h) => ({
                  ...h,
                  content: [
                    Prompt.makeMessage("system", { content: SYSTEM_PROMPT }),
                    ...h.content,
                  ],
                }));
              }
              return chat
                .streamText({ prompt, toolkit: ChatToolkit })
                .pipe(
                  Stream.provide(
                    Layer.mergeAll(
                      modelLayer(model ?? "kimi"),
                      ChatToolkitLayer,
                    ).pipe(
                      Layer.provide(
                        Layer.succeed(Cloudflare.WorkerEnvironment, env),
                      ),
                    ),
                  ),
                  streamToInternalError("ChatAgent.sendChat"),
                );
            }).pipe(toInternalError("ChatAgent.sendChat (init)")),
          ),
        getMessages: ({ threadId }) =>
          Effect.gen(function* () {
            const chat = yield* persistence.getOrCreate(threadId);
            const history = yield* Ref.get(chat.history);
            return { messages: exportMessages(history) };
          }).pipe(toInternalError("ChatAgent.getMessages")),
        resetThread: ({ threadId }) =>
          store
            .remove(threadId)
            .pipe(
              Effect.as({ messages: [] as ReadonlyArray<ChatMessage> }),
              toInternalError("ChatAgent.resetThread"),
            ),
      });

      return RpcServer.toHttpEffect(AgentRpcs).pipe(
        Effect.provide(handlersLayer),
        Effect.provide(RpcSerialization.layerNdjson),
      );
    }).pipe(
      Effect.provide(
        Chat.layerPersisted({ storeId: "chat" }).pipe(
          Layer.provideMerge(Cloudflare.DurableObjectChatPersistence),
        ),
      ),
      Effect.orDie,
    );
  }),
) {}

const collectText = (
  parts: ReadonlyArray<Prompt.UserMessagePart | Prompt.AssistantMessagePart>,
): string => {
  let out = "";
  for (const part of parts) {
    if (part.type === "text") out += part.text;
  }
  return out;
};

const exportMessages = (history: Prompt.Prompt): ReadonlyArray<ChatMessage> => {
  const out: Array<ChatMessage> = [];
  for (const msg of history.content) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = messageText(msg);
    if (text.length === 0) continue;
    out.push({ role: msg.role, text });
  }
  return out;
};

const messageText = (msg: Prompt.Message): string => {
  switch (msg.role) {
    case "user":
    case "assistant":
      return collectText(msg.content);
    default:
      return "";
  }
};

const toInternalError =
  (label: string) =>
  <A, R>(
    effect: Effect.Effect<A, unknown, R>,
  ): Effect.Effect<A, InternalError, R> =>
    Effect.catchCause(effect, (cause) =>
      Effect.logError(`${label} failed`, cause).pipe(
        Effect.andThen(
          Effect.fail(new InternalError({ message: Cause.pretty(cause) })),
        ),
      ),
    );

const streamToInternalError =
  (label: string) =>
  <A, R>(
    stream: Stream.Stream<A, unknown, R>,
  ): Stream.Stream<A, InternalError, R> =>
    stream.pipe(
      Stream.catchCause((cause) =>
        Effect.logError(`${label} stream failed`, cause).pipe(
          Effect.andThen(
            Effect.fail(new InternalError({ message: Cause.pretty(cause) })),
          ),
          Stream.fromEffect,
        ),
      ),
    );
