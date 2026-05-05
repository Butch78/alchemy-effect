import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type TunnelProps = {
  /**
   * Name for the tunnel. If omitted, a unique name will be generated.
   *
   * Tunnel names are immutable -- changing the name triggers replacement.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Secret used by the tunnel connector. If omitted, Cloudflare generates one.
   * Must be at least 32 bytes encoded as base64.
   */
  tunnelSecret?: Redacted.Redacted<string>;
  /**
   * Where the tunnel configuration lives.
   * - `"cloudflare"` - managed remotely via the API (default)
   * - `"local"` - managed via a YAML file on the origin
   *
   * @default "cloudflare"
   */
  configSrc?: "cloudflare" | "local";
  /**
   * Ingress rules describing how requests are routed. Must end with a
   * catch-all rule (e.g. `{ service: "http_status:404" }`). Only honored when
   * `configSrc` is `"cloudflare"`.
   */
  ingress?: Tunnel.IngressRule[];
  /**
   * Origin request configuration applied to all rules. Only honored when
   * `configSrc` is `"cloudflare"`.
   */
  originRequest?: Tunnel.OriginRequestConfig;
  /**
   * Whether to adopt an existing tunnel with the same name when create fails.
   *
   * @default false
   */
  adopt?: boolean;
};

export declare namespace Tunnel {
  /**
   * Ingress rule describing how a hostname or path is routed.
   */
  export interface IngressRule {
    hostname?: string;
    service: string;
    path?: string;
    originRequest?: OriginRequestConfig;
  }
  /**
   * Origin request configuration applied per-rule or globally.
   */
  export interface OriginRequestConfig {
    connectTimeout?: number;
    tlsTimeout?: number;
    tcpKeepAlive?: number;
    noHappyEyeballs?: boolean;
    keepAliveConnections?: number;
    keepAliveTimeout?: number;
    http2Origin?: boolean;
    httpHostHeader?: string;
    caPool?: string;
    noTLSVerify?: boolean;
    disableChunkedEncoding?: boolean;
    proxyType?: string;
    matchSNItoHost?: boolean;
    originServerName?: string;
  }
}

