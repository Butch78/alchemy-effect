import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import Stack from "../alchemy.run.ts";
import { ChatRpcs } from "../src/Api.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const sessionId = `integ-${Math.random().toString(36).slice(2, 10)}`;
const threadId = "integ-thread";

const makeClient = (apiUrl: string) =>
  RpcClient.make(ChatRpcs).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: apiUrl.replace(/\/+$/, "") }),
    ),
    Effect.provide(RpcSerialization.layerNdjson),
    Effect.provide(FetchHttpClient.layer),
  );

test(
  "stack exposes the deployed worker + website urls",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.apiUrl).toBeString();
    expect(out.websiteUrl).toBeString();
    expect(out.apiUrl.startsWith("http")).toBe(true);
  }),
);

test(
  "getMessages rpc roundtrip works",
  Effect.gen(function* () {
    const { apiUrl } = yield* stack;
    const client = yield* makeClient(apiUrl);
    const res = yield* client
      .getMessages({ id: sessionId, threadId })
      .pipe(
        Effect.timeout("30 seconds"),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 5 }),
      );
    expect(Array.isArray(res.messages)).toBe(true);
  }),
  { timeout: 90_000 },
);

test(
  "chat streams typed parts and persists history",
  Effect.gen(function* () {
    const { apiUrl } = yield* stack;
    const client = yield* makeClient(apiUrl);

    const parts = yield* client
      .sendChat({
        id: sessionId,
        threadId,
        prompt: "Reply with the single word 'pong'.",
        model: "kimi",
      })
      .pipe(Stream.runCollect);
    expect(parts.length).toBeGreaterThan(0);
    const finish = parts.find((p) => p.type === "finish");
    expect(finish).toBeDefined();
    const reply = parts
      .filter(
        (p): p is Extract<typeof p, { type: "text-delta" }> =>
          p.type === "text-delta",
      )
      .map((p) => p.delta)
      .join("");
    expect(reply.length).toBeGreaterThan(0);

    const after = yield* client.getMessages({ id: sessionId, threadId });
    expect(after.messages.length).toBeGreaterThanOrEqual(2);
    expect(after.messages[after.messages.length - 1].role).toBe("assistant");

    const reset = yield* client.resetThread({ id: sessionId, threadId });
    expect(reset.messages).toEqual([]);

    const cleared = yield* client.getMessages({ id: sessionId, threadId });
    expect(cleared.messages).toEqual([]);
  }),
  { timeout: 180_000 },
);

test(
  "empty prompt is rejected by schema validation",
  Effect.gen(function* () {
    const { apiUrl } = yield* stack;
    const client = yield* makeClient(apiUrl);

    const exit = yield* Effect.suspend(() =>
      client
        .sendChat({ id: sessionId, threadId, prompt: "" })
        .pipe(Stream.runCollect),
    ).pipe(Effect.exit);
    expect(exit._tag).toBe("Failure");
  }),
  { timeout: 30_000 },
);
