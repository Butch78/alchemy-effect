import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Vitest";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Cloudflare's POST /zones rejects reserved pseudo-TLDs (`.test`, `.local`,
// `.example`) with "unable to identify ... as a registered domain". A
// syntactically-valid, registerable name is accepted into a `pending` zone
// even when the domain isn't actually registered to us — which is enough to
// create/update/delete DNS records against it. Derive the name from the test
// account id so it's deterministic and never collides with a real zone.
const zoneNameFor = (accountId: string, label: string) =>
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ??
  `alchemy-dns-${label}-${accountId}.com`;

const getLive = (zoneId: string, recordId: string) =>
  dns.getRecord({ zoneId, dnsRecordId: recordId }).pipe(
    Effect.asSome,
    Effect.catchTag("CloudflareHttpError", (error) =>
      error.status === 404 ? Effect.succeedNone : Effect.fail(error),
    ),
  );

test.provider(
  "creates, updates in place, and deletes an A record",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const zoneName = zoneNameFor(accountId, "a");
      const recordName = `a-record.${zoneName}`;

      yield* stack.destroy();

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const zone = yield* Cloudflare.Zone("Zone", {
              name: zoneName,
            }).pipe(destroy());
            return yield* Cloudflare.DnsRecord("Record", {
              zone,
              name: recordName,
              type: "A",
              content: "192.0.2.1",
              proxied: false,
            });
          }),
        );

        expect(created.zoneId).toBeTruthy();
        expect(created.type).toEqual("A");
        expect(created.content).toEqual("192.0.2.1");
        expect(created.recordId).toBeTruthy();

        const live = yield* getLive(created.zoneId, created.recordId);
        expect(Option.isSome(live)).toBe(true);
        expect(Option.getOrThrow(live).content).toEqual("192.0.2.1");

        // Changing content + ttl is an in-place PUT: same record id.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const zone = yield* Cloudflare.Zone("Zone", {
              name: zoneName,
            }).pipe(destroy());
            return yield* Cloudflare.DnsRecord("Record", {
              zone,
              name: recordName,
              type: "A",
              content: "192.0.2.2",
              ttl: 300,
              proxied: false,
            });
          }),
        );

        expect(updated.recordId).toEqual(created.recordId);
        expect(updated.content).toEqual("192.0.2.2");
        expect(updated.ttl).toEqual(300);

        yield* stack.destroy();

        const afterDelete = yield* getLive(created.zoneId, created.recordId);
        expect(Option.isNone(afterDelete)).toBe(true);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)));
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skip(
  "creates a proxied CNAME record",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const zoneName = zoneNameFor(accountId, "cname");

      yield* stack.destroy();

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const zone = yield* Cloudflare.Zone("Zone", {
              name: zoneName,
            }).pipe(destroy());
            return yield* Cloudflare.DnsRecord("Cname", {
              zone,
              name: `docs.${zoneName}`,
              type: "CNAME",
              content: "example.pages.dev",
              proxied: true,
            });
          }),
        );

        expect(created.type).toEqual("CNAME");
        expect(created.content).toEqual("example.pages.dev");
        expect(created.proxied).toBe(true);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)));
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skip(
  "creates an MX record with priority",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const zoneName = zoneNameFor(accountId, "mx");

      yield* stack.destroy();

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const zone = yield* Cloudflare.Zone("Zone", {
              name: zoneName,
            }).pipe(destroy());
            return yield* Cloudflare.DnsRecord("Mx", {
              zone,
              name: zoneName,
              type: "MX",
              content: `mail.${zoneName}`,
              priority: 10,
            });
          }),
        );

        expect(created.type).toEqual("MX");
        expect(created.priority).toEqual(10);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)));
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skip(
  "creates a TXT record",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const zoneName = zoneNameFor(accountId, "txt");

      yield* stack.destroy();

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const zone = yield* Cloudflare.Zone("Zone", {
              name: zoneName,
            }).pipe(destroy());
            return yield* Cloudflare.DnsRecord("Txt", {
              zone,
              name: zoneName,
              type: "TXT",
              content: "v=spf1 include:_spf.example.com ~all",
            });
          }),
        );

        expect(created.type).toEqual("TXT");
        expect(created.content).toContain("v=spf1");
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)));
    }).pipe(logLevel),
  { timeout: 120_000 },
);