export type Tunnel = Resource<
  "Cloudflare.Tunnel",
  TunnelProps,
  {
    tunnelId: string;
    tunnelName: string;
    accountTag: string | undefined;
    accountId: string;
    createdAt: string | undefined;
    deletedAt: string | undefined;
    configSrc: "cloudflare" | "local";
    token: Redacted.Redacted<string>;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Tunnel that establishes a secure connection from your origin to
 * Cloudflare's edge.
 *
 * @section Creating a Tunnel
 * @example Basic tunnel
 * ```typescript
 * const tunnel = yield* Cloudflare.Tunnel("MyTunnel");
 * // Run the connector with: cloudflared tunnel run --token <Redacted.value(tunnel.token)>
 * ```
 *
 * @example Tunnel with ingress rules
 * ```typescript
 * const tunnel = yield* Cloudflare.Tunnel("Web", {
 *   ingress: [
 *     { hostname: "app.example.com", service: "http://localhost:3000" },
 *     { service: "http_status:404" },
 *   ],
 * });
 * ```
 */
export const Tunnel = Resource<Tunnel>("Cloudflare.Tunnel");

export const TunnelProvider = () =>
  Provider.effect(
    Tunnel,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createTunnel = yield* zeroTrust.createTunnelCloudflared;
      const getTunnel = yield* zeroTrust.getTunnelCloudflared;
      const deleteTunnel = yield* zeroTrust.deleteTunnelCloudflared;
      const putConfiguration =
        yield* zeroTrust.putTunnelCloudflaredConfiguration;
      const getToken = yield* zeroTrust.getTunnelCloudflaredToken;
      const listTunnels = zeroTrust.listTunnels;

      const createTunnelName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return yield* createPhysicalName({ id });
        });

      const writeConfiguration = (
        tunnelId: string,
        ingress: Tunnel.IngressRule[] | undefined,
        originRequest: Tunnel.OriginRequestConfig | undefined,
      ) =>
        Effect.gen(function* () {
          // Always PUT for `cloudflare`-managed tunnels: the API treats
          // the configuration as the canonical state, so an unconditional
          // PUT lets reconcile clear out-of-band drift even when the user
          // removed every ingress rule. An empty `ingress`/`originRequest`
          // gets normalised to `undefined` so the request body matches
          // what `getTunnelCloudflaredConfiguration` will return.
          yield* putConfiguration({
            accountId,
            tunnelId,
            config: {
              ingress: ingress && ingress.length > 0 ? ingress : undefined,
              originRequest,
            },
          });
        });

      const findTunnelByName = (name: string) =>
        listTunnels
          .items({
            accountId,
            name,
            isDeleted: false,
            tunTypes: ["cfd_tunnel"],
          })
          .pipe(
            Stream.filter((t) => t.name === name && !t.deletedAt),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );

      return {
        stables: ["tunnelId", "accountTag", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const name = yield* createTunnelName(id, news.name);
          const oldName = output?.tunnelName
            ? output.tunnelName
            : yield* createTunnelName(id, olds.name);
          if (name !== oldName) {
            return { action: "replace" } as const;
          }
          const oldSecret = olds.tunnelSecret
            ? Redacted.value(olds.tunnelSecret)
            : undefined;
          const newSecret = news.tunnelSecret
            ? Redacted.value(news.tunnelSecret)
            : undefined;
          if (oldSecret !== newSecret) {
            return { action: "replace" } as const;
          }
          if (
            (olds.configSrc ?? "cloudflare") !==
            (news.configSrc ?? "cloudflare")
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const name = yield* createTunnelName(id, news.name);
          const configSrc = news.configSrc ?? output?.configSrc ?? "cloudflare";
          const tunnelSecret = news.tunnelSecret
            ? Redacted.value(news.tunnelSecret)
            : undefined;
          const acct = output?.accountId ?? accountId;

          // Observe — re-fetch the cached tunnel; fall back to a name
          // lookup so we recover from out-of-band deletes or partial
          // state-persistence failures.
          //
          // Scope the catch to `TunnelNotFound` only. A blanket catch
          // would silently treat auth/throttling/5xx failures as "tunnel
          // missing" and drop us straight into a re-create — masking
          // real failures and risking duplicate tunnels.
          let observed:
            | {
                id?: string | null;
                name?: string | null;
                accountTag?: string | null;
                createdAt?: string | null;
                deletedAt?: string | null;
              }
            | undefined;
          if (output?.tunnelId) {
            observed = yield* getTunnel({
              accountId: acct,
              tunnelId: output.tunnelId,
            }).pipe(
              Effect.map(
                (t) => t as typeof observed,
              ),
              Effect.catchTag("TunnelNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
            // A tunnel may also surface from `getTunnel` with a non-null
            // `deletedAt` (Cloudflare retains the record briefly after
            // deletion). Treat that as "missing" so reconcile re-creates.
            if (observed?.deletedAt) {
              observed = undefined;
            }
          }
          if (!observed) {
            observed = yield* findTunnelByName(name);
          }

          // Ensure — create if missing. Cloudflare rejects a duplicate
          // name with `DuplicateTunnelName`; recover by re-listing and
          // adopting the existing tunnel when the caller opted in.
          // All other create errors must surface so transient
          // auth/throttling/5xx don't masquerade as "name conflict".
          if (!observed || !observed.id) {
            observed = yield* createTunnel({
              accountId: acct,
              name,
              configSrc,
              tunnelSecret,
            }).pipe(
              Effect.catchTag("DuplicateTunnelName", (err) =>
                Effect.gen(function* () {
                  // A duplicate-name response without `adopt` is a hard
                  // failure: refusing here prevents accidental
                  // takeover of a foreign tunnel.
                  if (!news.adopt) return yield* Effect.fail(err);
                  const existing = yield* findTunnelByName(name);
                  if (!existing || !existing.id) {
                    return yield* Effect.fail(err);
                  }
                  return existing;
                }),
              ),
            );
          }

          // Sync — when the tunnel is managed in Cloudflare, push the
          // desired ingress + originRequest configuration. The PUT is
          // idempotent: equal payloads converge to the same state, so we
          // always push to apply drift.
          if (configSrc !== "local") {
            yield* writeConfiguration(
              observed.id!,
              news.ingress,
              news.originRequest,
            );
          }

          const token = yield* getToken({
            accountId: acct,
            tunnelId: observed.id!,
          });

          return {
            tunnelId: observed.id!,
            tunnelName: observed.name ?? name,
            accountTag: observed.accountTag ?? undefined,
            accountId: acct,
            createdAt: observed.createdAt ?? undefined,
            deletedAt: observed.deletedAt ?? undefined,
            configSrc,
            token: Redacted.make(token),
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent destroy: a previously-deleted tunnel must not
          // surface as a hard error. Distilled's spec for
          // `deleteTunnelCloudflared` declares no domain errors, so a
          // 404/`code: 1002` lands in `UnknownCloudflareError` instead
          // of a typed `TunnelNotFound`. Filter on `code === 1002` so
          // we only swallow the not-found race; auth/throttling/5xx
          // (and the "tunnel has active connections" failure) still
          // bubble up for the engine to retry.
          yield* deleteTunnel({
            accountId: output.accountId,
            tunnelId: output.tunnelId,
          }).pipe(
            Effect.catchTag("UnknownCloudflareError", (err) =>
              err.code === 1002 ? Effect.void : Effect.fail(err),
            ),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          // Helper — load a token only when the tunnel itself was
          // observed live. Scope the token catch to `TunnelTokenNotFound`
          // (the only API-named error this op exposes besides the
          // shared transport ones) so auth/throttling failures surface
          // to the caller instead of pretending the tunnel doesn't
          // exist.
          const loadToken = (acct: string, tunnelId: string) =>
            getToken({ accountId: acct, tunnelId }).pipe(
              Effect.map(
                (t): Redacted.Redacted<string> | undefined =>
                  Redacted.make(t),
              ),
              Effect.catchTag("TunnelTokenNotFound", () =>
                Effect.succeed(undefined as Redacted.Redacted<string> | undefined),
              ),
            );

          if (output?.tunnelId) {
            const tunnel = yield* getTunnel({
              accountId: output.accountId,
              tunnelId: output.tunnelId,
            }).pipe(
              Effect.map(
                (t) =>
                  t as {
                    id?: string | null;
                    name?: string | null;
                    accountTag?: string | null;
                    createdAt?: string | null;
                    deletedAt?: string | null;
                    configSrc?: "cloudflare" | "local" | null;
                  },
              ),
              Effect.catchTag("TunnelNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
            // Treat both "missing" and "soft-deleted" as gone so the
            // engine triggers re-create on the next reconcile.
            if (!tunnel || tunnel.deletedAt) return undefined;
            const token = yield* loadToken(
              output.accountId,
              output.tunnelId,
            );
            if (token === undefined) return undefined;
            return {
              tunnelId: tunnel.id ?? output.tunnelId,
              tunnelName: tunnel.name ?? output.tunnelName,
              accountTag: tunnel.accountTag ?? output.accountTag,
              accountId: output.accountId,
              createdAt: tunnel.createdAt ?? output.createdAt,
              deletedAt: tunnel.deletedAt ?? output.deletedAt,
              configSrc: (tunnel.configSrc ??
                output.configSrc ??
                "cloudflare") as "cloudflare" | "local",
              token,
            };
          }
          const name = yield* createTunnelName(id, olds?.name);
          const existing = yield* findTunnelByName(name);
          if (!existing || !existing.id || existing.deletedAt) {
            return undefined;
          }
          const token = yield* loadToken(accountId, existing.id);
          if (token === undefined) return undefined;
          return {
            tunnelId: existing.id,
            tunnelName: existing.name ?? name,
            accountTag: existing.accountTag ?? undefined,
            accountId,
            createdAt: existing.createdAt ?? undefined,
            deletedAt: existing.deletedAt ?? undefined,
            configSrc: ((
              existing as { configSrc?: "cloudflare" | "local" | null }
            ).configSrc ?? "cloudflare") as "cloudflare" | "local",
            token,
          };
        }),
      };
    }),
  );
