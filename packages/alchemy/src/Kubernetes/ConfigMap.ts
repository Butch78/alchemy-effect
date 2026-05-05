import type { Cluster } from "../AWS/EKS/Cluster.ts";
import { metadataWithNamespace } from "./common.ts";
import { Object, type ObjectRef } from "./Object.ts";

export interface ConfigMapProps {
  /**
   * Target EKS cluster.
   */
  cluster: Cluster;
  /**
   * Namespace name or namespace helper result.
   */
  namespace: string | { name: string } | ObjectRef;
  /**
   * Optional explicit config map name. Defaults to the logical id.
   */
  name?: string;
  /**
   * Config map UTF-8 string data, keyed by file name.
   */
  data?: Record<string, string>;
  /**
   * Config map binary data, keyed by file name. Values must be base64-encoded.
   *
   * Useful for embedding non-UTF-8 payloads (e.g. images, certificates) that
   * `data` cannot represent without corruption.
   */
  binaryData?: Record<string, string>;
  /**
   * If `true`, the config map is marked immutable on the API server. Subsequent
   * updates that change `data`/`binaryData` will be rejected by Kubernetes —
   * the only way to change values is to delete and recreate. Use for
   * high-fan-out config maps where reduced kubelet watch load matters.
   *
   * @default false
   */
  immutable?: boolean;
  /**
   * Config map labels.
   */
  labels?: Record<string, string>;
  /**
   * Config map annotations.
   */
  annotations?: Record<string, string>;
}

/**
 * A Kubernetes config map bound to an EKS cluster.
 *
 * The config map is reconciled via server-side apply, so re-deploying the
 * same `data` is a true no-op at the API server. Out-of-band edits (e.g. an
 * operator that runs `kubectl edit configmap`) are reverted on the next
 * reconcile because Alchemy's `fieldManager=alchemy` re-asserts ownership of
 * the keys it manages.
 *
 * @example Create a config map
 * ```typescript
 * const config = yield* ConfigMap("app-config", {
 *   cluster,
 *   namespace: "default",
 *   data: {
 *     LOG_LEVEL: "debug",
 *   },
 * });
 * ```
 *
 * @example Immutable config map
 * ```typescript
 * const config = yield* ConfigMap("release-pin", {
 *   cluster,
 *   namespace: "default",
 *   immutable: true,
 *   data: { release: "v1.2.3" },
 * });
 * ```
 */
export const ConfigMap = (id: string, props: ConfigMapProps) =>
  Object(id, {
    cluster: props.cluster,
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: metadataWithNamespace(props.namespace, {
      name: props.name,
      labels: props.labels,
      annotations: props.annotations,
    }),
    body: {
      data: props.data,
      binaryData: props.binaryData,
      immutable: props.immutable,
    },
  });
