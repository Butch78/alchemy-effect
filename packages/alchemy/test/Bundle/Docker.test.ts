import {
  DockerCommandError,
  dockerBuild,
  materializeDockerfile,
  runDockerCommand,
  sha256File,
  writeContextFiles,
} from "@/Bundle/Docker";
import { sha256 } from "@/Util/sha256";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { spawnSync } from "node:child_process";

const dockerDaemonOk =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

describe("docker context helpers", () => {
  it.effect("materializes a Dockerfile in the target directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-docker-ctx-",
      });
      try {
        const ctx = path.join(root, "ctx");
        const dockerfile = yield* materializeDockerfile("FROM scratch\n", ctx);
        expect(dockerfile).toBe(path.join(ctx, "Dockerfile"));
        expect(yield* fs.exists(dockerfile)).toBe(true);
        expect(yield* fs.readFileString(dockerfile)).toBe("FROM scratch\n");
      } finally {
        yield* fs
          .remove(root, { recursive: true })
          .pipe(Effect.catch(() => Effect.void));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("writes nested context files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-docker-path-",
      });
      try {
        const ctx = path.join(root, "ctx");
        yield* writeContextFiles(ctx, [
          { path: "nested/hello.txt", content: "hi" },
        ]);
        expect(
          yield* fs.readFileString(path.join(ctx, "nested", "hello.txt")),
        ).toBe("hi");
      } finally {
        yield* fs
          .remove(root, { recursive: true })
          .pipe(Effect.catch(() => Effect.void));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

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

describe("runDockerCommand", () => {
  it.effect("fails with DockerCommandError for invalid docker invocation", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        runDockerCommand([
          "inspect",
          "--type=image",
          "this-image-should-not-exist-alchemy-test:xyz",
        ]),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(DockerCommandError);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("dockerBuild", () => {
  if (dockerDaemonOk) {
    it.effect("builds a minimal image with content Dockerfile", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-docker-build-",
        });
        try {
          const ctx = path.join(root, "ctx");
          const tag = "alchemy-docker-test:minimal";
          yield* materializeDockerfile(
            [
              "FROM alpine:3.19",
              "RUN echo ok > /tmp/ok.txt",
              'CMD ["cat", "/tmp/ok.txt"]',
              "",
            ].join("\n"),
            ctx,
          );
          yield* dockerBuild({
            tag,
            context: ctx,
          });
          const inspect = yield* runDockerCommand([
            "image",
            "inspect",
            tag,
            "--format",
            "{{.Id}}",
          ]);
          expect(inspect.stdout.trim().length).toBeGreaterThan(0);
          yield* runDockerCommand(["rmi", "-f", tag]).pipe(
            Effect.catch(() => Effect.void),
          );
        } finally {
          yield* fs
            .remove(root, { recursive: true })
            .pipe(Effect.catch(() => Effect.void));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("passes --platform and --build-arg", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-docker-build-",
        });
        try {
          const ctx = path.join(root, "ctx");
          const tag = "alchemy-docker-test:args";
          yield* materializeDockerfile(
            [
              "FROM alpine:3.19",
              "ARG FOO=default",
              'RUN echo "$FOO" > /out.txt',
              "",
            ].join("\n"),
            ctx,
          );
          yield* dockerBuild({
            tag,
            context: ctx,
            platform: "linux/amd64",
            buildArgs: { FOO: "from-arg" },
          });
          const out = yield* runDockerCommand([
            "run",
            "--rm",
            tag,
            "cat",
            "/out.txt",
          ]);
          expect(out.stdout.trim()).toBe("from-arg");
          yield* runDockerCommand(["rmi", "-f", tag]).pipe(
            Effect.catch(() => Effect.void),
          );
        } finally {
          yield* fs
            .remove(root, { recursive: true })
            .pipe(Effect.catch(() => Effect.void));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("builds with a custom -f Dockerfile path", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-docker-build-",
        });
        try {
          const ctx = path.join(root, "ctx");
          const tag = "alchemy-docker-test:dockerfile-path";
          yield* writeContextFiles(ctx, [
            { path: "marker.txt", content: "hi" },
          ]);
          // Dockerfile lives outside the context, named non-default.
          const dockerfile = path.join(root, "Dockerfile.custom");
          yield* fs.writeFileString(
            dockerfile,
            ["FROM alpine:3.19", "COPY marker.txt /marker.txt", ""].join("\n"),
          );
          yield* dockerBuild({ tag, context: ctx, dockerfile });
          const out = yield* runDockerCommand([
            "run",
            "--rm",
            tag,
            "cat",
            "/marker.txt",
          ]);
          expect(out.stdout.trim()).toBe("hi");
          yield* runDockerCommand(["rmi", "-f", tag]).pipe(
            Effect.catch(() => Effect.void),
          );
        } finally {
          yield* fs
            .remove(root, { recursive: true })
            .pipe(Effect.catch(() => Effect.void));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("respects multi-stage --target", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-docker-build-",
        });
        try {
          const ctx = path.join(root, "ctx");
          const tag = "alchemy-docker-test:target";
          yield* materializeDockerfile(
            [
              "FROM alpine:3.19 AS base",
              "RUN echo base > /stage.txt",
              "",
              "FROM alpine:3.19 AS secondary",
              "RUN echo secondary > /stage.txt",
              "",
            ].join("\n"),
            ctx,
          );
          yield* dockerBuild({
            tag,
            context: ctx,
            target: "secondary",
          });
          const out = yield* runDockerCommand([
            "run",
            "--rm",
            tag,
            "cat",
            "/stage.txt",
          ]);
          expect(out.stdout.trim()).toBe("secondary");
          yield* runDockerCommand(["rmi", "-f", tag]).pipe(
            Effect.catch(() => Effect.void),
          );
        } finally {
          yield* fs
            .remove(root, { recursive: true })
            .pipe(Effect.catch(() => Effect.void));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  } else {
    it.skip("builds a minimal image with content Dockerfile", () => {});
    it.skip("passes --platform and --build-arg", () => {});
    it.skip("builds with a custom -f Dockerfile path", () => {});
    it.skip("respects multi-stage --target", () => {});
  }
});
