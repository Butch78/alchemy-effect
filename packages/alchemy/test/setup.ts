// `vitest` is aliased to `bun:test` when running under `bun test`, so this
// import works for both runners. Importing from `bun:test` directly breaks
// vitest because it does not know that module specifier.
import { expect } from "vitest";
import { config } from "dotenv";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Load `.env` from the repo root regardless of the cwd bun was launched
// from. Tests run with cwd=packages/alchemy under bun, but the .env file
// (downloaded via `bun download:env`) lives at the workspace root.
// `import.meta.url` works under both bun and vitest; `import.meta.dir`
// is bun-only.
const setupDir = path.dirname(fileURLToPath(import.meta.url));
config({
  path: path.resolve(setupDir, "..", "..", "..", ".env"),
  quiet: true,
});

// Polyfill File constructor for Node.js if not available
if (typeof globalThis.File === "undefined") {
  const { File } = require("node:buffer");
  globalThis.File = File;
}

// vitest exposes `expect.toSatisfy` as an asymmetric matcher; bun:test does
// not. Register it via `expect.extend` so existing tests that import from
// `vitest` / `@effect/vitest` (both of which are aliased to bun:test by
// bun) keep working.
expect.extend({
  toSatisfy(received: unknown, predicate: (value: any) => boolean, message?: string) {
    const pass = predicate(received);
    return {
      pass,
      message: () =>
        message ?? `expected value to satisfy predicate, got ${received}`,
    };
  },
});
