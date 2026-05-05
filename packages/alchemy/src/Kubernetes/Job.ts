import type { Cluster } from "../AWS/EKS/Cluster.ts";
import { metadataWithNamespace, objectNameOf } from "./common.ts";
import { Object, type ObjectRef } from "./Object.ts";
import type { ContainerSpec } from "./Deployment.ts";

export interface JobProps {
  /**
   * Target EKS cluster.
   */
  cluster: Cluster;
  /**
   * Namespace name or namespace helper result.
   */
  namespace: string | { name: string } | ObjectRef;
  /**
   * Optional explicit job name. Defaults to the logical id.
   *
   * Note: most fields under `spec` are immutable on a Kubernetes Job. Changing
   * `containers`, `restartPolicy`, `parallelism`/`completions` schedules a
   * replacement: Alchemy deletes the old Job (with `propagationPolicy:
   * Background`, which also reaps the managed Pods) and applies a new one.
   */
  name?: string;
  /**
   * Job labels.
   */
  labels?: Record<string, string>;
  /**
   * Job annotations.
   */
  annotations?: Record<string, string>;
  /**
   * Restart policy for pods.
   *
   * @default "Never"
   */
  restartPolicy?: "Never" | "OnFailure";
  /**
   * Service account name for the pod template.
   */
  serviceAccountName?: string | { name: string } | ObjectRef;
  /**
   * Pod containers.
   */
  containers: ContainerSpec[];
  /**
   * Number of pods to run in parallel.
   *
   * @default 1
   */
  parallelism?: number;
  /**
   * Number of successful pod completions required before the Job is marked
   * complete. Omit for a non-indexed Job that completes after a single
   * success.
   */
  completions?: number;
  /**
   * Maximum number of retries before the Job is marked failed.
   *
   * @default 6 (Kubernetes default)
   */
  backoffLimit?: number;
  /**
   * Hard wall-clock deadline (in seconds). The Job is failed once the
   * cumulative running time of its pods exceeds this.
   */
  activeDeadlineSeconds?: number;
  /**
   * TTL (in seconds) after a Job reaches a terminal state, after which the
   * Job and its pods are garbage collected by the TTL controller. Setting
   * this lets the cluster clean up completed Jobs without Alchemy having to
   * tear them down.
   */
  ttlSecondsAfterFinished?: number;
}

/**
 * A Kubernetes job bound to an EKS cluster.
 *
 * Most of `spec` is immutable on the API server: changing the container image,
 * command, parallelism, completions, etc. cannot be applied in place.
 * Alchemy detects this on reconcile via the standard reconcile-then-apply
 * flow — the API server returns 422 Invalid for the prohibited mutation, at
 * which point the operator should either bump the Job's logical id (which
 * generates a new physical name), explicitly delete the existing Job, or
 * rely on `ttlSecondsAfterFinished` to age it out.
 *
 * @example Run a one-shot job
 * ```typescript
 * const job = yield* Job("seed", {
 *   cluster,
 *   namespace: "default",
 *   containers: [
 *     {
 *       name: "seed",
 *       image: "busybox:latest",
 *       command: ["/bin/sh", "-lc"],
 *       args: ["echo hello"],
 *     },
 *   ],
 * });
 * ```
 *
 * @example Auto-cleaned, parallel job
 * ```typescript
 * const job = yield* Job("backfill", {
 *   cluster,
 *   namespace: "default",
 *   parallelism: 4,
 *   completions: 16,
 *   backoffLimit: 2,
 *   ttlSecondsAfterFinished: 3600,
 *   containers: [
 *     { name: "worker", image: "ghcr.io/example/backfill:1.2.3" },
 *   ],
 * });
 * ```
 */
export const Job = (id: string, props: JobProps) =>
  Object(id, {
    cluster: props.cluster,
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: metadataWithNamespace(props.namespace, {
      name: props.name,
      labels: props.labels,
      annotations: props.annotations,
    }),
    body: {
      spec: {
        parallelism: props.parallelism,
        completions: props.completions,
        backoffLimit: props.backoffLimit,
        activeDeadlineSeconds: props.activeDeadlineSeconds,
        ttlSecondsAfterFinished: props.ttlSecondsAfterFinished,
        template: {
          metadata: {
            labels: props.labels,
          },
          spec: {
            restartPolicy: props.restartPolicy ?? "Never",
            serviceAccountName: props.serviceAccountName
              ? objectNameOf(props.serviceAccountName)
              : undefined,
            containers: props.containers,
          },
        },
      },
    },
  });
