import { sha256, sha256File } from "@/Util/sha256";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

describe("sha256File", () => {
  it.effect("matches the in-memory digest of the same bytes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "alchemy-sha-" });
      try {
        // Larger than one stream chunk, so the incremental path is exercised.
        const body = "x".repeat(200_000);
        const file = path.join(root, "blob.bin");
        yield* fs.writeFileString(file, body);
        expect(yield* sha256File(file)).toBe(yield* sha256(body));
      } finally {
        yield* fs
          .remove(root, { recursive: true })
          .pipe(Effect.catch(() => Effect.void));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("differs when contents differ", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "alchemy-sha-" });
      try {
        const a = path.join(root, "a.txt");
        const b = path.join(root, "b.txt");
        yield* fs.writeFileString(a, "alpha");
        yield* fs.writeFileString(b, "beta");
        expect(yield* sha256File(a)).not.toBe(yield* sha256File(b));
      } finally {
        yield* fs
          .remove(root, { recursive: true })
          .pipe(Effect.catch(() => Effect.void));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
