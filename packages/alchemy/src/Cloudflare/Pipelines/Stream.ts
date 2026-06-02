import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as StreamE from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { StreamBinding } from "./StreamBinding.ts";
import {
  compileStreamSchema,
  type StreamSchemaFieldList,
  type StreamSchemaInput,
} from "./StreamSchema.ts";

export const isStream = (value: unknown): value is Stream =>
  typeof value === "object" &&
  (value as any)?.Type === "Cloudflare.PipelinesStream";

/**
 * Output / wire-format of the stream's structured schema. Cloudflare uses the
 * same `{ fields: [...] }` shape on read as on create.
 */
export type StreamSchema = StreamSchemaFieldList;

/**
 * Output format of records written to the stream.
 */
export type StreamFormat =
  | {
      type: "json";
      decimalEncoding?: "number" | "string" | "bytes";
      timestampFormat?: "rfc3339" | "unix_millis";
      unstructured?: boolean;
    }
  | {
      type: "parquet";
      compression?: "uncompressed" | "snappy" | "gzip" | "zstd" | "lz4";
      rowGroupBytes?: number;
    };

export type StreamHttpSettings = {
  /**
   * Whether HTTP ingestion is enabled.
   * @default true
   */
  enabled?: boolean;
  /**
   * Whether HTTP ingest requires the `Authorization: Bearer <token>` header.
   * @default false
   */
  authentication?: boolean;
  /**
   * Optional CORS allowlist for browser-based ingestion.
   */
  cors?: {
    origins?: string[];
  };
};

export type StreamWorkerBindingSettings = {
  /**
   * Whether the Worker `pipelines` binding is enabled for this stream.
   * @default true
   */
  enabled?: boolean;
};

export type StreamProps = {
  /**
   * Stream name. If omitted, a unique name is generated. Must match
   * Cloudflare's stream-name rules (lowercase letters, digits, underscores).
   * @default ${app}_${stage}_${id}
   */
  name?: string;
  /**
   * Schema for incoming events. Pass an `effect/Schema` struct (compiled to
   * Cloudflare's field list via {@link compileStreamSchema}) or the raw
   * `{ fields: [...] }` payload as an escape hatch. Omit for an
   * **unstructured** stream that stores arbitrary JSON in a single `value`
   * column.
   */
  schema?: StreamSchemaInput;
  /**
   * Output format used by downstream pipelines.
   */
  format?: StreamFormat;
  /**
   * HTTP ingest configuration.
   */
  http?: StreamHttpSettings;
  /**
   * Worker binding configuration.
   * @default { enabled: true }
   */
  workerBinding?: StreamWorkerBindingSettings;
};

