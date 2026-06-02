import {
  Credentials,
  formatHeaders,
} from "@distilled.cloud/cloudflare/Credentials";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { resolveZoneId, type ZoneReference } from "../Zone/index.ts";

/**
 * Every DNS record type Cloudflare supports.
 */
export type DnsRecordType =
  | "A"
  | "AAAA"
  | "CAA"
  | "CERT"
  | "CNAME"
  | "DNSKEY"
  | "DS"
  | "HTTPS"
  | "LOC"
  | "MX"
  | "NAPTR"
  | "NS"
  | "OPENPGPKEY"
  | "PTR"
  | "SMIMEA"
  | "SRV"
  | "SSHFP"
  | "SVCB"
  | "TLSA"
  | "TXT"
  | "URI";

/**
 * Per-record behavioral settings.
 */
export interface DnsRecordSettings {
  /** Only return IPv4 addresses when proxying (`CNAME`/`A`). */
  ipv4Only?: boolean;
  /** Only return IPv6 addresses when proxying (`CNAME`/`AAAA`). */
  ipv6Only?: boolean;
  /** Flatten a proxied `CNAME` to its resolved address (`CNAME` only). */
  flattenCname?: boolean;
}

export interface DnsRecordProps {
  /**
   * The zone the record belongs to. Accepts a 32-char zone id, a
   * `{ zoneId }` object (e.g. a {@link Zone} output), or a zone name that
   * is resolved against the ambient Cloudflare account.
   */
  zone: ZoneReference;

  /**
   * Complete DNS record name, including the zone name (e.g.
   * `www.example.com`).
   */
  name: string;

  /**
   * Record type.
   */
  type: DnsRecordType;

  /**
   * Record value — an IPv4/IPv6 address, hostname, or text payload
   * depending on `type`.
   */
  content: string;

  /**
   * Time To Live in seconds. `1` means automatic. Otherwise must be
   * between 60 and 86400 (30 for Enterprise zones).
   * @default 1
   */
  ttl?: number;

  /**
   * Whether the record is proxied through Cloudflare. Only valid for
   * proxiable types such as `A`, `AAAA`, and `CNAME`.
   * @default false
   */
  proxied?: boolean;

  /**
   * Priority. Required for `MX`, `SRV`, and `URI` records.
   */
  priority?: number;

  /**
   * Comments or notes about the record. No effect on DNS responses.
   */
  comment?: string;

  /**
   * Custom tags for the record. No effect on DNS responses.
   */
  tags?: string[];

  /**
   * Per-record settings.
   */
  settings?: DnsRecordSettings;
}

export type DnsRecord = Resource<
  "Cloudflare.DnsRecord",
  DnsRecordProps,
  {
    recordId: string;
    zoneId: string;
    name: string;
    type: DnsRecordType;
    content: string;
    ttl: number;
    proxied: boolean;
    priority: number | undefined;
    comment: string | undefined;
    tags: string[];
    createdOn: string;
    modifiedOn: string;
  },
  never,
  Providers
>;

/**
 * A single record in a Cloudflare DNS zone.
 *
 * @section Creating a Record
 * @example A record
 * ```typescript
 * const record = yield* Cloudflare.DnsRecord("www", {
 *   zone: { zoneId: zone.zoneId },
 *   name: "www.example.com",
 *   type: "A",
 *   content: "192.0.2.1",
 *   proxied: true,
 * });
 * ```
 *
 * @example CNAME record
 * ```typescript
 * const cname = yield* Cloudflare.DnsRecord("docs", {
 *   zone: "example.com",
 *   name: "docs.example.com",
 *   type: "CNAME",
 *   content: "example.pages.dev",
 *   proxied: true,
 * });
 * ```
 *
 * @example MX record
 * ```typescript
 * const mx = yield* Cloudflare.DnsRecord("mail", {
 *   zone: { zoneId: zone.zoneId },
 *   name: "example.com",
 *   type: "MX",
 *   content: "mail.example.com",
 *   priority: 10,
 * });
 * ```
 *
 * @example TXT record
 * ```typescript
 * const txt = yield* Cloudflare.DnsRecord("spf", {
 *   zone: { zoneId: zone.zoneId },
 *   name: "example.com",
 *   type: "TXT",
 *   content: "v=spf1 include:_spf.example.com ~all",
 * });
 * ```
 */
