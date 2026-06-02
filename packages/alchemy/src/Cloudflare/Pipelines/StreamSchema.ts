import type * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import * as AST from "effect/SchemaAST";

/**
 * The shape Cloudflare expects for a stream's structured-event schema. We
 * compile an `effect/Schema` struct down to this list.
 */
export type StreamSchemaFieldList = NonNullable<
  pipelines.CreateStreamRequest["schema"]
>;

/**
 * A single field entry inside {@link StreamSchemaFieldList}. The distilled
 * union admits the `unknown` escape hatch for forward-compat types; we always
 * emit a concrete tag.
 */
export type StreamSchemaField = NonNullable<
  StreamSchemaFieldList["fields"]
>[number];

/**
 * Accepted shapes for {@link compileStreamSchema}:
 *
 * - A plain field record (`{ user_id: SQL.String, ... }`) — the
 *   ergonomic default; internally wrapped in `Schema.Struct(...)`.
 * - A `Schema.Struct(...)` value — useful when the schema is reused
 *   across resources.
 * - A raw `{ fields: [...] }` payload — escape hatch for types not yet
 *   handled by the compiler.
 */
export type StreamSchemaInput = S.Struct.Fields | S.Top | StreamSchemaFieldList;

/** Raised when {@link compileStreamSchema} hits an AST node it can't map. */
export class UnsupportedStreamSchemaNode extends Data.TaggedError(
  "UnsupportedStreamSchemaNode",
)<{
  message: string;
  path: ReadonlyArray<PropertyKey>;
  tag: string;
}> {}

// ---------------------------------------------------------------------------
// Brand helpers — Cloudflare distinguishes int/float widths and timestamp
// units that plain `Schema.Number` / `Schema.Date` cannot express. We carry
// the precision as an AST annotation and read it back in the compiler.
// ---------------------------------------------------------------------------

const CloudflareTypeKey = "alchemy.cloudflare.pipelines.streamType";

type CloudflareNumericTag =
  | "int32"
  | "int64"
  | "float32"
  | "float64"
  | "timestamp_ms"
  | "timestamp_s"
  | "timestamp_us"
  | "timestamp_ns";

const numericBrand = (tag: CloudflareNumericTag) =>
  S.Number.annotate({ [CloudflareTypeKey]: tag });

const timestampBrand = (
  unit: "second" | "millisecond" | "microsecond" | "nanosecond",
) =>
  S.Date.annotate({
    [CloudflareTypeKey]:
      unit === "second"
        ? "timestamp_s"
        : unit === "millisecond"
          ? "timestamp_ms"
          : unit === "microsecond"
            ? "timestamp_us"
            : "timestamp_ns",
  });

const readCloudflareTag = (ast: AST.AST): CloudflareNumericTag | undefined => {
  const annotations = (ast as { annotations?: Record<string, unknown> })
    .annotations;
  const tag = annotations?.[CloudflareTypeKey];
  return typeof tag === "string" ? (tag as CloudflareNumericTag) : undefined;
};

/**
 * A 32-bit signed integer field. Compiles to `{ type: "int32" }`.
 */
export const Int32 = numericBrand("int32");

/**
 * A 64-bit signed integer field. Compiles to `{ type: "int64" }`.
 */
export const Int64 = numericBrand("int64");

/**
 * A 32-bit float field. Compiles to `{ type: "float32" }`.
 */
export const Float32 = numericBrand("float32");

/**
 * A 64-bit float field. Compiles to `{ type: "float64" }`.
 *
 * Use this when you want to be explicit; bare `Schema.Number` already
 * compiles to `float64`.
 */
export const Float64 = numericBrand("float64");

/**
 * A timestamp field with millisecond precision (the most common shape).
 * Compiles to `{ type: "timestamp", unit: "millisecond" }`.
 */
export const Timestamp = timestampBrand("millisecond");

/**
 * A timestamp field with second precision.
 */
export const TimestampSeconds = timestampBrand("second");

/**
 * A timestamp field with microsecond precision.
 */
export const TimestampMicroseconds = timestampBrand("microsecond");

/**
 * A timestamp field with nanosecond precision.
 */
export const TimestampNanoseconds = timestampBrand("nanosecond");

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

