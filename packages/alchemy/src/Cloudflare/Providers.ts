import { Retry } from "@distilled.cloud/cloudflare";
import { CloudflareHttpError } from "@distilled.cloud/cloudflare/Errors";
import {
  Forbidden,
  TooManyRequests,
  Unauthorized,
} from "@distilled.cloud/core/errors";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

const isForbidden = Schema.is(Forbidden);
const isUnauthorized = Schema.is(Unauthorized);
const isCloudflareHttpError = Schema.is(CloudflareHttpError);
const isTooManyRequests = Schema.is(TooManyRequests);
import { Command } from "../Build/Command.ts";
import * as Build from "../Build/index.ts";
import * as Provider from "../Provider.ts";
import { Random, RandomProvider } from "../Random.ts";
import * as Access from "./Access.ts";
import * as AiGateway from "./AiGateway/index.ts";
import * as ApiToken from "./ApiToken/index.ts";
import * as Artifacts from "./Artifacts/index.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import * as Containers from "./Container/index.ts";
import * as Credentials from "./Credentials.ts";
import * as D1 from "./D1/index.ts";
import * as Hyperdrive from "./Hyperdrive/index.ts";
import * as KV from "./KV/index.ts";
import * as Queue from "./Queue/index.ts";
import * as R2 from "./R2/index.ts";
import * as SecretsStore from "./SecretsStore/index.ts";
import * as Tunnel from "./Tunnel/index.ts";
import * as VpcService from "./VpcService/index.ts";
import * as Workers from "./Workers/index.ts";
import * as Workflows from "./Workers/Workflow.ts";

export { Credentials } from "@distilled.cloud/cloudflare/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Cloudflare",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Cloudflare providers, bindings, and credentials for Worker-based stacks.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      ApiToken.AccountApiToken,
      ApiToken.UserApiToken,
      AiGateway.AiGateway,
      AiGateway.AiGatewayBindingPolicy,
      Artifacts.ArtifactsBindingPolicy,
      Command,
      Containers.Container,
      D1.D1ConnectionPolicy,
      D1.D1Database,
      Hyperdrive.Hyperdrive,
      Hyperdrive.HyperdriveBindingPolicy,
      KV.KVNamespace,
      KV.KVNamespaceBindingPolicy,
      Queue.Queue,
      Queue.QueueBindingPolicy,
      Queue.QueueConsumer,
      Queue.QueueEventSourcePolicy,
      R2.R2Bucket,
      R2.R2BucketBindingPolicy,
      SecretsStore.SecretBindingPolicy,
      SecretsStore.SecretsStore,
      SecretsStore.Secret,
      Tunnel.Tunnel,
      VpcService.VpcService,
      Random,
      Workers.BindWorkerPolicy,
      Workers.FetchPolicy,
      Workers.Worker,
      Workflows.WorkflowResource,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApiToken.AccountApiTokenProvider(),
        ApiToken.UserApiTokenProvider(),
        AiGateway.AiGatewayProvider(),
        AiGateway.AiGatewayBindingPolicyLive,
        Artifacts.ArtifactsBindingPolicyLive,
        Containers.ContainerProvider(),
        D1.D1ConnectionPolicyLive,
        D1.DatabaseProvider(),
        Hyperdrive.HyperdriveBindingPolicyLive,
        Hyperdrive.HyperdriveProvider(),
        KV.KVNamespaceBindingPolicyLive,
        KV.KVNamespaceProvider(),
        Queue.QueueBindingPolicyLive,
        Queue.QueueEventSourcePolicyLive,
        Queue.QueueProvider(),
        Queue.QueueConsumerProvider(),
        R2.R2BucketBindingPolicyLive,
        R2.R2BucketProvider(),
        SecretsStore.SecretBindingPolicyLive,
        SecretsStore.SecretsStoreProvider(),
        SecretsStore.StoreSecretProvider(),
        Tunnel.TunnelProvider(),
        VpcService.VpcServiceProvider(),
        Workers.BindWorkerPolicyLive,
        Workers.FetchPolicyLive,
        Workers.WorkerProvider(),
        Workflows.WorkflowProvider(),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(Build.CommandProvider(), RandomProvider()),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(CloudflareEnvironment.fromProfile()),
    Layer.provideMerge(CloudflareAuth),
    Layer.provideMerge(Access.AccessLive),
    // Apply a blanket retry policy to every Cloudflare API call. Extends
    // `Retry.makeDefault`'s transient detection (throttling / 5xx /
    // network) with one Cloudflare-specific misleadingly-tagged
    // transient case the SDK doesn't yet mark retryable — see
    // `cloudflareRetryFactory` below. Without this, the matching brief
    // CF infrastructure blips surface as test failures and resource
    // leaks.
    //
    // Deliberately narrow: we ONLY add cases where the message
    // unambiguously indicates a transient infrastructure failure (not
    // a real auth/permission failure). Auto-retrying ambiguous cases
    // like `Unauthorized: Authentication error` would silently loop on
    // genuinely invalid tokens.
    //
    // TODO(distilled): once
    // https://github.com/alchemy-run/distilled/pull/233 lands, this
    // wrapper can collapse back to `Retry.makeDefault`.
    Layer.provideMerge(Layer.succeed(Retry.Retry, cloudflareRetryFactory)),
    Layer.orDie,
  );

const isMisleadinglyTaggedTransient = (error: unknown): boolean => {
  // CF code 10001: "Method not allowed for token" is a real permission
  // failure (NOT retryable), but the same code is also returned with
  // message "internal error" during Cloudflare-side hiccups. The two
  // messages are unambiguously distinct, so we can safely retry only
  // the internal-error variant.
  if (isForbidden(error) && /internal error/i.test(error.message)) return true;
  // `CloudflareHttpError` is the catch-all distilled raises when CF
  // returns a non-JSON body (HTML 520 pages, edge auth blips that
  // produce a bare `Unauthorized`, etc.). 401/403/5xx of this shape
  // are not API-level permission failures — they're CF-edge transients
  // that consistently clear within a few seconds. Retry them.
  if (
    isCloudflareHttpError(error) &&
    (error.status === 401 || error.status === 403 || error.status >= 500)
  ) {
    return true;
  }
  // CF code 10000 maps to `Unauthorized: Authentication error`. Distilled
  // deliberately doesn't auto-retry — the same code+message is used for
  // both transient auth-edge blips and a genuinely invalid token, so a
  // long retry would silently loop on real auth failures. We still
  // retry it here, but the surrounding schedule's `recurs(8)` cap means
  // a genuinely-invalid token surfaces within ~22s — acceptable.
  if (isUnauthorized(error)) return true;
  return false;
};

const cloudflareRetryFactory: Retry.Factory = (lastError) => {
  const defaults = Retry.makeDefault(lastError);
  return {
    while: (error) =>
      defaults.while?.(error) === true || isMisleadinglyTaggedTransient(error),
    schedule: pipe(
      Schedule.exponential(Duration.millis(250), 2),
      Schedule.modifyDelay(
        Effect.fnUntraced(function* (duration) {
          const error = yield* Ref.get(lastError);
          // Throttling errors (429): honor a 500ms floor matching the
          // distilled default.
          if (isTooManyRequests(error) && Duration.toMillis(duration) < 500) {
            return Duration.toMillis(Duration.millis(500));
          }
          return Duration.toMillis(duration);
        }),
      ),
      Retry.capped(Duration.seconds(5)),
      Retry.jittered,
      Schedule.both(Schedule.recurs(8)),
    ),
  };
};
