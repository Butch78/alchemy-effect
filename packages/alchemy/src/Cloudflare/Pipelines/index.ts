// Re-export the user-facing Pipelines surface flat from `Cloudflare/index.ts`.
// `SinkResource` is intentionally excluded — `Sink.Resource` is reachable for
// internal `Provider.collection` registration via the explicit file import in
// `Cloudflare/Providers.ts`.

export {
  Pipeline,
  PipelineProvider,
  pipelineSql,
  isPipeline,
  type PipelineProps,
  type PipelineTableInfo,
} from "./Pipeline.ts";
export {
  Sink,
  SinkProvider,
  isSink,
  type R2DataCatalogSinkProps,
  type R2SinkProps,
  type SinkBucketRef,
  type SinkDataCatalogCredentials,
  type SinkDataCatalogFormat,
  type SinkFileNaming,
  type SinkPartitioning,
  type SinkProps,
  type SinkR2Credentials,
  type SinkR2Format,
  type SinkRollingPolicy,
} from "./Sink.ts";
export {
  Stream,
  StreamProvider,
  isStream,
  type StreamFormat,
  type StreamHttpSettings,
  type StreamProps,
  type StreamSchema,
  type StreamWorkerBindingSettings,
} from "./Stream.ts";
export {
  StreamBinding,
  StreamBindingLive,
  StreamBindingPolicy,
  StreamBindingPolicyLive,
  StreamSendError,
  type PipelinesSendBinding,
  type StreamSender,
} from "./StreamBinding.ts";
// Schema brand helpers (`Int32` / `Int64` / `Float32` / `Float64` / `Timestamp`)
// live in `Cloudflare/SQL.ts` — re-import them as
//   `import * as SQL from "alchemy/Cloudflare/SQL"`.
export {
  UnsupportedStreamSchemaNode,
  compileStreamSchema,
  type StreamSchemaField,
  type StreamSchemaFieldList,
  type StreamSchemaInput,
} from "./StreamSchema.ts";
