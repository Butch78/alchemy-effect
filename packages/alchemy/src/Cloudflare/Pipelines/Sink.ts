import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as StreamE from "effect/Stream";
import * as crypto from "node:crypto";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  AccountApiToken,
  type AccountApiToken as AccountApiTokenT,
} from "../ApiToken/AccountApiToken.ts";
import type { ApiTokenPolicy } from "../ApiToken/Common.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { isR2Bucket, type R2Bucket } from "../R2/R2Bucket.ts";

// The `Input` wrapping (`Output | Effect | T`) is applied automatically by
// the `Resource(...)(props)` constructor — props here are declared with
// plain values, and the engine resolves them before they reach `reconcile`.

export const isSink = (value: unknown): value is Sink =>
  typeof value === "object" &&
  (value as any)?.Type === "Cloudflare.PipelinesSink";

/** A Cloudflare R2 bucket reference accepted by {@link SinkProps}. */
export type SinkBucketRef = R2Bucket | string;

/** Output format for files written by an R2 sink. */
export type SinkR2Format =
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

/** Output format for files written by an R2 Data Catalog sink (parquet only). */
export type SinkDataCatalogFormat = {
  type: "parquet";
  compression?: "uncompressed" | "snappy" | "gzip" | "zstd" | "lz4";
  rowGroupBytes?: number;
};

/** R2 sink file-naming policy. */
export type SinkFileNaming = {
  prefix?: string;
  strategy?: "serial" | "uuid" | "uuid_v7" | "ulid";
  suffix?: string;
};

/** R2 sink time-bucket partitioning. */
export type SinkPartitioning = {
  /** strftime-style time pattern, e.g. `year=%Y/month=%m/day=%d`. */
  timePattern?: string;
};

/** Rolling policy controlling when a new file is written. */
export type SinkRollingPolicy = {
  fileSizeBytes?: number;
  inactivitySeconds?: number;
  intervalSeconds?: number;
};

/** Credentials accepted by an R2 sink — auto-provisioned when omitted. */
export type SinkR2Credentials = {
  /**
   * S3-style access key id. The access-key portion is technically not
   * sensitive on its own, but we still wrap it in `Redacted` to keep both
   * halves of the credential out of plaintext logs / state.
   */
  accessKeyId: Redacted.Redacted<string>;
  /** S3-style secret access key. */
  secretAccessKey: Redacted.Redacted<string>;
};

/** Credentials accepted by an R2 Data Catalog sink — auto-provisioned when omitted. */
export type SinkDataCatalogCredentials = {
  /** Bearer token for the catalog API. */
  token: Redacted.Redacted<string>;
};

export type R2SinkProps = {
  type: "r2";
  /** Target R2 bucket — pass an {@link R2Bucket} resource or a bucket name. */
  bucket: SinkBucketRef;
  /**
   * Sink name. If omitted, a unique name is generated.
   * @default ${app}_${stage}_${id}
   */
  name?: string;
  /** R2 jurisdiction (defaults to `default`). */
  jurisdiction?: "default" | "eu" | "fedramp";
  /** Path prefix written under the bucket. */
  path?: string;
  /** File naming policy. */
  fileNaming?: SinkFileNaming;
  /** Time-bucket partitioning. */
  partitioning?: SinkPartitioning;
  /** Rolling policy controlling when a new file is written. */
  rollingPolicy?: SinkRollingPolicy;
  /** Output format. */
  format?: SinkR2Format;
  /**
   * Explicit S3-style credentials. Required when `bucket` is a bucket name.
   * When `bucket` is an {@link R2Bucket} resource and these are omitted, an
   * {@link AccountApiToken} is auto-provisioned and the derived S3 creds
   * (access key = token id, secret = sha256(token value)) are used.
   */
  credentials?: SinkR2Credentials;
};

export type R2DataCatalogSinkProps = {
  type: "r2_data_catalog";
  /** Target R2 bucket — pass an {@link R2Bucket} resource or a bucket name. */
  bucket: SinkBucketRef;
  /** Iceberg table name. */
  tableName: string;
  /** Iceberg namespace. */
  namespace?: string;
  /**
   * Sink name. If omitted, a unique name is generated.
   * @default ${app}_${stage}_${id}
   */
  name?: string;
  /** Rolling policy controlling when a new file is written. */
  rollingPolicy?: SinkRollingPolicy;
  /** Output format. R2 Data Catalog only supports `parquet`. */
  format?: SinkDataCatalogFormat;
  /**
   * Explicit catalog API token. Required when `bucket` is a bucket name.
   * When `bucket` is an {@link R2Bucket} resource and this is omitted, an
   * {@link AccountApiToken} with `Workers R2 Data Catalog Write` is
   * auto-provisioned.
   */
  credentials?: SinkDataCatalogCredentials;
};