export type Stream = Resource<
  "Cloudflare.PipelinesStream",
  StreamProps,
  {
    /** The stream's public Cloudflare id (used by the `pipelines` Worker binding). */
    streamId: string;
    /** The stream's name. */
    streamName: string;
    /** The HTTP ingest endpoint, when enabled. */
    endpoint: string | undefined;
    /** Cloudflare-reported config version. */
    version: number;
    http: {
      enabled: boolean;
      authentication: boolean;
      cors: { origins: string[] | undefined } | undefined;
    };
    workerBinding: { enabled: boolean };
    /** Resolved schema fields (or undefined for an unstructured stream). */
    schema: StreamSchema | undefined;
    format: StreamFormat | undefined;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Pipelines Stream — a durable, buffered queue that receives
 * events via HTTP ingest, Worker bindings, or Logpush, for downstream
 * consumption by a {@link Pipeline}.
 *
 * Streams are **write-only**: producers write into them and a SQL Pipeline is
 * the only consumer.
 *
 * @section Creating a Stream
 * @example Unstructured stream
 * ```typescript
 * const events = yield* Cloudflare.Stream("Events");
 * ```
 *
 * @example Structured stream defined with the SQL kit
 * Pass fields directly — `schema` accepts a plain record of `Schema` values
 * (it's wrapped in `Schema.Struct(...)` internally), a full `Schema.Struct`
 * value, or the raw `{ fields: [...] }` escape hatch.
 * ```typescript
 * import * as SQL from "alchemy/Cloudflare/SQL";
 *
 * const events = yield* Cloudflare.Stream("Events", {
 *   schema: {
 *     user_id: SQL.String,
 *     amount: SQL.optional(SQL.Number),
 *     at: SQL.Timestamp,
 *   },
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Sending records from a Worker
 * ```typescript
 * const events = yield* Cloudflare.Stream.bind(Events);
 * yield* events.send({ user_id: "u1", amount: 42 });
 * ```
 */
export const Stream = Resource<Stream>("Cloudflare.PipelinesStream")({
  bind: StreamBinding.bind,
});

const createStreamName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    // Cloudflare requires lowercase + underscores for stream names; mirror
    // the convention so generated names always parse.
    return (yield* createPhysicalName({ id, maxLength: 63 }))
      .toLowerCase()
      .replace(/-/g, "_");
  });

type ObservedStream = NonNullable<pipelines.GetStreamResponse>;

const findStreamByName = (accountId: string, name: string) =>
  pipelines.listStreams.items({ accountId }).pipe(
    StreamE.filter((s) => s.name === name),
    StreamE.runHead,
    Effect.map(Option.getOrUndefined),
  );

const normalizeFields = (
  fields: NonNullable<ObservedStream["schema"]>["fields"] | null | undefined,
): StreamSchemaFieldList["fields"] | undefined => {
  if (!fields) return undefined;
  // Strip `null` from the optional fields on the response shape so equality
  // against compiled (no-null) inputs works.
  return fields.map((f) => {
    if (!f || typeof f !== "object") return f;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
      if (v != null) out[k] = v;
    }
    return out;
  }) as StreamSchemaFieldList["fields"];
};

const observedHttp = (http: ObservedStream["http"]) => ({
  enabled: http.enabled,
  authentication: http.authentication,
  cors: http.cors ? { origins: http.cors.origins ?? undefined } : undefined,
});

const observedFormat = (
  format: ObservedStream["format"],
): StreamFormat | undefined => {
  if (!format) return undefined;
  if (format.type === "json") {
    return {
      type: "json",
      decimalEncoding:
        (format.decimalEncoding as StreamFormat extends infer F
          ? F extends { type: "json"; decimalEncoding?: infer D }
            ? D
            : never
          : never) ?? undefined,
      timestampFormat: (format.timestampFormat as any) ?? undefined,
      unstructured: format.unstructured ?? undefined,
    } as StreamFormat;
  }
  if (format.type === "parquet") {
    return {
      type: "parquet",
      compression: (format.compression as any) ?? undefined,
      rowGroupBytes: format.rowGroupBytes ?? undefined,
    } as StreamFormat;
  }
  return undefined;
};

const observedSchema = (
  schema: ObservedStream["schema"],
): StreamSchema | undefined => {
  if (!schema || !schema.fields) return undefined;
  return { fields: normalizeFields(schema.fields) };
};

const desiredHttp = (
  http: StreamHttpSettings | undefined,
): {
  authentication: boolean;
  enabled: boolean;
  cors?: { origins?: string[] };
} => ({
  authentication: http?.authentication ?? false,
  enabled: http?.enabled ?? true,
  cors: http?.cors?.origins ? { origins: http.cors.origins } : undefined,
});

const desiredWorkerBinding = (
  workerBinding: StreamWorkerBindingSettings | undefined,
): { enabled: boolean } => ({
  enabled: workerBinding?.enabled ?? true,
});

const toAttrs = (
  observed: ObservedStream,
  accountId: string,
): Stream["Attributes"] => ({
  streamId: observed.id,
  streamName: observed.name,
  endpoint: observed.endpoint ?? undefined,
  version: observed.version,
  http: observedHttp(observed.http),
  workerBinding: { enabled: observed.workerBinding.enabled },
  schema: observedSchema(observed.schema),
  format: observedFormat(observed.format),
  accountId,
});

export const StreamProvider = () =>
  Provider.effect(
    Stream,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createStream = yield* pipelines.createStream;
      const getStream = yield* pipelines.getStream;
      const patchStream = yield* pipelines.patchStream;
      const deleteStream = yield* pipelines.deleteStream;

      return {
        stables: ["streamId", "streamName", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const newName = yield* createStreamName(id, news.name);
          const oldName =
            output?.streamName ?? (yield* createStreamName(id, olds.name));
          if (newName !== oldName) {
            return { action: "replace" } as const;
          }
          // Format and schema are baked at creation time and cannot be
          // patched in place; treat any change as a replace.
          if (!deepEqual(olds.format, news.format, { stripNullish: true })) {
            return { action: "replace" } as const;
          }
          if (!deepEqual(olds.schema, news.schema, { stripNullish: true })) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const acct = output?.accountId ?? accountId;
          const name = yield* createStreamName(id, news.name);

          // Observe — fetch cached, fall back to a name scan if the cached
          // id is stale. listStreams paginates and has no name filter, so
          // we use the items stream.
          let observed: ObservedStream | undefined;
          if (output?.streamId) {
            observed = yield* getStream({
              accountId: acct,
              streamId: output.streamId,
            }).pipe(
              Effect.catchTag("StreamNotFound", () =>
                Effect.succeed(undefined),
              ),
              Effect.catchTag("InvalidStreamId", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          if (!observed) {
            const match = yield* findStreamByName(acct, name);
            if (match) {
              observed = yield* getStream({
                accountId: acct,
                streamId: match.id,
              }).pipe(
                Effect.catchTag("StreamNotFound", () =>
                  Effect.succeed(undefined),
                ),
              );
            }
          }

          // Ensure — create if missing. Compile the user-facing
          // effect/Schema (if any) just-in-time so plan-time refs resolve.
          if (!observed) {
            const schema = news.schema
              ? yield* compileStreamSchema(news.schema).pipe(
                  Effect.mapError(
                    (e) =>
                      new Error(`Cloudflare.Stream("${id}"): ${e.message}`),
                  ),
                )
              : undefined;

            const created = yield* createStream({
              accountId: acct,
              name,
              format: news.format,
              http: desiredHttp(news.http),
              schema,
              workerBinding: desiredWorkerBinding(news.workerBinding),
            }).pipe(
              // Race: a peer reconciler beat us to the create. Re-resolve
              // by name and continue the sync path so observed != undefined.
              Effect.catchTag("StreamAlreadyExists", () =>
                Effect.gen(function* () {
                  const match = yield* findStreamByName(acct, name);
                  if (!match) {
                    return yield* Effect.die(
                      `Cloudflare reported stream "${name}" already exists ` +
                        `but listStreams returned none. Retry the deploy; ` +
                        `if this persists, the stream is in an inconsistent state.`,
                    );
                  }
                  return yield* getStream({
                    accountId: acct,
                    streamId: match.id,
                  });
                }),
              ),
            );

            // Probed: createStream → getStream returns success on the very
            // next call, so no consistency retry is needed here. Catch
            // StreamNotFound defensively in case the create result is stale.
            observed = yield* getStream({
              accountId: acct,
              streamId: created.id,
            }).pipe(
              Effect.catchTag("StreamNotFound", () => Effect.succeed(created)),
            );
          }

          // Sync — http + workerBinding are the only mutable settings.
          // Diff against observed cloud state, not olds, so adoption and
          // out-of-band drift converge.
          const desiredHttpSettings = desiredHttp(news.http);
          const observedHttpSettings = observedHttp(observed.http);
          const desiredWb = desiredWorkerBinding(news.workerBinding);

          const httpDrift =
            observedHttpSettings.enabled !== desiredHttpSettings.enabled ||
            observedHttpSettings.authentication !==
              desiredHttpSettings.authentication ||
            !deepEqual(
              observedHttpSettings.cors?.origins,
              desiredHttpSettings.cors?.origins,
              { stripNullish: true },
            );

          const wbDrift = observed.workerBinding.enabled !== desiredWb.enabled;

          if (httpDrift || wbDrift) {
            observed = yield* patchStream({
              accountId: acct,
              streamId: observed.id,
              http: httpDrift ? desiredHttpSettings : undefined,
              workerBinding: wbDrift ? desiredWb : undefined,
            });
          }

          return toAttrs(observed, acct);
        }),
        delete: Effect.fn(function* ({ output }) {
          // deleteStream is idempotent on a missing id and returns success
          // — the distilled error union for this op only includes
          // `PipelineNotExists`, which Cloudflare raises when `force:"true"`
          // is passed against a stream that has no dependent pipeline.
          // We do NOT pass `force`, so the only error path we catch is the
          // dependency one (in case the engine ever calls delete in a
          // different order than the dependency graph dictates).
          yield* deleteStream({
            accountId: output.accountId,
            streamId: output.streamId,
          }).pipe(Effect.catchTag("PipelineNotExists", () => Effect.void));
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const acct = output?.accountId ?? accountId;
          if (output?.streamId) {
            return yield* getStream({
              accountId: acct,
              streamId: output.streamId,
            }).pipe(
              Effect.map((s) => toAttrs(s, acct)),
              Effect.catchTag("StreamNotFound", () =>
                Effect.succeed(undefined),
              ),
              Effect.catchTag("InvalidStreamId", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          const name = yield* createStreamName(id, olds?.name);
          const match = yield* findStreamByName(acct, name);
          if (!match) return undefined;
          const full = yield* getStream({
            accountId: acct,
            streamId: match.id,
          }).pipe(
            Effect.catchTag("StreamNotFound", () => Effect.succeed(undefined)),
          );
          return full ? toAttrs(full, acct) : undefined;
        }),
      };
    }),
  );
