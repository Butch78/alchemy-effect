import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete tunnel with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const tunnel = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("DefaultTunnel");
      }),
    );

    expect(tunnel.tunnelId).toBeDefined();
    expect(tunnel.tunnelName).toBeDefined();
    expect(tunnel.configSrc).toEqual("cloudflare");
    expect(Redacted.value(tunnel.token).length).toBeGreaterThan(0);

    const actualTunnel = yield* zeroTrust.getTunnelCloudflared({
      accountId,
      tunnelId: tunnel.tunnelId,
    });
    expect(actualTunnel.id).toEqual(tunnel.tunnelId);
    expect(actualTunnel.name).toEqual(tunnel.tunnelName);

    yield* stack.destroy();

    yield* waitForTunnelToBeDeleted(tunnel.tunnelId, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete tunnel with ingress", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const tunnel = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("WebTunnel", {
          ingress: [
            { hostname: "test.example.com", service: "http://localhost:8080" },
            { service: "http_status:404" },
          ],
          adopt: true,
        });
      }),
    );

    expect(tunnel.tunnelId).toBeDefined();

    const config = yield* zeroTrust.getTunnelCloudflaredConfiguration({
      accountId,
      tunnelId: tunnel.tunnelId,
    });
    expect(config.config?.ingress?.length).toEqual(2);
    expect(config.config?.ingress?.[0].hostname).toEqual("test.example.com");
    expect(config.config?.ingress?.[0].service).toEqual(
      "http://localhost:8080",
    );

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("WebTunnel", {
          ingress: [
            { hostname: "app.example.com", service: "http://localhost:3000" },
            {
              hostname: "api.example.com",
              service: "http://localhost:8080",
              originRequest: {
                httpHostHeader: "api.internal",
                connectTimeout: 30,
              },
            },
            { service: "http_status:404" },
          ],
          adopt: true,
        });
      }),
    );

    expect(updated.tunnelId).toEqual(tunnel.tunnelId);

    const updatedConfig = yield* zeroTrust.getTunnelCloudflaredConfiguration({
      accountId,
      tunnelId: tunnel.tunnelId,
    });
    expect(updatedConfig.config?.ingress?.length).toEqual(3);
    expect(updatedConfig.config?.ingress?.[1].originRequest).toMatchObject({
      httpHostHeader: "api.internal",
      connectTimeout: 30,
    });

    yield* stack.destroy();

    yield* waitForTunnelToBeDeleted(tunnel.tunnelId, accountId);
  }).pipe(logLevel),
);

test.provider("local configuration mode skips configuration", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const tunnel = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("LocalTunnel", {
          configSrc: "local",
          ingress: [
            { hostname: "test.example.com", service: "http://localhost:3000" },
            { service: "http_status:404" },
          ],
          adopt: true,
        });
      }),
    );

    expect(tunnel.configSrc).toEqual("local");

    yield* stack.destroy();

    yield* waitForTunnelToBeDeleted(tunnel.tunnelId, accountId);
  }).pipe(logLevel),
);

