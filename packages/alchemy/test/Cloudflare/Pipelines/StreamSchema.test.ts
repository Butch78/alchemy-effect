import { compileStreamSchema } from "@/Cloudflare/Pipelines/StreamSchema";
import * as SQL from "@/Cloudflare/SQL";
import { describe, expect, test } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const {
  Float32,
  Float64,
  Int32,
  Int64,
  Timestamp,
  TimestampMicroseconds,
  TimestampNanoseconds,
  TimestampSeconds,
} = SQL;

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>);

describe("compileStreamSchema", () => {
  test("compiles scalars from a plain field record", async () => {
    const fields = await run(
      compileStreamSchema({
        s: Schema.String,
        b: Schema.Boolean,
        n: Schema.Number,
      }),
    );
    expect(fields).toEqual({
      fields: [
        { type: "string", name: "s", sqlName: "s", required: true },
        { type: "bool", name: "b", sqlName: "b", required: true },
        { type: "float64", name: "n", sqlName: "n", required: true },
      ],
    });
  });

  test("accepts a Schema.Struct value too", async () => {
    const fields = await run(
      compileStreamSchema(
        Schema.Struct({
          s: Schema.String,
        }),
      ),
    );
    expect(fields.fields).toEqual([
      { type: "string", name: "s", sqlName: "s", required: true },
    ]);
  });

  test("optional fields produce required: false", async () => {
    const fields = await run(
      compileStreamSchema(
        Schema.Struct({
          required: Schema.String,
          maybe: Schema.optional(Schema.String),
        }),
      ),
    );
    expect(fields.fields).toEqual([
      { type: "string", name: "required", sqlName: "required", required: true },
      { type: "string", name: "maybe", sqlName: "maybe", required: false },
    ]);
  });

  test("compiles Schema.Array as list with element type", async () => {
    const fields = await run(
      compileStreamSchema(
        Schema.Struct({
          tags: Schema.Array(Schema.String),
        }),
      ),
    );
    expect(fields.fields?.[0]).toMatchObject({
      type: "list",
      name: "tags",
      sqlName: "tags",
      required: true,
      items: { type: "string" },
    });
  });

  test("compiles nested Schema.Struct as struct with recursive fields", async () => {
    const fields = await run(
      compileStreamSchema(
        Schema.Struct({
          meta: Schema.Struct({
            source: Schema.String,
            priority: Schema.optional(Schema.Number),
          }),
        }),
      ),
    );
    expect(fields.fields?.[0]).toMatchObject({
      type: "struct",
      name: "meta",
      sqlName: "meta",
      required: true,
      fields: [
        { type: "string", name: "source", sqlName: "source", required: true },
        {
          type: "float64",
          name: "priority",
          sqlName: "priority",
          required: false,
        },
      ],
    });
  });

  test("int/float brand helpers emit precision-specific types", async () => {
    const fields = await run(
      compileStreamSchema(
        Schema.Struct({
          i32: Int32,
          i64: Int64,
          f32: Float32,
          f64: Float64,
        }),
      ),
    );
    const byName = Object.fromEntries(
      (fields.fields ?? []).map((f: any) => [f.name, f.type]),
    );
    expect(byName).toEqual({
      i32: "int32",
      i64: "int64",
      f32: "float32",
      f64: "float64",
    });
  });

  test("Timestamp brands emit unit-specific timestamps", async () => {
    const fields = await run(
      compileStreamSchema(
        Schema.Struct({
          ms: Timestamp,
          s: TimestampSeconds,
          us: TimestampMicroseconds,
          ns: TimestampNanoseconds,
        }),
      ),
    );
    const byName = Object.fromEntries(
      (fields.fields ?? []).map((f: any) => [f.name, f]),
    );
    expect(byName.ms).toMatchObject({ type: "timestamp", unit: "millisecond" });
    expect(byName.s).toMatchObject({ type: "timestamp", unit: "second" });
    expect(byName.us).toMatchObject({ type: "timestamp", unit: "microsecond" });
    expect(byName.ns).toMatchObject({ type: "timestamp", unit: "nanosecond" });
  });

  test("plain Schema.Date compiles to millisecond timestamp", async () => {
    const fields = await run(
      compileStreamSchema(Schema.Struct({ at: Schema.Date })),
    );
    expect(fields.fields?.[0]).toMatchObject({
      type: "timestamp",
      unit: "millisecond",
      name: "at",
      sqlName: "at",
      required: true,
    });
  });

  test("Schema.Unknown compiles to json", async () => {
    const fields = await run(
      compileStreamSchema(Schema.Struct({ blob: Schema.Unknown })),
    );
    expect(fields.fields?.[0]).toMatchObject({
      type: "json",
      name: "blob",
      sqlName: "blob",
      required: true,
    });
  });

  test("raw field-list payload passes through unchanged", async () => {
    const input = {
      fields: [{ type: "string" as const, name: "x", required: true }],
    };
    const out = await run(compileStreamSchema(input));
    expect(out).toBe(input);
  });

  test("non-struct top-level fails with a tagged error", async () => {
    const result = await Effect.runPromiseExit(
      compileStreamSchema(Schema.String as any),
    );
    expect(result._tag).toBe("Failure");
  });

  test("multi-branch union (not just T | undefined) fails with a tagged error", async () => {
    const result = await Effect.runPromiseExit(
      compileStreamSchema(
        Schema.Struct({
          ambiguous: Schema.Union([Schema.String, Schema.Number]),
        }) as any,
      ),
    );
    expect(result._tag).toBe("Failure");
  });
});