export const DnsRecord = Resource<DnsRecord>("Cloudflare.DnsRecord");

/**
 * A non-2xx response from the Cloudflare DNS API. `errors` mirrors the
 * `errors` array Cloudflare returns so callers can branch on error codes
 * (e.g. `81057` — "Record already exists").
 */
export class DnsApiError extends Data.TaggedError("DnsApiError")<{
  status: number;
  errors: { code?: number; message?: string }[];
}> {}

const RECORD_ALREADY_EXISTS = 81057;

type WireRecord = {
  id: string;
  name: string;
  type: DnsRecordType;
  content: string;
  ttl: number;
  proxied?: boolean | null;
  priority?: number | null;
  comment?: string | null;
  tags?: string[] | null;
  created_on: string;
  modified_on: string;
};

const resolveTtl = (ttl: number | undefined): number => ttl ?? 1;

const toBody = (props: DnsRecordProps) => ({
  name: props.name,
  type: props.type,
  content: props.content,
  ttl: resolveTtl(props.ttl),
  proxied: props.proxied ?? false,
  ...(props.priority !== undefined ? { priority: props.priority } : {}),
  ...(props.comment !== undefined ? { comment: props.comment } : {}),
  ...(props.tags !== undefined ? { tags: props.tags } : {}),
  ...(props.settings
    ? {
        settings: {
          ...(props.settings.ipv4Only !== undefined
            ? { ipv4_only: props.settings.ipv4Only }
            : {}),
          ...(props.settings.ipv6Only !== undefined
            ? { ipv6_only: props.settings.ipv6Only }
            : {}),
          ...(props.settings.flattenCname !== undefined
            ? { flatten_cname: props.settings.flattenCname }
            : {}),
        },
      }
    : {}),
});

const toAttrs = (zoneId: string, record: WireRecord) => ({
  recordId: record.id,
  zoneId,
  name: record.name,
  type: record.type,
  content: record.content,
  ttl: record.ttl,
  proxied: record.proxied ?? false,
  priority: record.priority ?? undefined,
  comment: record.comment ?? undefined,
  tags: record.tags ?? [],
  createdOn: record.created_on,
  modifiedOn: record.modified_on,
});

const recordDiffers = (
  desired: DnsRecordProps,
  observed: WireRecord,
): boolean =>
  desired.name !== observed.name ||
  desired.type !== observed.type ||
  desired.content !== observed.content ||
  resolveTtl(desired.ttl) !== observed.ttl ||
  (desired.proxied ?? false) !== (observed.proxied ?? false) ||
  (desired.priority ?? undefined) !== (observed.priority ?? undefined) ||
  (desired.comment ?? undefined) !== (observed.comment ?? undefined);