const waitForTunnelToBeDeleted = Effect.fn(function* (
  tunnelId: string,
  accountId: string,
) {
  yield* zeroTrust.getTunnelCloudflared({ accountId, tunnelId }).pipe(
    Effect.flatMap((t) =>
      t.deletedAt ? Effect.void : Effect.fail(new TunnelStillExists()),
    ),
    Effect.retry({
      while: (e): e is TunnelStillExists => e instanceof TunnelStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catch(() => Effect.void),
  );
});

class TunnelStillExists extends Data.TaggedError("TunnelStillExists") {}

// ─────────────────────────────────────────────────────────────────────
// Lifecycle convergence
//
// Reconcile must converge from any starting state — pristine, drifted,
// out-of-band-deleted, or replaced — without leaning on `olds` as a
// source of truth. The tests below pin down each starting state.
// ─────────────────────────────────────────────────────────────────────

test.provider(
  "redeploy with same props is a no-op (reconcile is idempotent)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Tunnel("IdempotentTunnel", {
            ingress: [
              { hostname: "idempotent.example.com", service: "http://localhost:8080" },
              { service: "http_status:404" },
            ],
            adopt: true,
          });
        }),
      );

      // Deploy again with byte-identical props. Reconcile should
      // observe the existing tunnel by id, find no drift, and PUT the
      // same configuration — preserving identity (tunnelId/name) and
      // leaving the live config unchanged.
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Tunnel("IdempotentTunnel", {
            ingress: [
              { hostname: "idempotent.example.com", service: "http://localhost:8080" },
              { service: "http_status:404" },
            ],
            adopt: true,
          });
        }),
      );

      expect(v2.tunnelId).toEqual(v1.tunnelId);
      expect(v2.tunnelName).toEqual(v1.tunnelName);

      const config = yield* zeroTrust.getTunnelCloudflaredConfiguration({
        accountId,
        tunnelId: v2.tunnelId,
      });
      expect(config.config?.ingress?.length).toEqual(2);
      expect(config.config?.ingress?.[0].hostname).toEqual(
        "idempotent.example.com",
      );

      yield* stack.destroy();
      yield* waitForTunnelToBeDeleted(v1.tunnelId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets ingress mutated out-of-band via the raw Cloudflare API",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Tunnel("DriftTunnel", {
              ingress: [
                { hostname: "drift.example.com", service: "http://localhost:3000" },
                { service: "http_status:404" },
              ],
              adopt: true,
            });
          }),
        );

      const v1 = yield* deploy();

      // Mutate the live ingress out-of-band — drop the user's rule and
      // splice in a foreign one. This is the kind of drift you'd see
      // from a manual edit in the Cloudflare dashboard.
      yield* zeroTrust.putTunnelCloudflaredConfiguration({
        accountId,
        tunnelId: v1.tunnelId,
        config: {
          ingress: [
            { hostname: "tampered.example.com", service: "http://localhost:9999" },
            { service: "http_status:500" },
          ],
        },
      });

      // Re-deploy with the original desired props. Reconcile must
      // observe the tunnel by id, then PUT the desired ingress so the
      // foreign rule is overwritten and the user's rule comes back.
      const v2 = yield* deploy();
      expect(v2.tunnelId).toEqual(v1.tunnelId);

      const config = yield* zeroTrust.getTunnelCloudflaredConfiguration({
        accountId,
        tunnelId: v2.tunnelId,
      });
      expect(config.config?.ingress?.[0].hostname).toEqual(
        "drift.example.com",
      );
      expect(config.config?.ingress?.[0].service).toEqual(
        "http://localhost:3000",
      );
      const hostnames = (config.config?.ingress ?? []).map((r) => r.hostname);
      expect(hostnames).not.toContain("tampered.example.com");

      yield* stack.destroy();
      yield* waitForTunnelToBeDeleted(v1.tunnelId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a tunnel that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const tunnelName = `alchemy-test-tunnel-recreate-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Tunnel("RecreateTunnel", {
            name: tunnelName,
            adopt: true,
          });
        }),
      );
      expect(v1.tunnelName).toEqual(tunnelName);

      // Delete the tunnel out-of-band. Local state still says it
      // exists, but Cloudflare disagrees.
      yield* zeroTrust.deleteTunnelCloudflared({
        accountId,
        tunnelId: v1.tunnelId,
      });
      yield* waitForTunnelToBeDeleted(v1.tunnelId, accountId);

      // Reconcile must observe the deleted tunnel via `getTunnel`
      // (returning `deletedAt`), fall through to `findTunnelByName`
      // (which filters out soft-deleted), and create fresh.
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Tunnel("RecreateTunnel", {
            name: tunnelName,
            adopt: true,
          });
        }),
      );
      expect(v2.tunnelName).toEqual(tunnelName);
      // The new tunnel should have a different id since the old one
      // is soft-deleted.
      expect(v2.tunnelId).not.toEqual(v1.tunnelId);

      const fresh = yield* zeroTrust.getTunnelCloudflared({
        accountId,
        tunnelId: v2.tunnelId,
      });
      expect(fresh.deletedAt).toBeFalsy();

      yield* stack.destroy();
      yield* waitForTunnelToBeDeleted(v2.tunnelId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "changing tunnel name triggers replace; old tunnel is deleted",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-tunnel-replace-a-${suffix}`;
      const nameB = `alchemy-test-tunnel-replace-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Tunnel("RenameTunnel", {
            name: nameA,
            adopt: true,
          });
        }),
      );
      expect(a.tunnelName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Tunnel("RenameTunnel", {
            name: nameB,
            adopt: true,
          });
        }),
      );
      expect(b.tunnelName).toEqual(nameB);
      expect(b.tunnelId).not.toEqual(a.tunnelId);

      // The old tunnel must be deleted after replace.
      yield* waitForTunnelToBeDeleted(a.tunnelId, accountId);

      yield* stack.destroy();
      yield* waitForTunnelToBeDeleted(b.tunnelId, accountId);
    }).pipe(logLevel),
);

test.provider("destroying an already-deleted tunnel is a no-op", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const tunnel = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("DoubleDestroyTunnel");
      }),
    );

    // Delete the tunnel out-of-band so the next destroy hits the
    // not-found path inside provider.delete. Provider.delete must
    // catch the `code: 1002` `UnknownCloudflareError` and complete
    // cleanly.
    yield* zeroTrust.deleteTunnelCloudflared({
      accountId,
      tunnelId: tunnel.tunnelId,
    });
    yield* waitForTunnelToBeDeleted(tunnel.tunnelId, accountId);

    // First destroy: state still references the deleted tunnel; the
    // engine calls provider.delete which must idempotently succeed.
    yield* stack.destroy();

    // Second destroy: state is gone; this is a true no-op. Repeated
    // destroys must never throw.
    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "adopt(true) takes over a foreign tunnel matching by name",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const tunnelName = `alchemy-test-tunnel-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Phase 1 — create a tunnel out-of-band so it has no engine
      // ownership tags. This is the "foreign" tunnel an operator might
      // have created in the dashboard.
      const foreign = yield* zeroTrust.createTunnelCloudflared({
        accountId,
        name: tunnelName,
        configSrc: "cloudflare",
      });

      // Phase 2 — without `adopt: true`, the engine must NOT take
      // over a foreign tunnel; the create call should fail with
      // `DuplicateTunnelName` and reconcile should surface that
      // error.
      const refusal = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Tunnel("AdoptTunnel", {
              name: tunnelName,
            });
          }),
        )
        .pipe(Effect.flip);
      expect(refusal).toBeDefined();

      // Phase 3 — with `adopt: true`, reconcile re-lists by name and
      // takes over the existing tunnel without creating a duplicate.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Tunnel("AdoptTunnel", {
            name: tunnelName,
            adopt: true,
          });
        }),
      );
      expect(adopted.tunnelName).toEqual(tunnelName);
      expect(adopted.tunnelId).toEqual(foreign.id);

      yield* stack.destroy();
      yield* waitForTunnelToBeDeleted(foreign.id!, accountId);
    }).pipe(logLevel),
);