/**
 * Discriminated props for a Cloudflare Pipelines {@link Sink}. Sinks are
 * **immutable** in Cloudflare's API — any prop change triggers a replace.
 */
export type SinkProps = R2SinkProps | R2DataCatalogSinkProps;

export type Sink = Resource<
  "Cloudflare.PipelinesSink",
  SinkProps,
  {
    sinkId: string;
    sinkName: string;
    /** `"r2"` for a raw-files sink, `"r2_data_catalog"` for an Iceberg sink. */
    sinkType: "r2" | "r2_data_catalog";
    createdAt: string;
    accountId: string;
  },
  never,
  Providers
>;

const SinkResource = Resource<Sink>("Cloudflare.PipelinesSink");

/**
 * A Cloudflare Pipelines Sink — the destination a {@link Pipeline} writes to.
 * Supports two flavors: raw files (`r2`) written to an R2 bucket, and Iceberg
 * tables (`r2_data_catalog`) in R2 Data Catalog.
 *
 * Sinks are immutable: any prop change triggers a replace.
 *
 * When `bucket` is an {@link R2Bucket} resource and no `credentials` are
 * supplied, a scoped {@link AccountApiToken} is auto-provisioned and the
 * sink's credentials are derived from it (S3 creds for `r2`, bearer token
 * for `r2_data_catalog`).
 *
 * @section Creating a Sink
 * @example R2 sink (auto-provisioned credentials)
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("Lake");
 * const sink = yield* Cloudflare.Sink("Files", {
 *   type: "r2",
 *   bucket,
 *   format: { type: "parquet", compression: "zstd" },
 * });
 * ```
 *
 * @example R2 Data Catalog sink (Apache Iceberg)
 * ```typescript
 * const sink = yield* Cloudflare.Sink("Lakehouse", {
 *   type: "r2_data_catalog",
 *   bucket,
 *   namespace: "analytics",
 *   tableName: "events",
 * });
 * ```
 *
 * @example Explicit credentials
 * Pass `credentials` alongside a bucket-name string to skip auto-provisioning.
 * Wrap both halves in `Redacted` so the secret never leaks to logs.
 * ```typescript
 * const sink = yield* Cloudflare.Sink("Files", {
 *   type: "r2",
 *   bucket: "my-bucket",
 *   credentials: {
 *     accessKeyId: Redacted.make(env.ACCESS_KEY),
 *     secretAccessKey: Redacted.make(env.SECRET),
 *   },
 * });
 * ```
 */
export const Sink: {
  <Req = never>(
    id: string,
    props:
      | InputProps<SinkProps>
      | Effect.Effect<InputProps<SinkProps>, never, Req>,
  ): Effect.Effect<Sink, never, Req | Providers>;
  /** @internal — exposed for `Provider.collection` registration only. */
  Resource: typeof SinkResource;
} = Object.assign(
  ((id: string, propsEff: any) =>
    Effect.gen(function* () {
      const props = Effect.isEffect(propsEff)
        ? ((yield* propsEff) as InputProps<SinkProps>)
        : (propsEff as InputProps<SinkProps>);

      if (props.credentials) {
        return yield* SinkResource("Sink", props as any);
      }
      if (typeof props.bucket === "string" || !isR2Bucket(props.bucket)) {
        return yield* Effect.die(
          `Cloudflare.Sink("${id}"): explicit credentials are required when ` +
            `bucket is a plain string. Pass an R2Bucket resource to ` +
            `auto-provision an AccountApiToken instead.`,
        );
      }
      const { accountId } = yield* CloudflareEnvironment;
      if (props.type === "r2") {
        const token = yield* AccountApiToken("Token", {
          policies: r2StoragePolicies(accountId),
        });
        return yield* SinkResource("Sink", {
          ...props,
          credentials: deriveR2Credentials(token),
        } as any);
      }
      const token = yield* AccountApiToken("Token", {
        policies: dataCatalogPolicies(accountId),
      });
      return yield* SinkResource("Sink", {
        ...props,
        credentials: { token: token.value },
      } as any);
    }).pipe(Namespace.push(id))) as any,
  { Resource: SinkResource },
);