export const DnsRecordProvider = () =>
  Provider.effect(
    DnsRecord,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const credentialsEffect = yield* Credentials;
      const client = yield* HttpClient.HttpClient;

      const auth = credentialsEffect.pipe(
        Effect.map((credentials) => ({
          headers: formatHeaders(credentials),
          apiBaseUrl: credentials.apiBaseUrl,
        })),
      );

      // Single entry point for the DNS API. Parses Cloudflare's
      // `{ success, result, errors }` envelope and fails with a tagged
      // `DnsApiError` (carrying status + error codes) on any non-success
      // response so callers can branch on 404 / 81057.
      const call = (
        method: "GET" | "POST" | "PUT" | "DELETE",
        path: string,
        body?: unknown,
      ) =>
        Effect.gen(function* () {
          const { headers, apiBaseUrl } = yield* auth;
          const url = `${apiBaseUrl}${path}`;
          let req = HttpClientRequest.make(method)(url).pipe(
            HttpClientRequest.setHeaders(headers),
          );
          if (body !== undefined) {
            req = HttpClientRequest.bodyJsonUnsafe(req, body);
          }
          const res = yield* client
            .execute(req)
            .pipe(
              Effect.mapError(() => new DnsApiError({ status: 0, errors: [] })),
            );
          const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
          const json = (text ? JSON.parse(text) : {}) as {
            success?: boolean;
            result?: WireRecord;
            errors?: { code?: number; message?: string }[];
          };
          if (res.status < 200 || res.status >= 300 || json.success !== true) {
            return yield* Effect.fail(
              new DnsApiError({
                status: res.status,
                errors: json.errors ?? [],
              }),
            );
          }
          return json.result as WireRecord;
        });

      const getRecord = (zoneId: string, recordId: string) =>
        call("GET", `/zones/${zoneId}/dns_records/${recordId}`).pipe(
          Effect.catchTag("DnsApiError", (error) =>
            error.status === 404
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        );

      // Recover a record we lost track of (state-persistence failure or
      // out-of-band create) by matching name + type within the zone.
      const findRecord = (zoneId: string, name: string, type: DnsRecordType) =>
        Effect.gen(function* () {
          const { headers, apiBaseUrl } = yield* auth;
          const url = `${apiBaseUrl}/zones/${zoneId}/dns_records?type=${encodeURIComponent(
            type,
          )}&name=${encodeURIComponent(name)}&per_page=1`;
          const req = HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeaders(headers),
          );
          const res = yield* client
            .execute(req)
            .pipe(
              Effect.mapError(() => new DnsApiError({ status: 0, errors: [] })),
            );
          const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
          const json = (text ? JSON.parse(text) : {}) as {
            success?: boolean;
            result?: WireRecord[];
          };
          if (res.status < 200 || res.status >= 300 || json.success !== true) {
            return undefined;
          }
          return json.result?.find(
            (record) => record.name === name && record.type === type,
          );
        });

      return {
        stables: ["recordId", "zoneId"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          const zoneId = yield* resolveZoneId({
            accountId,
            zone: news.zone,
            hostname: news.name,
          });
          // The zone is immutable for a given record id — moving a record
          // to another zone requires recreating it.
          if (zoneId !== output.zoneId) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const zoneId =
            output?.zoneId ??
            (yield* resolveZoneId({
              accountId,
              zone: news.zone,
              hostname: news.name,
            }));

          // Observe — re-fetch the cached record; fall back to a name+type
          // scan so we recover from out-of-band deletes or partial state.
          let observed: WireRecord | undefined;
          if (output?.recordId) {
            observed = yield* getRecord(zoneId, output.recordId);
          }
          if (!observed) {
            observed = yield* findRecord(zoneId, news.name, news.type);
          }

          // Ensure — create if missing. Cloudflare reports a concurrent
          // create as code 81057; tolerate by adopting the matching record.
          if (!observed) {
            observed = yield* call(
              "POST",
              `/zones/${zoneId}/dns_records`,
              toBody(news),
            ).pipe(
              Effect.catchTag("DnsApiError", (error) =>
                error.errors.some((e) => e.code === RECORD_ALREADY_EXISTS)
                  ? findRecord(zoneId, news.name, news.type).pipe(
                      Effect.flatMap((match) =>
                        match ? Effect.succeed(match) : Effect.fail(error),
                      ),
                    )
                  : Effect.fail(error),
              ),
            );
          }

          // Sync — PUT the full desired record only when it drifted.
          if (recordDiffers(news, observed)) {
            observed = yield* call(
              "PUT",
              `/zones/${zoneId}/dns_records/${observed.id}`,
              toBody(news),
            );
          }

          return toAttrs(zoneId, observed);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* call(
            "DELETE",
            `/zones/${output.zoneId}/dns_records/${output.recordId}`,
          ).pipe(
            Effect.catchTag("DnsApiError", (error) =>
              error.status === 404 ? Effect.void : Effect.fail(error),
            ),
          );
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output?.recordId) {
            const record = yield* getRecord(output.zoneId, output.recordId);
            return record ? toAttrs(output.zoneId, record) : undefined;
          }
          if (!olds?.zone || !olds.name || !olds.type) return undefined;
          const zoneId = yield* resolveZoneId({
            accountId,
            zone: olds.zone,
            hostname: olds.name,
          });
          const match = yield* findRecord(zoneId, olds.name, olds.type);
          if (!match) return undefined;
          // A name+type match is not proof of ownership — DNS records carry
          // no ownership branding — so gate adoption behind `--adopt`.
          return Unowned(toAttrs(zoneId, match));
        }),
      };
    }),
  );
