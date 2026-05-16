import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

const GetCurrentTime = Tool.make("get_current_time", {
  description:
    "Returns the current server-side wall-clock time. Call this whenever the user asks about the current time, date, or day.",
  success: Schema.Struct({
    iso: Schema.String,
    unixMs: Schema.Number,
  }),
});

const Calculate = Tool.make("calculate", {
  description:
    "Evaluates a basic arithmetic expression over numbers. Supported operators: + - * / and parentheses. Use this for any math the user asks for.",
  parameters: Schema.Struct({
    expression: Schema.String,
  }),
  success: Schema.Struct({
    expression: Schema.String,
    result: Schema.Number,
    error: Schema.optional(Schema.String),
  }),
});

const RollDice = Tool.make("roll_dice", {
  description:
    'Rolls one or more N-sided dice and returns each roll plus the total. Use this when the user asks to roll dice (e.g. "roll 2d6").',
  parameters: Schema.Struct({
    sides: Schema.Number,
    count: Schema.Number,
  }),
  success: Schema.Struct({
    rolls: Schema.Array(Schema.Number),
    total: Schema.Number,
  }),
});

export const ChatToolkit = Toolkit.make(GetCurrentTime, Calculate, RollDice);

export const ChatToolkitLayer = ChatToolkit.toLayer({
  get_current_time: () =>
    Effect.sync(() => {
      const now = new Date();
      return { iso: now.toISOString(), unixMs: now.getTime() };
    }),
  calculate: ({ expression }) =>
    Effect.sync(() => {
      try {
        if (!/^[\d+\-*/().\s]+$/.test(expression)) {
          return {
            expression,
            result: 0,
            error: "expression contains unsupported characters",
          };
        }
        const result = Function(`"use strict"; return (${expression});`)();
        if (typeof result !== "number" || !Number.isFinite(result)) {
          return {
            expression,
            result: 0,
            error: "expression did not evaluate to a finite number",
          };
        }
        return { expression, result };
      } catch (cause) {
        return {
          expression,
          result: 0,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }),
  roll_dice: ({ sides, count }) =>
    Effect.sync(() => {
      const safeSides = Math.max(1, Math.floor(sides));
      const safeCount = Math.min(20, Math.max(1, Math.floor(count)));
      const rolls: Array<number> = [];
      for (let i = 0; i < safeCount; i++) {
        rolls.push(1 + Math.floor(Math.random() * safeSides));
      }
      return { rolls, total: rolls.reduce((a, b) => a + b, 0) };
    }),
});

export const SYSTEM_PROMPT = `You are a friendly assistant running on Cloudflare Workers AI.
You have access to tools — prefer calling a tool over making up an answer when one is relevant.
Available tools:
- get_current_time: current server time
- calculate: arithmetic over numbers
- roll_dice: roll N-sided dice
After a tool returns, weave its result into a natural reply.`;
