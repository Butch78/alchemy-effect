import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { stableValue } from "./stable.ts";

type Input = ArrayBuffer | Uint8Array | string;

export const sha256 = (input: Input) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(input));
    const hashArray = Array.from(new Uint8Array(digest));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  });

export const sha256Object = (input: object) =>
  sha256(JSON.stringify(stableValue(input)));

/**
 * SHA-256 a file by streaming it through the hasher, so a large input (a
 * compiled binary, an archive) is never buffered whole in memory. Returns the
 * lowercase hex digest. Requires a {@link FileSystem.FileSystem}.
 */
export const sha256File = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hash = createHash("sha256");
    yield* fs
      .stream(filePath)
      .pipe(
        Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))),
      );
    return hash.digest("hex");
  });

const toArrayBuffer = (input: Input) => {
  if (input instanceof ArrayBuffer) {
    return input;
  }
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  return input.buffer.slice(
    input.byteOffset,
    input.byteOffset + input.byteLength,
  ) as ArrayBuffer;
};