const createSinkName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return (yield* createPhysicalName({ id, maxLength: 63 }))
      .toLowerCase()
      .replace(/-/g, "_");
  });

const findSinkByName = (accountId: string, name: string) =>
  pipelines.listSinks.items({ accountId }).pipe(
    StreamE.filter((s) => s.name === name),
    StreamE.runHead,
    Effect.map(Option.getOrUndefined),
  );

const sha256Hex = (input: string): string =>
  crypto.createHash("sha256").update(input).digest("hex");

const r2StoragePolicies = (accountId: string): ApiTokenPolicy[] => [
  {
    effect: "allow",
    permissionGroups: ["Workers R2 Storage Write", "Workers R2 Storage Read"],
    resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
  },
];

const dataCatalogPolicies = (accountId: string): ApiTokenPolicy[] => [
  {
    effect: "allow",
    permissionGroups: [
      "Workers R2 Data Catalog Write",
      "Workers R2 Data Catalog Read",
      "Workers R2 Storage Write",
      "Workers R2 Storage Read",
    ],
    resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
  },
];

/**
 * Derive S3-style credentials from an {@link AccountApiToken}'s outputs:
 * `accessKeyId = token.tokenId`, `secretAccessKey = sha256(token.value)`.
 * Both halves are wrapped in {@link Redacted} so the values never leak to
 * logs or alchemy state outside the runtime context.
 *
 * The returned values are `Output<Redacted<string>>` — valid `Input<>`
 * values that the Resource constructor unwraps before they reach the
 * provider's `reconcile` hook.
 */
const deriveR2Credentials = (
  token: AccountApiTokenT,
): InputProps<SinkR2Credentials> => ({
  accessKeyId: token.tokenId.pipe(Output.map((id) => Redacted.make(id))),
  secretAccessKey: token.value.pipe(
    Output.map((value) => Redacted.make(sha256Hex(Redacted.value(value)))),
  ),
});

const resolveBucketName = (bucket: SinkBucketRef): string => {
  if (typeof bucket === "string") return bucket;
  return (bucket as any).bucketName as string;
};

const resolveJurisdiction = (
  bucket: SinkBucketRef,
  override: string | undefined,
): string | undefined => {
  if (override) return override;
  if (typeof bucket === "string") return undefined;
  const j = (bucket as any).jurisdiction as string | undefined;
  return j === "default" ? undefined : j;
};

const buildCreateRequest = (
  accountId: string,
  name: string,
  props: SinkProps,
): pipelines.CreateSinkRequest => {
  if (props.type === "r2") {
    if (!props.credentials) {
      throw new Error(
        `Cloudflare.Sink("${name}"): unresolved credentials at create time`,
      );
    }
    return {
      accountId,
      name,
      type: "r2",
      config: {
        accountId,
        bucket: resolveBucketName(props.bucket),
        credentials: {
          accessKeyId: Redacted.value(props.credentials.accessKeyId),
          secretAccessKey: Redacted.value(props.credentials.secretAccessKey),
        },
        jurisdiction: resolveJurisdiction(props.bucket, props.jurisdiction),
        path: props.path,
        fileNaming: props.fileNaming,
        partitioning: props.partitioning,
        rollingPolicy: props.rollingPolicy,
      },
      format: props.format as pipelines.CreateSinkRequest["format"],
    };
  }
  // r2_data_catalog
  if (!props.credentials) {
    throw new Error(
      `Cloudflare.Sink("${name}"): unresolved catalog token at create time`,
    );
  }
  return {
    accountId,
    name,
    type: "r2_data_catalog",
    config: {
      accountId,
      bucket: resolveBucketName(props.bucket),
      tableName: props.tableName,
      namespace: props.namespace,
      token: Redacted.value(props.credentials.token),
      rollingPolicy: props.rollingPolicy,
    },
    format: props.format as pipelines.CreateSinkRequest["format"],
  };
};

