import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import React from "react";
import ReactDOM from "react-dom/client";
import type { ChatMessage, ModelOption } from "./Agent.ts";
import { ChatRpcs } from "./Api.ts";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

const ClientLayer = Layer.mergeAll(
  RpcClient.layerProtocolHttp({ url: API_URL.replace(/\/+$/, "") }),
  RpcSerialization.layerNdjson,
  FetchHttpClient.layer,
);

const runClient = <A,>(
  build: (client: any) => Effect.Effect<A, unknown, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(ChatRpcs);
        return yield* build(client);
      }).pipe(Effect.provide(ClientLayer)),
    ) as Effect.Effect<A, unknown>,
  );
const SESSION_KEY = "chat-bot:session-id";
const MODEL_KEY = "chat-bot:model";

const MODELS: ReadonlyArray<{ value: ModelOption; label: string }> = [
  { value: "kimi", label: "Kimi K2.6 (Cloudflare)" },
  { value: "gpt", label: "GPT-5.4 Nano (OpenAI)" },
  { value: "claude", label: "Claude Haiku 4.5 (Anthropic)" },
];

const getSessionId = (): string => {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, id);
  return id;
};

const styles = {
  app: {
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    maxWidth: 720,
    margin: "0 auto",
    padding: "24px 16px",
    height: "100dvh",
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
    boxSizing: "border-box" as const,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 8,
    borderBottom: "1px solid #e5e7eb",
  },
  title: { fontSize: 18, fontWeight: 600 },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  modelSelect: {
    border: "1px solid #d1d5db",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 12,
    color: "#374151",
    background: "white",
    cursor: "pointer",
  },
  resetButton: {
    background: "transparent",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
    color: "#374151",
  },
  messages: {
    flex: 1,
    overflowY: "auto" as const,
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
    padding: "12px 0",
  },
  bubble: (role: ChatMessage["role"]): React.CSSProperties => ({
    alignSelf: role === "user" ? "flex-end" : "flex-start",
    background: role === "user" ? "#2563eb" : "#f3f4f6",
    color: role === "user" ? "white" : "#111827",
    padding: "10px 14px",
    borderRadius: 14,
    maxWidth: "80%",
    whiteSpace: "pre-wrap" as const,
    lineHeight: 1.45,
    fontSize: 14,
  }),
  form: {
    display: "flex",
    gap: 8,
    paddingTop: 8,
    borderTop: "1px solid #e5e7eb",
  },
  input: {
    flex: 1,
    padding: "10px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    fontSize: 14,
    fontFamily: "inherit",
  },
  send: {
    padding: "10px 16px",
    border: "none",
    background: "#2563eb",
    color: "white",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
  },
  sendDisabled: { opacity: 0.6, cursor: "not-allowed" },
  thinking: { fontSize: 12, color: "#6b7280", fontStyle: "italic" },
  error: {
    background: "#fef2f2",
    color: "#991b1b",
    padding: "8px 12px",
    borderRadius: 8,
    fontSize: 13,
  },
};

const getStoredModel = (): ModelOption => {
  const stored = localStorage.getItem(MODEL_KEY);
  return MODELS.find((m) => m.value === stored)?.value ?? "kimi";
};

function App() {
  const sessionId = React.useMemo(getSessionId, []);
  const [messages, setMessages] = React.useState<ReadonlyArray<ChatMessage>>(
    [],
  );
  const [model, setModel] = React.useState<ModelOption>(getStoredModel);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    localStorage.setItem(MODEL_KEY, model);
  }, [model]);

  const threadId = "default";

  React.useEffect(() => {
    let cancelled = false;
    runClient<{ messages: ReadonlyArray<ChatMessage> }>((client) =>
      client.getMessages({ id: sessionId, threadId }),
    )
      .then((data) => {
        if (!cancelled) setMessages(data.messages);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, busy]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || busy) return;

    setBusy(true);
    setError(undefined);
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text: prompt }]);

    try {
      let reply = "";
      await runClient((client) =>
        client.sendChat({ id: sessionId, threadId, prompt, model }).pipe(
          Stream.runForEach((part: { type: string; delta?: string }) =>
            Effect.sync(() => {
              if (part.type === "text-delta") {
                reply += part.delta ?? "";
                setMessages((prev) => {
                  const out = prev.slice();
                  const last = out[out.length - 1];
                  if (last && last.role === "assistant") {
                    out[out.length - 1] = { role: "assistant", text: reply };
                  } else {
                    out.push({ role: "assistant", text: reply });
                  }
                  return out;
                });
              }
            }),
          ),
        ),
      );
    } catch (err) {
      setError(String(err));
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await runClient((client) =>
        client.resetThread({ id: sessionId, threadId }),
      );
      setMessages([]);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={styles.app}>
      <header style={styles.header}>
        <span style={styles.title}>Chat Bot</span>
        <div style={styles.headerActions}>
          <select
            style={styles.modelSelect}
            value={model}
            onChange={(e) => setModel(e.target.value as ModelOption)}
            disabled={busy}
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <button type="button" style={styles.resetButton} onClick={reset}>
            New chat
          </button>
        </div>
      </header>

      <div ref={scrollRef} style={styles.messages}>
        {messages.length === 0 && !busy && (
          <div style={styles.thinking}>Say hi to start the conversation.</div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={styles.bubble(msg.role)}>
            {msg.text}
          </div>
        ))}
        {busy && <div style={styles.thinking}>Assistant is thinking…</div>}
        {error && <div style={styles.error}>{error}</div>}
      </div>

      <form style={styles.form} onSubmit={send}>
        <input
          style={styles.input}
          placeholder="Type a message…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <button
          type="submit"
          style={{ ...styles.send, ...(busy ? styles.sendDisabled : {}) }}
          disabled={busy || input.trim().length === 0}
        >
          Send
        </button>
      </form>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
