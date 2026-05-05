import type { Cluster } from "../AWS/EKS/Cluster.ts";
import { metadataWithNamespace } from "./common.ts";
import { Object, type ObjectRef } from "./Object.ts";

export interface ImagePullSecretRef {
  name: string;
}

export interface ServiceAccountProps {
  /**
   * Target EKS cluster.
   */
  cluster: Cluster;
  /**
   * Namespace name or namespace helper result.
   */
  namespace: string | { name: string } | ObjectRef;
  /**
   * Optional explicit service account name. Defaults to the logical id.
   */
  name?: string;
  /**
   * Service account labels.
   */
  labels?: Record<string, string>;
  /**
   * Service account annotations. Common use: `eks.amazonaws.com/role-arn` to
   * bind an IAM role for service accounts (IRSA).
   */
  annotations?: Record<string, string>;
  /**
   * Whether pods using this service account should automatically have a token
   * mounted at `/var/run/secrets/kubernetes.io/serviceaccount/`.
   *
   * Set to `false` for service accounts that only exist to satisfy IRSA — the
   * pod uses the projected token for AWS auth and doesn't need a Kubernetes
   * API token.
   *
   * @default true (Kubernetes default)
   */
  automountServiceAccountToken?: boolean;
  /**
   * References to `Secret`s of type `kubernetes.io/dockerconfigjson` that the
   * kubelet should use to pull images for pods running as this service
   * account. The referenced secrets must already exist in the same namespace.
   */
  imagePullSecrets?: ReadonlyArray<ImagePullSecretRef>;
}

/**
 * A Kubernetes service account bound to an EKS cluster.
 *
 * Service accounts are reconciled via server-side apply. Tokens (the
 * auto-mounted `Secret` objects) are managed by the kube-controller-manager
 * and are intentionally not part of the Alchemy-owned field set — Alchemy
 * does not delete or rotate them.
 *
 * @example Create a service account
 * ```typescript
 * const sa = yield* ServiceAccount("api", {
 *   cluster,
 *   namespace: "default",
 * });
 * ```
 *
 * @example IRSA-bound service account with token mounting disabled
 * ```typescript
 * const sa = yield* ServiceAccount("api", {
 *   cluster,
 *   namespace: "default",
 *   annotations: {
 *     "eks.amazonaws.com/role-arn":
 *       "arn:aws:iam::111122223333:role/api-irsa",
 *   },
 *   automountServiceAccountToken: false,
 * });
 * ```
 *
 * @example Service account with image pull secrets
 * ```typescript
 * const sa = yield* ServiceAccount("api", {
 *   cluster,
 *   namespace: "default",
 *   imagePullSecrets: [{ name: "ghcr-pull" }],
 * });
 * ```
 */
export const ServiceAccount = (id: string, props: ServiceAccountProps) =>
  Object(id, {
    cluster: props.cluster,
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: metadataWithNamespace(props.namespace, {
      name: props.name,
      labels: props.labels,
      annotations: props.annotations,
    }),
    body: {
      automountServiceAccountToken: props.automountServiceAccountToken,
      imagePullSecrets:
        props.imagePullSecrets && props.imagePullSecrets.length > 0
          ? props.imagePullSecrets.map((ref) => ({ name: ref.name }))
          : undefined,
    },
  });
