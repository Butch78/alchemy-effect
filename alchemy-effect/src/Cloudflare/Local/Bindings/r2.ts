import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const StringRecord = Schema.Record(Schema.String, Schema.String);

export const R2ObjectInfo = Schema.Struct({
  key: Schema.String,
  version: Schema.String,
  size: Schema.Number,
  etag: Schema.String,
  httpEtag: Schema.String,
  storageClass: Schema.String,
  uploaded: Schema.String,
  httpMetadata: Schema.optional(StringRecord),
  customMetadata: Schema.optional(StringRecord),
});

export type R2ObjectInfo = typeof R2ObjectInfo.Type;

const R2ListResult = Schema.Struct({
  objects: Schema.Array(Schema.Struct({ ...R2ObjectInfo.fields })),
  truncated: Schema.Boolean,
  cursor: Schema.optional(Schema.String),
  delimitedPrefixes: Schema.Array(Schema.String),
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export const R2_INFO_HEADER = "x-alchemy-r2-info";
export const R2_HTTP_METADATA_HEADER = "x-alchemy-r2-http-metadata";
export const R2_CUSTOM_METADATA_HEADER = "x-alchemy-r2-custom-metadata";

const decodeR2ObjectInfo = Schema.decodeUnknownSync(R2ObjectInfo);
const decodeR2ListResult = Schema.decodeUnknownSync(R2ListResult);

export function serializeR2Object(obj: cf.R2Object): R2ObjectInfo {
  const httpMetadata = obj.httpMetadata
    ? Object.fromEntries(
        Object.entries(obj.httpMetadata).filter(
          ([, v]) => v !== undefined && typeof v === "string",
        ),
      )
    : undefined;
  const customMetadata =
    obj.customMetadata && Object.keys(obj.customMetadata).length > 0
      ? obj.customMetadata
      : undefined;
  return {
    key: obj.key,
    version: obj.version,
    size: obj.size,
    etag: obj.etag,
    httpEtag: obj.httpEtag,
    storageClass: obj.storageClass,
    uploaded: obj.uploaded.toISOString(),
    httpMetadata:
      httpMetadata && Object.keys(httpMetadata).length > 0
        ? httpMetadata
        : undefined,
    customMetadata,
  };
}

export function encodeR2HeaderValue(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

export function decodeR2HeaderValue<T>(value: string | null): T | undefined {
  if (value === null) {
    return undefined;
  }
  return JSON.parse(decodeURIComponent(value)) as T;
}

// ---------------------------------------------------------------------------
// Client-side facade (runs locally)
// ---------------------------------------------------------------------------

export type R2PutValue =
  | ReadableStream<Uint8Array>
  | ArrayBuffer
  | ArrayBufferView
  | string
  | null
  | Blob;

export interface R2BucketFacade {
  get(key: string): Promise<R2ObjectBodyFacade | null>;
  put(
    key: string,
    value: R2PutValue,
    options?: {
      httpMetadata?: Record<string, string>;
      customMetadata?: Record<string, string>;
    },
  ): Promise<R2ObjectInfo>;
  delete(keys: string | string[]): Promise<void>;
  head(key: string): Promise<R2ObjectInfo | null>;
  list(options?: {
    limit?: number;
    prefix?: string;
    cursor?: string;
    delimiter?: string;
    startAfter?: string;
  }): Promise<{
    objects: readonly R2ObjectInfo[];
    truncated: boolean;
    cursor?: string;
    delimitedPrefixes: readonly string[];
  }>;
}

export interface R2ObjectBodyFacade extends R2ObjectInfo {
  readonly body: ReadableStream<Uint8Array>;
  readonly bodyUsed: boolean;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  json<T>(): Promise<T>;
  blob(): Promise<Blob>;
}

function makeObjectUrl(workerUrl: string, bucket: string, key: string): string {
  const params = new URLSearchParams({ bucket, key });
  return `${workerUrl}/r2/object?${params.toString()}`;
}

function makeListUrl(
  workerUrl: string,
  bucket: string,
  options?: {
    limit?: number;
    prefix?: string;
    cursor?: string;
    delimiter?: string;
    startAfter?: string;
  },
): string {
  const params = new URLSearchParams({ bucket });
  if (options?.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options?.prefix !== undefined) {
    params.set("prefix", options.prefix);
  }
  if (options?.cursor !== undefined) {
    params.set("cursor", options.cursor);
  }
  if (options?.delimiter !== undefined) {
    params.set("delimiter", options.delimiter);
  }
  if (options?.startAfter !== undefined) {
    params.set("startAfter", options.startAfter);
  }
  return `${workerUrl}/r2/list?${params.toString()}`;
}

function makeEmptyBodyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && value instanceof ReadableStream;
}

function normalizeUploadBody(value: R2PutValue): BodyInit | null {
  if (value === null || typeof value === "string" || value instanceof Blob) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(
      new Uint8Array(
        value.buffer as ArrayBuffer,
        value.byteOffset,
        value.byteLength,
      ),
    );
    return copy;
  }
  return value;
}

async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const body = await response.text().catch(() => "");
  throw new Error(
    `R2 request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
  );
}

function getObjectInfoFromHeaders(headers: Headers): R2ObjectInfo {
  const raw = decodeR2HeaderValue<unknown>(headers.get(R2_INFO_HEADER));
  if (raw === undefined) {
    throw new Error("Missing R2 metadata header");
  }
  return decodeR2ObjectInfo(raw);
}

function makeObjectBodyFacade(
  response: Response,
  info: R2ObjectInfo,
): R2ObjectBodyFacade {
  return {
    ...info,
    get body() {
      return (response.body as ReadableStream<Uint8Array> | null) ?? makeEmptyBodyStream();
    },
    get bodyUsed() {
      return response.bodyUsed;
    },
    text() {
      return response.text();
    },
    arrayBuffer() {
      return response.arrayBuffer();
    },
    async bytes() {
      return new Uint8Array(await response.arrayBuffer());
    },
    json<T>() {
      return response.json() as Promise<T>;
    },
    blob() {
      return response.blob();
    },
  };
}

export function makeR2Facade(workerUrl: string, bucket: string): R2BucketFacade {
  return {
    async get(key) {
      const response = await fetch(makeObjectUrl(workerUrl, bucket, key));
      if (response.status === 404) {
        return null;
      }
      await throwIfNotOk(response);
      return makeObjectBodyFacade(response, getObjectInfoFromHeaders(response.headers));
    },
    async put(key, value, options) {
      const response = await fetch(makeObjectUrl(workerUrl, bucket, key), {
        method: "PUT",
        headers: {
          ...(options?.httpMetadata
            ? {
                [R2_HTTP_METADATA_HEADER]: encodeR2HeaderValue(
                  options.httpMetadata,
                ),
              }
            : {}),
          ...(options?.customMetadata
            ? {
                [R2_CUSTOM_METADATA_HEADER]: encodeR2HeaderValue(
                  options.customMetadata,
                ),
              }
            : {}),
        },
        body: normalizeUploadBody(value),
        ...(isReadableStream(value)
          ? ({ duplex: "half" } as RequestInit)
          : {}),
      });
      await throwIfNotOk(response);
      return decodeR2ObjectInfo(await response.json());
    },
    async delete(keys) {
      const keyArray = typeof keys === "string" ? [keys] : keys;
      const response = await fetch(`${workerUrl}/r2/object`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bucket, keys: keyArray }),
      });
      await throwIfNotOk(response);
    },
    async head(key) {
      const response = await fetch(makeObjectUrl(workerUrl, bucket, key), {
        method: "HEAD",
      });
      if (response.status === 404) {
        return null;
      }
      await throwIfNotOk(response);
      return getObjectInfoFromHeaders(response.headers);
    },
    async list(options) {
      const response = await fetch(makeListUrl(workerUrl, bucket, options));
      await throwIfNotOk(response);
      return decodeR2ListResult(await response.json());
    },
  };
}

/**
 * Create an R2 client connected to the proxy worker over HTTP.
 * Returns a factory for creating R2BucketFacade instances by binding name.
 */
export const makeR2Client = (workerUrl: string) =>
  Effect.succeed({
    r2: (bucket: string) => makeR2Facade(workerUrl, bucket),
  });
