/**
 * Schema authoring kit for Cloudflare Pipelines streams and sinks.
 *
 * Re-exports `effect/Schema` so a single import covers every type Cloudflare
 * understands, and layers on the precision/temporal brand helpers Cloudflare
 * distinguishes that plain `Schema.Number` / `Schema.Date` cannot express.
 *
 * @example Defining a structured stream schema
 * ```typescript
 * import * as SQL from "alchemy/Cloudflare/SQL";
 *
 * const Events = SQL.Struct({
 *   user_id: SQL.String,
 *   count: SQL.Int64,
 *   at: SQL.Timestamp,
 *   tags: SQL.Array(SQL.String),
 *   meta: SQL.optional(SQL.Struct({ source: SQL.String })),
 * });
 *
 * const events = yield* Cloudflare.Stream("Events", { schema: Events });
 * ```
 */
export * from "effect/Schema";
export {
  Float32,
  Float64,
  Int32,
  Int64,
  Timestamp,
  TimestampMicroseconds,
  TimestampNanoseconds,
  TimestampSeconds,
} from "./Pipelines/StreamSchema.ts";