const isFieldList = (
  input: StreamSchemaInput,
): input is StreamSchemaFieldList =>
  typeof input === "object" &&
  input !== null &&
  !(input as { ast?: unknown }).ast &&
  Array.isArray((input as StreamSchemaFieldList).fields);

const isSchema = (input: unknown): input is S.Top =>
  typeof input === "object" &&
  input !== null &&
  (input as { ast?: unknown }).ast !== undefined;

const isFieldRecord = (input: StreamSchemaInput): input is S.Struct.Fields => {
  if (typeof input !== "object" || input === null) return false;
  if (isFieldList(input)) return false;
  if (isSchema(input)) return false;
  // Every value must itself be a Schema (carry an `ast` property). The
  // raw field-list and Schema shapes are excluded above; this leaves the
  // ergonomic shape `{ user_id: SQL.String, ... }`.
  for (const key of Object.keys(input)) {
    if (!isSchema((input as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
};

const decl = (ast: AST.AST) =>
  AST.isDeclaration(ast)
    ? ((ast.annotations as { typeConstructor?: { _tag?: string } })
        ?.typeConstructor?._tag ?? undefined)
    : undefined;

interface CompileCtx {
  path: ReadonlyArray<PropertyKey>;
}

const fail = (ctx: CompileCtx, tag: string, message: string) =>
  Effect.fail(
    new UnsupportedStreamSchemaNode({ message, path: ctx.path, tag }),
  );

const compileType = (
  ast: AST.AST,
  ctx: CompileCtx,
): Effect.Effect<StreamSchemaField, UnsupportedStreamSchemaNode> =>
  Effect.gen(function* () {
    // Unions: tolerate `T | undefined` (the shape Schema.optional produces on
    // the value side). Anything else with multiple non-undefined members is
    // genuinely ambiguous for the Cloudflare wire format.
    if (AST.isUnion(ast)) {
      const nonUndefined = ast.types.filter((t) => !AST.isUndefined(t));
      if (nonUndefined.length === 1) {
        return yield* compileType(nonUndefined[0]!, ctx);
      }
      return yield* fail(
        ctx,
        "Union",
        `Unsupported union at ${ctx.path.join(".") || "<root>"}: ` +
          `Cloudflare stream schemas don't have a tagged-union representation. ` +
          `Use Schema.optional for nullable fields.`,
      );
    }

    const explicitTag = readCloudflareTag(ast);
    if (explicitTag) {
      switch (explicitTag) {
        case "int32":
        case "int64":
        case "float32":
        case "float64":
          return { type: explicitTag };
        case "timestamp_ms":
          return { type: "timestamp", unit: "millisecond" };
        case "timestamp_s":
          return { type: "timestamp", unit: "second" };
        case "timestamp_us":
          return { type: "timestamp", unit: "microsecond" };
        case "timestamp_ns":
          return { type: "timestamp", unit: "nanosecond" };
      }
    }

    if (AST.isString(ast)) return { type: "string" };
    if (AST.isBoolean(ast)) return { type: "bool" };
    if (AST.isNumber(ast)) return { type: "float64" };

    if (AST.isArrays(ast)) {
      // `Arrays` AST has a `rest` element list — the array's element type lives
      // at index 0 for a homogeneous Schema.Array.
      const rest = (ast as unknown as { rest?: ReadonlyArray<AST.AST> }).rest;
      const elementAst = rest && rest.length > 0 ? rest[0] : undefined;
      if (!elementAst) {
        return yield* fail(
          ctx,
          "Arrays",
          `Empty Schema.Array at ${ctx.path.join(".") || "<root>"}: ` +
            `Cloudflare list fields require a single homogeneous element type.`,
        );
      }
      const inner = yield* compileType(elementAst, {
        path: [...ctx.path, "[]"],
      });
      return {
        type: "list",
        // The Cloudflare wire format nests the element under `items`; the
        // distilled type still permits `unknown` here, so a structural cast
        // is unavoidable.
        items: inner as unknown,
      } as StreamSchemaField;
    }

    if (AST.isObjects(ast)) {
      // Treat objects with index signatures or no properties as opaque JSON.
      const obj = ast as AST.Objects;
      if (
        obj.indexSignatures.length > 0 ||
        obj.propertySignatures.length === 0
      ) {
        return { type: "json" };
      }
      const fields: StreamSchemaField[] = [];
      for (const ps of obj.propertySignatures) {
        fields.push(
          yield* compileProperty(ps, { path: [...ctx.path, ps.name] }),
        );
      }
      return { type: "struct", fields } as unknown as StreamSchemaField;
    }

    // Effect schemas surface `Date` / `Uint8Array` as declarations; map them
    // to Cloudflare's native primitives so callers don't need to brand
    // bytes/dates explicitly.
    const tc = decl(ast);
    if (tc === "Date") return { type: "timestamp", unit: "millisecond" };
    if (tc === "Uint8Array") return { type: "binary" };

    // Schema.Unknown / Schema.Any / Schema.Object → wire as JSON blob.
    // Cloudflare keeps these as the `value` column when the stream is
    // unstructured, but inside a struct field they round-trip as JSON.
    const tag = (ast as { _tag?: string })._tag;
    if (tag === "Unknown" || tag === "Any" || tag === "ObjectKeyword") {
      return { type: "json" };
    }

    return yield* fail(
      ctx,
      (ast as { _tag?: string })._tag ?? "Unknown",
      `Unsupported AST node ${(ast as { _tag?: string })._tag ?? "<unknown>"} ` +
        `at ${ctx.path.join(".") || "<root>"}. Use Schema.Struct, ` +
        `Schema.String/Number/Boolean, Schema.Array, Schema.Date, ` +
        `Schema.optional, or the Cloudflare brand helpers ` +
        `(Int32/Int64/Float32/Float64/Timestamp).`,
    );
  });

const compileProperty = (
  ps: AST.PropertySignature,
  ctx: CompileCtx,
): Effect.Effect<StreamSchemaField, UnsupportedStreamSchemaNode> =>
  Effect.gen(function* () {
    if (typeof ps.name !== "string") {
      return yield* fail(
        ctx,
        "PropertySignature",
        `Cloudflare stream fields require string property keys; got ${String(ps.name)} ` +
          `at ${ctx.path.join(".") || "<root>"}.`,
      );
    }
    const compiled = (yield* compileType(ps.type, ctx)) as Record<
      string,
      unknown
    >;
    const required = !AST.isOptional(ps.type);
    return {
      ...compiled,
      name: ps.name,
      sqlName: ps.name,
      required,
    } as StreamSchemaField;
  });

/**
 * Compile an `effect/Schema` struct (or a plain record of `Schema` values)
 * into Cloudflare's stream-schema field list. Callers can also pass a raw
 * `{ fields: [...] }` payload to bypass the compiler.
 *
 * @example Compile from a field record (most ergonomic)
 * ```typescript
 * const fields = yield* compileStreamSchema({
 *   user_id: SQL.String,
 *   amount: SQL.optional(SQL.Number),
 * });
 * ```
 *
 * @example Compile from a Schema.Struct value
 * ```typescript
 * const fields = yield* compileStreamSchema(
 *   SQL.Struct({
 *     user_id: SQL.String,
 *     amount: SQL.optional(SQL.Number),
 *   }),
 * );
 * ```
 */
export const compileStreamSchema = (
  input: StreamSchemaInput,
): Effect.Effect<StreamSchemaFieldList, UnsupportedStreamSchemaNode> =>
  Effect.gen(function* () {
    if (isFieldList(input)) {
      return input;
    }
    // Accept a plain field record (`{ user_id: SQL.String, ... }`) by
    // wrapping it in Schema.Struct(...) so the user never has to write
    // it themselves.
    const schema: S.Top = isFieldRecord(input) ? S.Struct(input) : input;
    const ast = schema.ast;
    if (!AST.isObjects(ast)) {
      return yield* fail(
        { path: [] },
        (ast as { _tag?: string })._tag ?? "NonObject",
        `Top-level stream schema must be a struct (a Schema.Struct or a ` +
          `plain field record); got ` +
          `${(ast as { _tag?: string })._tag ?? "<unknown>"}.`,
      );
    }
    const obj = ast as AST.Objects;
    const fields: StreamSchemaField[] = [];
    for (const ps of obj.propertySignatures) {
      fields.push(yield* compileProperty(ps, { path: [ps.name] }));
    }
    return { fields };
  });
