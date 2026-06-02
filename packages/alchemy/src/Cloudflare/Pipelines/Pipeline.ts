import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as StreamE from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { isSink, type Sink } from "./Sink.ts";
import { isStream, type Stream } from "./Stream.ts";

export const isPipeline = (value: unknown): value is Pipeline =>
  typeof value === "object" &&
  (value as any)?.Type === "Cloudflare.PipelinesPipeline";

export type PipelineTableInfo = {
  id: string;
  name: string;
  type: "stream" | "sink";
  version: number;
  latest: number;
};

export type PipelineProps = {
  /**
   * Pipeline name. If omitted, a unique name is generated. Must match
   * Cloudflare's pipeline-name rules (lowercase letters, digits, underscores).
   * @default ${app}_${stage}_${id}
   */
  name?: string;
  /**
   * SQL that defines the pipeline. Most callers should build this with the
   * {@link pipelineSql} tagged template, which interpolates `Stream` and
   * `Sink` resources by name so the engine wires up dependencies for you.
   */
  sql: Input<string>;
  /**
   * Validate the SQL against the configured stream and sink before sending
   * the create request. Saves a noisy `InvalidSql`/`TableNotFound` failure
   * after deployment has already started.
   * @default true
   */
  validate?: boolean;
};

export type Pipeline = Resource<
  "Cloudflare.PipelinesPipeline",
  PipelineProps,
  {
    pipelineId: string;
    pipelineName: string;
    sql: string;
    status: string;
    tables: PipelineTableInfo[];
    createdAt: string;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Pipelines Pipeline — the SQL job that reads events from a
 * {@link Stream} and writes them to a {@link Sink}.
 *
 * The SQL is immutable in Cloudflare's API: any change to `sql` triggers a
 * replace. Use {@link pipelineSql} to build the statement so stream and sink
 * names are interpolated lazily, and the engine sees the resource dependencies.
 *
 * @section Creating a Pipeline
 * @example Insert all events from a stream into a sink
 * ```typescript
 * const events = yield* Cloudflare.Stream("Events");
 * const sink = yield* Cloudflare.Sink("Lake", { type: "r2", bucket });
 *
 * yield* Cloudflare.Pipeline("Ingest", {
 *   sql: Cloudflare.pipelineSql`
 *     INSERT INTO ${sink}
 *     SELECT * FROM ${events}`,
 * });
 * ```
 *
 * @example Transform on the way through
 * ```typescript
 * yield* Cloudflare.Pipeline("HighValue", {
 *   sql: Cloudflare.pipelineSql`
 *     INSERT INTO ${sink}
 *     SELECT user_id, amount FROM ${events}
 *     WHERE amount > 100`,
 * });
 * ```
 */
export const Pipeline = Resource<Pipeline>("Cloudflare.PipelinesPipeline");

/**
 * Tagged-template helper for building pipeline SQL.
 *
 * Interpolates {@link Stream} and {@link Sink} resources by name, returning
 * an `Input<string>` the engine resolves lazily. The resulting dependency
 * edges guarantee streams and sinks are provisioned before the pipeline.
 *
 * @example
 * ```typescript
 * const stream = yield* Cloudflare.Stream("Events");
 * const sink = yield* Cloudflare.Sink("Lake", { type: "r2", bucket });
 *
 * const sql = Cloudflare.pipelineSql`
 *   INSERT INTO ${sink}
 *   SELECT * FROM ${stream} WHERE amount > 100`;
 * ```
 */
export const pipelineSql = (
  template: TemplateStringsArray,
  ...args: ReadonlyArray<Stream | Sink | Input<string>>
): Input<string> => {
  const resolved = args.map((arg) => {
    if (isStream(arg)) return arg.streamName;
    if (isSink(arg)) return arg.sinkName;
    return arg;
  });
  return Output.interpolate(template, ...(resolved as any[]));
};

const createPipelineName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return (yield* createPhysicalName({ id, maxLength: 63 }))
      .toLowerCase()
      .replace(/-/g, "_");
  });

const findPipelineByName = (accountId: string, name: string) =>
  pipelines.listV1Pipeline.items({ accountId }).pipe(
    StreamE.filter((p) => p.name === name),
    StreamE.runHead,
    Effect.map(Option.getOrUndefined),
  );

const toTables = (
  tables: pipelines.GetV1PipelineResponse["tables"],
): PipelineTableInfo[] =>
  tables.map((t) => ({
    id: t.id,
    name: t.name,
    type: (t.type === "stream" ? "stream" : "sink") as "stream" | "sink",
    version: t.version,
    latest: t.latest,
  }));

