import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Response } from "effect/unstable/ai";

const wire = {
  type: "finish" as const,
  reason: "stop" as const,
  usage: {
    inputTokens: { uncached: 44, total: 300, cacheRead: 256, cacheWrite: 0 },
    outputTokens: { total: 38, text: 0, reasoning: 0 },
  },
  "~effect/ai/Content/Part": "~effect/ai/Content/Part" as const,
  metadata: {},
  response: null,
};

const finishPart = Response.FinishPart;
const codecJson = Schema.toCodecJson(finishPart);

const decode = Schema.decodeUnknownEffect(codecJson);
const program = Effect.gen(function* () {
  console.log("--- decoding FinishPart from wire form ---");
  const decoded = yield* decode(wire);
  console.log("decoded ok:", decoded);
});

await Effect.runPromise(
  program.pipe(
    Effect.catchCause((cause) => {
      console.error("decode failed");
      console.error((cause as any).toString?.() ?? cause);
      return Effect.void;
    }),
  ),
);

console.log(
  "\n--- encoding plain object (matches mapUsage caller pattern) ---",
);
const plain: any = JSON.parse(
  JSON.stringify({
    type: "finish",
    reason: "stop",
    usage: {
      inputTokens: { uncached: 44, total: 300, cacheRead: 256, cacheWrite: 0 },
      outputTokens: { total: 38, text: 0, reasoning: 0 },
    },
    response: undefined,
  }),
);
console.log("plain after JSON round-trip (simulates DO → worker hop):", plain);
console.log(
  "\n--- decoding plain (via toCodecJson, simulates worker decode) ---",
);
await Effect.runPromise(
  Schema.decodeUnknownEffect(codecJson)(plain).pipe(
    Effect.tap((v) => Effect.sync(() => console.log("decoded:", v))),
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        console.error(
          "decode plain failed:",
          (cause as any).toString?.() ?? cause,
        ),
      ),
    ),
  ),
);
await Effect.runPromise(
  Schema.encodeUnknownEffect(codecJson)(plain).pipe(
    Effect.tap((v) =>
      Effect.sync(() => console.log("encoded:", JSON.stringify(v))),
    ),
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        console.error(
          "encode plain failed:",
          (cause as any).toString?.() ?? cause,
        ),
      ),
    ),
  ),
);

console.log("\n--- encoding FinishPart (constructed via makePart) ---");
const built = Response.makePart("finish", {
  reason: "stop",
  usage: new Response.Usage({
    inputTokens: { uncached: 44, total: 300, cacheRead: 256, cacheWrite: 0 },
    outputTokens: { total: 38, text: 0, reasoning: 0 },
  }),
  response: undefined,
});
console.log("instance:", built);
await Effect.runPromise(
  Schema.encodeUnknownEffect(codecJson)(built).pipe(
    Effect.tap((v) =>
      Effect.sync(() => console.log("encoded wire form:", JSON.stringify(v))),
    ),
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        console.error("encode failed:", (cause as any).toString?.() ?? cause),
      ),
    ),
  ),
);

const usageOnly = Schema.toCodecJson(Response.Usage);
console.log("\n--- decoding Usage alone ---");
await Effect.runPromise(
  Schema.decodeUnknownEffect(usageOnly)(wire.usage).pipe(
    Effect.tap((v) => Effect.sync(() => console.log("usage decoded:", v))),
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        console.error(
          "usage decode failed:",
          (cause as any).toString?.() ?? cause,
        ),
      ),
    ),
  ),
);