const sinkPropsFingerprint = (props: SinkProps | undefined): string =>
  JSON.stringify({
    type: props?.type,
    // Bucket may be a resource ref or string; serialize by bucketName.
    bucket:
      typeof (props as any)?.bucket === "string"
        ? (props as any).bucket
        : (props as any)?.bucket?.bucketName,
    rest:
      props?.type === "r2"
        ? {
            jurisdiction: props.jurisdiction,
            path: props.path,
            fileNaming: props.fileNaming,
            partitioning: props.partitioning,
            rollingPolicy: props.rollingPolicy,
            format: props.format,
          }
        : props?.type === "r2_data_catalog"
          ? {
              tableName: props.tableName,
              namespace: props.namespace,
              rollingPolicy: props.rollingPolicy,
              format: props.format,
            }
          : {},
  });

export const SinkProvider = () =>
  Provider.effect(
    SinkResource,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createSink = yield* pipelines.createSink;
      const getSink = yield* pipelines.getSink;
      const deleteSink = yield* pipelines.deleteSink;

      return {
        stables: ["sinkId", "sinkName", "sinkType", "accountId"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const newName = yield* createSinkName(id, (news as SinkProps).name);
          const oldName =
            output?.sinkName ??
            (yield* createSinkName(id, (olds as SinkProps).name));
          if (newName !== oldName) {
            return { action: "replace" } as const;
          }
          if (
            !deepEqual(
              sinkPropsFingerprint(olds as SinkProps),
              sinkPropsFingerprint(news as SinkProps),
            )
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const acct = output?.accountId ?? accountId;
          const props = news as SinkProps;
          const name = yield* createSinkName(id, props.name);

          // Observe — cached id, fall back to name scan.
          let observed: pipelines.GetSinkResponse | undefined;
          if (output?.sinkId) {
            observed = yield* getSink({
              accountId: acct,
              sinkId: output.sinkId,
            }).pipe(
              Effect.catchTag("SinkNotFound", () => Effect.succeed(undefined)),
              Effect.catchTag("InvalidSinkId", () => Effect.succeed(undefined)),
            );
          }
          if (!observed) {
            const match = yield* findSinkByName(acct, name);
            if (match) {
              observed = yield* getSink({
                accountId: acct,
                sinkId: match.id,
              }).pipe(
                Effect.catchTag("SinkNotFound", () =>
                  Effect.succeed(undefined),
                ),
              );
            }
          }

          // Ensure — sinks are immutable. The diff function flagged any
          // mutation as a replace, so we only land here on first create or
          // crash-recovery from a peer reconciler.
          if (!observed) {
            const created = yield* createSink(
              buildCreateRequest(acct, name, props),
            ).pipe(
              Effect.catchTag("SinkAlreadyExists", () =>
                Effect.gen(function* () {
                  const match = yield* findSinkByName(acct, name);
                  if (!match) {
                    return yield* Effect.die(
                      `Cloudflare reported sink "${name}" already exists ` +
                        `but listSinks returned none. Retry the deploy.`,
                    );
                  }
                  return yield* getSink({
                    accountId: acct,
                    sinkId: match.id,
                  });
                }),
              ),
            );
            observed = yield* getSink({
              accountId: acct,
              sinkId: created.id,
            }).pipe(
              Effect.catchTag("SinkNotFound", () => Effect.succeed(created)),
            );
          }

          return {
            sinkId: observed.id,
            sinkName: observed.name,
            sinkType: (observed.type === "r2_data_catalog"
              ? "r2_data_catalog"
              : "r2") as "r2" | "r2_data_catalog",
            createdAt: observed.createdAt,
            accountId: acct,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Sinks are idempotent on delete (Cloudflare returns success for
          // a missing id). The engine deletes dependent pipelines first via
          // the dependency graph, so we never need `force:"true"`.
          yield* deleteSink({
            accountId: output.accountId,
            sinkId: output.sinkId,
          });
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.sinkId) return undefined;
          return yield* getSink({
            accountId: output.accountId,
            sinkId: output.sinkId,
          }).pipe(
            Effect.map((s) => ({
              sinkId: s.id,
              sinkName: s.name,
              sinkType: (s.type === "r2_data_catalog"
                ? "r2_data_catalog"
                : "r2") as "r2" | "r2_data_catalog",
              createdAt: s.createdAt,
              accountId: output.accountId,
            })),
            Effect.catchTag("SinkNotFound", () => Effect.succeed(undefined)),
            Effect.catchTag("InvalidSinkId", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