export const PipelineProvider = () =>
  Provider.effect(
    Pipeline,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createV1Pipeline = yield* pipelines.createV1Pipeline;
      const getV1Pipeline = yield* pipelines.getV1Pipeline;
      const deleteV1Pipeline = yield* pipelines.deleteV1Pipeline;
      const validateSqlPipeline = yield* pipelines.validateSqlPipeline;

      return {
        stables: ["pipelineId", "pipelineName", "accountId"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const newName = yield* createPipelineName(id, news.name);
          const oldName =
            output?.pipelineName ?? (yield* createPipelineName(id, olds.name));
          if (newName !== oldName) {
            return { action: "replace" } as const;
          }
          // SQL is the body of the pipeline; Cloudflare cannot update it in
          // place. Replace on any change.
          if (olds.sql !== news.sql) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const acct = output?.accountId ?? accountId;
          const name = yield* createPipelineName(id, news.name);
          const sql = news.sql as string;

          // Observe — cached id, then name scan as a fallback.
          let observed: pipelines.GetV1PipelineResponse | undefined;
          if (output?.pipelineId) {
            observed = yield* getV1Pipeline({
              accountId: acct,
              pipelineId: output.pipelineId,
            }).pipe(
              Effect.catchTag("PipelineNotExists", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          if (!observed) {
            const match = yield* findPipelineByName(acct, name);
            if (match) {
              observed = yield* getV1Pipeline({
                accountId: acct,
                pipelineId: match.id,
              }).pipe(
                Effect.catchTag("PipelineNotExists", () =>
                  Effect.succeed(undefined),
                ),
              );
            }
          }

          if (observed) {
            return {
              pipelineId: observed.id,
              pipelineName: observed.name,
              sql: observed.sql,
              status: observed.status,
              tables: toTables(observed.tables),
              createdAt: observed.createdAt,
              accountId: acct,
            };
          }

          // Validate before create when enabled — surfacing `InvalidSql` /
          // `TableNotFound` here is cheaper than after a partial deploy.
          if (news.validate !== false) {
            yield* validateSqlPipeline({ accountId: acct, sql });
          }

          // Ensure — create. Tolerate the AlreadyExists race by re-resolving
          // by name.
          const created = yield* createV1Pipeline({
            accountId: acct,
            name,
            sql,
          }).pipe(
            Effect.catchTag("PipelineAlreadyExists", () =>
              Effect.gen(function* () {
                const match = yield* findPipelineByName(acct, name);
                if (!match) {
                  return yield* Effect.die(
                    `Cloudflare reported pipeline "${name}" already exists ` +
                      `but listV1Pipeline returned none. Retry the deploy.`,
                  );
                }
                return yield* getV1Pipeline({
                  accountId: acct,
                  pipelineId: match.id,
                });
              }),
            ),
          );

          const full = yield* getV1Pipeline({
            accountId: acct,
            pipelineId: created.id,
          }).pipe(
            Effect.catchTag("PipelineNotExists", () =>
              Effect.succeed({
                ...created,
                tables: [] as pipelines.GetV1PipelineResponse["tables"],
              }),
            ),
          );

          return {
            pipelineId: full.id,
            pipelineName: full.name,
            sql: full.sql,
            status: full.status,
            tables: toTables(full.tables),
            createdAt: full.createdAt,
            accountId: acct,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteV1Pipeline({
            accountId: output.accountId,
            pipelineId: output.pipelineId,
          }).pipe(Effect.catchTag("PipelineNotExists", () => Effect.void));
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const acct = output?.accountId ?? accountId;
          if (output?.pipelineId) {
            return yield* getV1Pipeline({
              accountId: acct,
              pipelineId: output.pipelineId,
            }).pipe(
              Effect.map((p) => ({
                pipelineId: p.id,
                pipelineName: p.name,
                sql: p.sql,
                status: p.status,
                tables: toTables(p.tables),
                createdAt: p.createdAt,
                accountId: acct,
              })),
              Effect.catchTag("PipelineNotExists", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          const name = yield* createPipelineName(id, olds?.name);
          const match = yield* findPipelineByName(acct, name);
          if (!match) return undefined;
          const full = yield* getV1Pipeline({
            accountId: acct,
            pipelineId: match.id,
          }).pipe(
            Effect.catchTag("PipelineNotExists", () =>
              Effect.succeed(undefined),
            ),
          );
          return full
            ? {
                pipelineId: full.id,
                pipelineName: full.name,
                sql: full.sql,
                status: full.status,
                tables: toTables(full.tables),
                createdAt: full.createdAt,
                accountId: acct,
              }
            : undefined;
        }),
      };
    }),
  );
