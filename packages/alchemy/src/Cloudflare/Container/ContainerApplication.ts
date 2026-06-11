import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";
import { Unowned } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import {
  dockerBuild,
  materializeDockerfile,
  pushImage,
  sha256File,
  writeContextFiles,
} from "../../Bundle/Docker.ts";
import {
  findCwdForBundle,
  getStableContextDir,
} from "../../Bundle/TempRoot.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  type Main,
  type PlatformProps,
  type PlatformServices,
} from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { Self } from "../../Self.ts";
import * as Server from "../../Server/index.ts";
import { Stack } from "../../Stack.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { normalizeNulls } from "../../Util/stable.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { CloudflareLogs, type TelemetryFilter } from "../Logs.ts";
import type { Providers } from "../Providers.ts";
import { Container, ContainerTypeId } from "./Container.ts";

export { Credentials } from "@distilled.cloud/cloudflare/Credentials";

export namespace ContainerApplication {
  export type InstanceType = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["instanceType"]
  >;
  export type SchedulingPolicy = NonNullable<
    Containers.CreateContainerApplicationRequest["schedulingPolicy"]
  >;
  export type Observability = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["observability"]
  >;
  export type Secret = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["secrets"]
  >[number];
  export type Disk = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["disk"]
  >;
  export type EnvironmentVariable = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["environmentVariables"]
  >[number];
  export type Label = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["labels"]
  >[number];
  export type Network = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["network"]
  >;
  export type Dns = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["dns"]
  >;
  export type Port = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["ports"]
  >[number];
  export type Check = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["checks"]
  >[number];
  export type Constraints = {
    tier?: number;
  };
  export type Affinities = {
    colocation?: "datacenter";
  };
  export type Configuration =
    Containers.CreateContainerApplicationRequest["configuration"];
  export interface Rollout {
    strategy?: "rolling" | "immediate";
    kind?: "full_auto";
    stepPercentage?: number;
  }
}

export interface ContainerApplicationProps extends PlatformProps {
  /**
   * Main entrypoint for the container program. This file is bundled and
   * added to the Docker image as the container's entrypoint.
   */
  main?: string;
  /**
   * Exported handler symbol inside the bundled module.
   * @default "default"
   */
  handler?: string;
  /**
   * Runtime environment for the container program.
   *
   * @default "bun"
   */
  runtime?: "bun" | "node";
  /**
   * Module specifiers that Rolldown should mark as external when bundling
   * the container entrypoint. The matching packages are installed inside the
   * image via the runtime's package manager (`bun add` for `runtime: "bun"`,
   * `npm install` for `runtime: "node"`) before the entrypoint runs.
   *
   * Use this for native dependencies that must not be bundled (e.g. `sharp`,
   * `impit`) or for packages that intentionally ship in the base image.
   *
   * Install inside the image is controlled by {@link autoInstallExternals}
   * (default `true`); set it to `false` if your custom `dockerfile` already
   * installs these packages and you want to avoid the redundant step.
   */
  external?: string[];
  /**
   * Whether to auto-install the packages listed in {@link external} inside
   * the container image (via `bun add` or `npm install`) before running the
   * entrypoint.
   *
   * @default true
   *
   * Set to `false` when your custom `dockerfile` already installs these
   * packages (for example, via a base image that pre-installs `sharp`), to
   * avoid the redundant install step.
   */
  autoInstallExternals?: boolean;
  /**
   * Human-readable application name. If omitted, Alchemy derives a deterministic
   * physical name from the stack, stage, and logical ID.
   */
  name?: string;
  /**
   * The Dockerfile to build with — either a **path** to a Dockerfile or the
   * **inline contents** of one. Alchemy tells the two apart by resolving the
   * string against the build context (and cwd): if it points at an existing
   * file it is treated as a path, otherwise as inline contents.
   *
   * - **Bundle mode** (`main` set): the inline contents (or the file's
   *   contents) are the base image; Alchemy appends statements to copy the
   *   bundled program and set the entrypoint. If omitted, a default base
   *   image matching the runtime is used.
   * - **Context mode** (no `main`, `context` set): selects the Dockerfile to
   *   build the context with. A path is passed to `docker build -f`; inline
   *   contents are materialized next to the context. Defaults to
   *   `<context>/Dockerfile`.
   */
  dockerfile?: string;
  /**
   * Directory containing a complete, self-sufficient Docker build context
   * (everything the Dockerfile COPYs). When set without a `main`, the JS
   * bundling pipeline is skipped entirely: no runtime shim, no appended
   * ENTRYPOINT. The directory is built and pushed as-is — use it for non-JS
   * containers (e.g. a prebuilt Rust binary). The image hash folds in every
   * file in the directory (contents + unix mode, symlinks followed, honoring
   * `.dockerignore` and always skipping `.git`), so content changes trigger
   * a rebuild and rollout. Mutually exclusive with `main`.
   */
  context?: string;
  /**
   * Initial number of instances to maintain.
   * @default 1
   */
  instances?: number;
  /**
   * Maximum number of instances the application may scale to.
   * @default 1
   */
  maxInstances?: number;
  /**
   * Scheduling policy used by Cloudflare's containers control plane.
   * @default "default"
   */
  schedulingPolicy?: ContainerApplication.SchedulingPolicy;
  /**
   * Instance type for each deployment.
   * @default "dev"
   */
  instanceType?: ContainerApplication.InstanceType;
  /**
   * Observability settings for the deployment.
   */
  observability?: ContainerApplication.Observability;
  /**
   * SSH public keys to install into the deployment.
   */
  sshPublicKeyIds?: string[];
  /**
   * Secrets exposed to the container runtime as environment variables.
   */
  secrets?: ContainerApplication.Secret[];
  /**
   * CPU allocation override for each deployment.
   */
  vcpu?: number;
  /**
   * Memory allocation override for each deployment.
   */
  memory?: string;
  /**
   * Disk allocation override for each deployment.
   */
  disk?: ContainerApplication.Disk;
  /**
   * Plain environment variables passed to the container runtime.
   */
  environmentVariables?: ContainerApplication.EnvironmentVariable[];
  /**
   * Labels attached to the deployment.
   */
  labels?: ContainerApplication.Label[];
  /**
   * Network configuration for the deployment.
   */
  network?: ContainerApplication.Network;
  /**
   * Command override for the container image.
   */
  command?: string[];
  /**
   * Entrypoint override for the container image.
   */
  entrypoint?: string[];
  /**
   * DNS configuration for the deployment.
   */
  dns?: ContainerApplication.Dns;
  /**
   * Exposed ports for the deployment.
   */
  ports?: ContainerApplication.Port[];
  /**
   * Health and readiness checks for the deployment.
   */
  checks?: ContainerApplication.Check[];
  /**
   * Resource constraints for the application.
   */
  constraints?: ContainerApplication.Constraints;
  /**
   * Affinity hints for scheduling.
   */
  affinities?: ContainerApplication.Affinities;
  /**
   * Progressive rollout settings applied after updates.
   */
  rollout?: ContainerApplication.Rollout;
  /**
   * Container registry host to use for generated Dockerfile builds.
   * @default "registry.cloudflare.com"
   */
  registryId?: string;
  /**
   * Environment variables passed to the container runtime.
   */
  env?: Record<string, any>;
  /**
   * Exports passed to the container runtime.
   */
  exports?: string[];
}

export type ContainerServices =
  | ContainerApplication
  | PlatformServices
  | Server.ProcessServices;

export type ContainerShape = Main<ContainerServices>;

/**
 * @internal
 */
export interface ContainerApplication<Shape = unknown> extends Resource<
  ContainerTypeId,
  ContainerApplicationProps,
  {
    applicationId: string;
    applicationName: string;
    accountId: string;
    schedulingPolicy: ContainerApplication.SchedulingPolicy;
    instances: number;
    maxInstances: number;
    constraints: ContainerApplication.Constraints | undefined;
    affinities: ContainerApplication.Affinities | undefined;
    configuration: ContainerApplication.Configuration;
    durableObjects:
      | {
          namespaceId: string;
        }
      | undefined;
    createdAt: string;
    version: number;
    hash?: {
      image: string;
    };
  },
  {
    /**
     * Durable Object namespace attached to the container application.
     */
    durableObjects?: {
      namespaceId: string;
    };
    env?: Record<string, any>;
  },
  Providers
> {
  /** @internal phantom */
  Shape: Shape;
}

const resolveDurableObjectApplicationRecovery = ({
  namespaceId,
  expectedName,
  existingName,
}: {
  namespaceId: string;
  expectedName: string;
  existingName: string | undefined;
}) => {
  if (!existingName) {
    return {
      canAdopt: false as const,
      message: `Container application for Durable Object namespace "${namespaceId}" already exists but could not be found for adoption.`,
    };
  }
  if (existingName !== expectedName) {
    return {
      canAdopt: false as const,
      message: `Existing container application "${existingName}" is already attached to Durable Object namespace "${namespaceId}". Use that application name to adopt it.`,
    };
  }
  return {
    canAdopt: true as const,
  };
};

const containerApplicationReadinessSchedule = Schedule.exponential(150).pipe(
  Schedule.both(Schedule.recurs(10)),
);

const isContainerApplicationNotFound = (
  error: unknown,
): error is Containers.ContainerApplicationNotFound =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "ContainerApplicationNotFound";

export const retryForContainerApplicationReadiness = <A, E, R>(
  operation: string,
  applicationId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.tapError((error) =>
      isContainerApplicationNotFound(error)
        ? Effect.logDebug(
            `Cloudflare Container ${operation}: application ${applicationId} not found yet, retrying`,
          )
        : Effect.void,
    ),
    Effect.retry({
      while: isContainerApplicationNotFound,
      schedule: containerApplicationReadinessSchedule,
    }),
  );

/**
 * Translate a single `.dockerignore` pattern into a predicate over a
 * context-relative POSIX path. Covers the common subset — `*`/`?`/`**` globs
 * and directory prefixes (matching `foo` also excludes everything under
 * `foo/`). It is not a full reimplementation of Docker's matcher; anything it
 * can't model simply fails to match.
 */
const dockerignoreToRegExp = (pattern: string): RegExp => {
  const body = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "*") {
      if (body[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // Match the path itself or anything nested beneath it.
  return new RegExp(`^${re}(?:/.*)?$`);
};

/**
 * Build an ignore predicate from `.dockerignore` lines plus an always-on `.git`
 * skip (hashing `.git` would make the digest churn on every commit). `!`
 * negations re-include; the last matching rule wins, mirroring Docker's
 * precedence.
 */
const makeContextIgnore = (dockerignore: string | undefined) => {
  const rules: { re: RegExp; negated: boolean }[] = [
    { re: dockerignoreToRegExp(".git"), negated: false },
  ];
  if (dockerignore) {
    for (const raw of dockerignore.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) {
        continue;
      }
      const negated = line.startsWith("!");
      const pattern = (negated ? line.slice(1).trim() : line).replace(
        /\/+$/,
        "",
      );
      if (pattern === "") {
        continue;
      }
      rules.push({ re: dockerignoreToRegExp(pattern), negated });
    }
  }
  return (relPath: string): boolean => {
    let ignored = false;
    for (const { re, negated } of rules) {
      if (re.test(relPath)) {
        ignored = !negated;
      }
    }
    return ignored;
  };
};

export const ContainerProvider = () =>
  Provider.effect(
    Container,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const { dotAlchemy } = yield* AlchemyContext;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

      const telemetry = yield* CloudflareLogs;

      const createApplicationName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          return (
            name ??
            (yield* createPhysicalName({
              id,
              lowercase: true,
            }))
          );
        });

      const findApplicationByName = Effect.fnUntraced(function* (name: string) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        return yield* Containers.listContainerApplications({ accountId }).pipe(
          Effect.map((apps) => apps.find((app) => app.name === name)),
        );
      });

      const findApplicationByNamespace = Effect.fnUntraced(function* (
        namespaceId: string,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        return yield* Containers.listContainerApplications({ accountId }).pipe(
          Effect.map((apps) =>
            apps.find((app) => app.durableObjects?.namespaceId === namespaceId),
          ),
        );
      });

      const desiredConfiguration = (
        props: ContainerApplicationProps,
        imageRef: string,
      ) =>
        normalizeNulls({
          image: imageRef,
          instanceType: props.instanceType,
          observability: props.observability,
          sshPublicKeyIds: props.sshPublicKeyIds,
          secrets: props.secrets,
          vcpu: props.vcpu,
          memory: props.memory,
          disk: props.disk,
          environmentVariables: props.environmentVariables,
          labels: props.labels,
          network: props.network,
          command: props.command,
          entrypoint: props.entrypoint,
          dns: props.dns,
          ports: props.ports,
          checks: props.checks,
        }) as ContainerApplication.Configuration;

      /**
       * Build context for a container image. The mode is decided once, here,
       * so the hashing step and the build step never drift apart:
       *
       * - `bundle` — a JS `main` is bundled into a generated context.
       * - `context` — a caller-supplied directory is built as-is, with its
       *   own `Dockerfile` (path or inline contents, defaulting to
       *   `<context>/Dockerfile`). `dockerfilePath` is what `docker build -f`
       *   receives; `inlineDockerfile`, when set, is materialized there at
       *   build time and folded into the image hash.
       */
      type ContextPlan =
        | { readonly kind: "bundle"; readonly main: string }
        | {
            readonly kind: "context";
            readonly contextDir: string;
            readonly dockerfilePath: string;
            readonly inlineDockerfile: string | undefined;
          };

      /**
       * Resolve which build mode a set of props selects and where its
       * Dockerfile lives. A `dockerfile` string is read as a path when it
       * resolves to an existing file, otherwise as inline contents.
       */
      const resolveContextMode = Effect.fnUntraced(function* (
        id: string,
        props: ContainerApplicationProps,
      ) {
        if (props.main) {
          if (props.context) {
            return yield* Effect.fail(
              new Error(
                "Container: `main` and `context` are mutually exclusive — `main` bundles a JS entrypoint, `context` builds a prebuilt directory as-is.",
              ),
            );
          }
          return { kind: "bundle", main: props.main } as const;
        }
        if (!props.context) {
          return yield* Effect.fail(
            new Error(
              "Container requires a `main` entrypoint or a `context` directory.",
            ),
          );
        }
        const contextDir = props.context;
        if (props.dockerfile === undefined) {
          const dockerfilePath = path.join(contextDir, "Dockerfile");
          if (!(yield* fs.exists(dockerfilePath))) {
            return yield* Effect.fail(
              new Error(
                `Container \`context\` (${contextDir}) has no Dockerfile; add one or set \`dockerfile\` to a path or inline contents.`,
              ),
            );
          }
          return {
            kind: "context",
            contextDir,
            dockerfilePath,
            inlineDockerfile: undefined,
          } as const;
        }
        // A path resolves to an existing file; anything else is inline contents.
        const candidate = path.isAbsolute(props.dockerfile)
          ? props.dockerfile
          : path.join(contextDir, props.dockerfile);
        if (yield* fs.exists(candidate)) {
          return {
            kind: "context",
            contextDir,
            dockerfilePath: candidate,
            inlineDockerfile: undefined,
          } as const;
        }
        // Inline contents: stage them so `docker build -f` can find them.
        const stageDir = yield* getStableContextDir(
          process.cwd(),
          dotAlchemy,
          `${id}-context`,
        );
        return {
          kind: "context",
          contextDir,
          dockerfilePath: path.join(stageDir, "Dockerfile"),
          inlineDockerfile: props.dockerfile,
        } as const;
      });

      /**
       * Hash a prebuilt build context: every non-ignored regular file's
       * contents (streamed, so large binaries aren't buffered whole) plus its
       * unix mode, sorted for an order-stable digest, with the effective
       * Dockerfile folded in. Honors `.dockerignore` and always skips `.git`.
       * `fs.stat` follows symlinks, so links are hashed by their target.
       */
      const hashContext = Effect.fnUntraced(function* (
        plan: Extract<ContextPlan, { kind: "context" }>,
      ) {
        const dockerignorePath = path.join(plan.contextDir, ".dockerignore");
        const dockerignore = (yield* fs.exists(dockerignorePath))
          ? yield* fs.readFileString(dockerignorePath)
          : undefined;
        const isIgnored = makeContextIgnore(dockerignore);

        const entries = yield* fs.readDirectory(plan.contextDir, {
          recursive: true,
        });
        const files: Record<string, { mode: number; hash: string }> = {};
        for (const entry of [...entries].sort()) {
          const rel = entry.split(path.sep).join("/");
          if (isIgnored(rel)) {
            continue;
          }
          const fullPath = path.join(plan.contextDir, entry);
          const info = yield* fs.stat(fullPath);
          if (info.type === "File") {
            files[rel] = {
              mode: info.mode,
              hash: yield* sha256File(fullPath),
            };
          }
        }
        // Fold the effective Dockerfile in so changes to it — inline, or a file
        // living outside the context — still drive the hash.
        const dockerfile =
          plan.inlineDockerfile ??
          (yield* fs.readFileString(plan.dockerfilePath));
        return yield* sha256Object({ files, dockerfile });
      });

      /**
       * Resolve the `dockerfile` prop to Dockerfile contents. A string that
       * resolves (against cwd) to an existing file is read as a path;
       * otherwise it is taken as inline contents. Used in bundle mode, where
       * the resolved contents become the base image `buildFinalDockerfile`
       * appends to.
       */
      const resolveDockerfileContents = Effect.fnUntraced(function* (
        dockerfile: string | undefined,
      ) {
        if (dockerfile === undefined) {
          return undefined;
        }
        const candidate = path.isAbsolute(dockerfile)
          ? dockerfile
          : path.join(process.cwd(), dockerfile);
        return (yield* fs.exists(candidate))
          ? yield* fs.readFileString(candidate)
          : dockerfile;
      });

      const computeImageHash = Effect.fnUntraced(function* (
        id: string,
        props: ContainerApplicationProps,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const plan = yield* resolveContextMode(id, props);

        const imageRefFor = (imageHash: string) =>
          Effect.gen(function* () {
            const name = yield* createApplicationName(id, props.name);
            const registryId = props.registryId ?? "registry.cloudflare.com";
            const repositoryName = name.toLowerCase();
            return `${registryId}/${accountId}/${repositoryName}:${imageHash}`;
          });

        if (plan.kind === "context") {
          const imageHash = (yield* hashContext(plan)).slice(0, 16);
          const imageRef = yield* imageRefFor(imageHash);
          return { files: [], imageRef, imageHash };
        }

        const runtime = props.runtime ?? "bun";
        const { files, hash: bundleHash } = yield* bundleProgram({
          id,
          main: plan.main,
          runtime,
          handler: props.handler,
          isExternal: props.isExternal,
          external: props.external,
        });

        const finalDockerfile = buildFinalDockerfile(
          yield* resolveDockerfileContents(props.dockerfile),
          runtime,
          props.external,
          props.autoInstallExternals,
        );
        const imageHash = (yield* sha256Object({
          bundleHash,
          dockerfile: finalDockerfile,
        })).slice(0, 16);
        const imageRef = yield* imageRefFor(imageHash);

        return { files, imageRef, imageHash };
      });

      const bundleProgram = Effect.fnUntraced(function* ({
        main,
        runtime,
        handler = "default",
        isExternal = false,
        external = [],
      }: {
        id: string;
        main: string;
        runtime: "bun" | "node";
        handler: string | undefined;
        isExternal?: boolean;
        external?: string[];
      }) {
        const realMain = yield* fs.realPath(main);
        const cwd = yield* findCwdForBundle(realMain);

        const buildBundle = Effect.fnUntraced(function* (
          entry: string,
          plugins?: rolldown.RolldownPluginOption,
        ) {
          return yield* Bundle.build(
            {
              input: entry,
              cwd,
              external: [
                "cloudflare:workers",
                "cloudflare:workflows",
                ...(runtime === "bun" ? ["bun", "bun:*"] : []),
                ...external,
              ],
              platform: "node",
              resolve: {
                conditionNames:
                  runtime === "bun"
                    ? ["bun", "import", "module", "default"]
                    : ["node", "import", "module", "default"],
              },
              plugins,
              treeshake: true,
            },
            {
              format: "esm",
              sourcemap: false,
              minify: true,
              entryFileNames: "index.js",
            },
          );
        });

        const bundleOutput = isExternal
          ? yield* buildBundle(realMain)
          : yield* buildBundle(
              realMain,
              virtualEntryPlugin(
                (importPath) => `
${
  runtime === "bun"
    ? `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
const HttpServer = BunHttpServer;
`
    : `
import { NodeServices } from "@effect/platform-node";
import { NodeHttpServer } from "alchemy/Http";
const HttpServer = NodeHttpServer;
`
}
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer } from "alchemy/Runtime";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Context from "effect/Context";
import { MinimumLogLevel } from "effect/References";

import ${handler === "default" ? "entrypoint" : `{ ${handler} as entrypoint }`} from ${JSON.stringify(importPath)};

const tag = Context.Service("${Self.key}")
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  ${runtime === "bun" ? "BunServices.layer" : "NodeServices.layer"},
  FetchHttpClient.layer,
  // TODO(sam): wire this up to telemetry more directly
  Logger.layer([Logger.consolePretty()]),
);

const stack = Layer.succeed(Stack, {
  name: ${JSON.stringify(stack.name)},
  stage: ${JSON.stringify(stack.stage)},
  bindings: {},
  resources: {}
});

const serverEffect = tag.pipe(
  Effect.flatMap(func => func.RuntimeContext.exports),
  Effect.flatMap(exports => exports.default),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      Layer.provideMerge(HttpServer()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          MinimumLogLevel,
          process.env.DEBUG ? "Debug" : "Info",
        )
      ),
    )
  ),
  Effect.scoped
);

console.log("Container bootstrap starting...");
await Effect.runPromise(serverEffect).catch((err) => {
  console.error("Container bootstrap failed:", err);
  process.exit(1);
})`,
              ),
            );

        // Rolldown can emit multiple chunk files (entry + shared chunks).
        // Return every file so downstream code can materialize all of them
        // into the Docker build context — dropping any of them produces a
        // `Cannot find module './chunk-XXX.js'` runtime crash inside the
        // container (with zero stdout, because it crashes before any user
        // code runs).
        const files = bundleOutput.files.map((f) => ({
          path: f.path,
          content:
            typeof f.content === "string"
              ? new TextEncoder().encode(f.content)
              : f.content,
        }));

        return { files, hash: bundleOutput.hash };
      });

      const buildFinalDockerfile = (
        userDockerfile: string | undefined,
        runtime: "bun" | "node",
        external: string[] = [],
        autoInstallExternals = true,
      ): string => {
        const base =
          userDockerfile?.trim() ??
          (runtime === "bun" ? "FROM oven/bun:1" : "FROM node:22-slim");
        const runtimeBin = runtime === "bun" ? "bun" : "node";
        const installCmd = runtime === "bun" ? "bun add" : "npm install";
        const installStep =
          autoInstallExternals && external.length > 0
            ? `RUN ${installCmd} ${external.join(" ")}`
            : "";
        return [
          base,
          "",
          "WORKDIR /app",
          ...(installStep ? [installStep, ""] : []),
          "COPY index.mjs /app/index.mjs",
          // Copy any additional rolldown chunks (`chunk-XXX.js`,
          // `BunServices-YYY.js`, …). The glob matches zero or more files;
          // non-trivial bundles always emit at least one chunk, minimal
          // bundles emit none and the COPY no-ops.
          "COPY *.js /app/",
          `ENTRYPOINT ["${runtimeBin}", "/app/index.mjs"]`,
          "",
        ].join("\n");
      };

      const buildAndPushImage = Effect.fnUntraced(function* (
        id: string,
        props: ContainerApplicationProps,
        files: ReadonlyArray<{ path: string; content: Uint8Array }>,
        imageRef: string,
        session?: { note: (message: string) => Effect.Effect<void> },
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const runtime = props.runtime ?? "bun";

        yield* Effect.logInfo(
          `Cloudflare Container image: building ${imageRef}`,
        );
        if (session) {
          yield* session.note(`Building container image ${imageRef}...`);
        }

        const plan = yield* resolveContextMode(id, props);

        if (plan.kind === "context") {
          // Context mode: build the caller's directory as-is — no bundle
          // files, no appended ENTRYPOINT. Inline Dockerfile contents are
          // materialized next to the context so `-f` can point at them.
          if (plan.inlineDockerfile !== undefined) {
            yield* materializeDockerfile(
              plan.inlineDockerfile,
              path.dirname(plan.dockerfilePath),
            );
          }
          yield* dockerBuild({
            tag: imageRef,
            context: plan.contextDir,
            dockerfile: plan.dockerfilePath,
            platform: "linux/amd64",
          });
        } else {
          const contextDir = yield* getStableContextDir(
            process.cwd(),
            dotAlchemy,
            `${id}-container`,
          );
          const finalDockerfile = buildFinalDockerfile(
            yield* resolveDockerfileContents(props.dockerfile),
            runtime,
            props.external,
            props.autoInstallExternals,
          );
          yield* materializeDockerfile(finalDockerfile, contextDir);
          yield* writeContextFiles(
            contextDir,
            files.map((f, i) => ({
              // Keep the entry rename to `index.mjs` so the Dockerfile
              // ENTRYPOINT (`ENTRYPOINT ["bun", "/app/index.mjs"]`) stays
              // valid; preserve rolldown-assigned fileNames for every other
              // chunk so intra-bundle relative imports resolve at runtime.
              path: i === 0 ? "index.mjs" : f.path,
              content: f.content,
            })),
          );
          yield* dockerBuild({
            tag: imageRef,
            context: contextDir,
            platform: "linux/amd64",
          });
        }

        yield* Effect.logInfo(
          `Cloudflare Container image: pushing ${imageRef}`,
        );
        if (session) {
          yield* session.note(`Pushing container image ${imageRef}...`);
        }

        const registryId = props.registryId ?? "registry.cloudflare.com";
        const credentials =
          yield* Containers.createContainerRegistryCredentials({
            accountId,
            registryId,
            permissions: ["pull", "push"],
            expirationMinutes: 60,
          });
        const username = credentials.username ?? (credentials as any).user;
        if (!username) {
          return yield* Effect.fail(
            new Error(
              "Cloudflare registry credentials did not include a username.",
            ),
          );
        }

        yield* pushImage(imageRef, {
          username,
          password: credentials.password,
          server: registryId,
        });
      });

      const maybeCreateRollout = Effect.fnUntraced(function* ({
        applicationId,
        configuration,
        rollout,
      }: {
        applicationId: string;
        configuration: ContainerApplication.Configuration;
        rollout: ContainerApplication.Rollout | undefined;
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const strategy = rollout?.strategy ?? "immediate";
        const stepPercentage =
          strategy === "immediate" ? 100 : (rollout?.stepPercentage ?? 25);

        yield* retryForContainerApplicationReadiness(
          "rollout",
          applicationId,
          Containers.createContainerApplicationRollout({
            accountId,
            applicationId,
            description:
              strategy === "immediate"
                ? "Immediate update"
                : "Progressive update",
            strategy: "rolling",
            kind: rollout?.kind ?? "full_auto",
            stepPercentage,
            targetConfiguration: configuration,
          }),
        );
      });

      const createApplication = Effect.fnUntraced(function* ({
        id,
        news,
        name,
        configuration,
        durableObjects,
        session,
      }: {
        id: string;
        news: ContainerApplicationProps;
        name: string;
        configuration: ContainerApplication.Configuration;
        durableObjects:
          | {
              namespaceId: string;
            }
          | undefined;
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const describeError = (error: unknown) => {
          if (error instanceof Error) {
            return JSON.stringify(
              Object.fromEntries(
                Object.getOwnPropertyNames(error).map((key) => [
                  key,
                  (error as unknown as Record<string, unknown>)[key],
                ]),
              ),
              null,
              2,
            );
          }
          return String(error);
        };

        // Engine has cleared us via `read` (foreign-named applications are
        // surfaced as `Unowned`). Re-fetch the existing application to fold
        // it into the upsert path.
        const existingByName = yield* findApplicationByName(name);

        if (existingByName) {
          yield* Effect.logInfo(
            `Cloudflare Container create: adopting existing application ${name}`,
          );
          return yield* upsertApplication({
            id,
            news,
            existing: toAttributes(existingByName),
            session,
          });
        }

        yield* Effect.logInfo(
          `Cloudflare Container create: creating application ${name}`,
        );
        yield* session.note(`Creating container application ${name}...`);
        const adoptExistingByName = Effect.gen(function* () {
          yield* Effect.logInfo(
            `Cloudflare Container create: application ${name} already exists, adopting`,
          );
          const existing = yield* findApplicationByName(name);
          if (!existing) {
            return yield* Effect.fail(
              new Error(
                `Container application "${name}" already exists but could not be found for adoption.`,
              ),
            );
          }
          return yield* upsertApplication({
            id,
            news,
            existing: toAttributes(existing),
            session,
          });
        });

        const application = yield* Containers.createContainerApplication({
          accountId,
          name,
          instances: news.instances ?? 1,
          maxInstances: news.maxInstances ?? 1,
          schedulingPolicy: news.schedulingPolicy ?? "default",
          constraints: news.constraints ?? {},
          affinities: news.affinities,
          configuration,
          durableObjects,
        }).pipe(
          Effect.catchTag("DurableObjectAlreadyHasApplication", () =>
            durableObjects
              ? Effect.gen(function* () {
                  const existing = yield* findApplicationByNamespace(
                    durableObjects.namespaceId,
                  );
                  const recovery = resolveDurableObjectApplicationRecovery({
                    namespaceId: durableObjects.namespaceId,
                    expectedName: name,
                    existingName: existing?.name,
                  });
                  if (!recovery.canAdopt) {
                    return yield* Effect.fail(new Error(recovery.message));
                  }
                  if (!existing) {
                    return yield* Effect.fail(
                      new Error(
                        `Container application for Durable Object namespace "${durableObjects.namespaceId}" already exists but could not be found for adoption.`,
                      ),
                    );
                  }
                  return yield* upsertApplication({
                    id,
                    news,
                    existing: toAttributes(existing),
                    session,
                  });
                })
              : Effect.fail(
                  new Error(
                    "Durable Object namespace already has a container application. Set AdoptPolicy to adopt it.",
                  ),
                ),
          ),
          Effect.catchIf(
            (e) =>
              "message" in (e as any) &&
              String((e as any).message).includes("already exists"),
            () => adoptExistingByName,
          ),
          Effect.tapError((error) =>
            Effect.logError(
              `Cloudflare Container create error: ${describeError(error)}`,
            ),
          ),
        );

        return "applicationId" in application
          ? application
          : toAttributes(application);
      });

      const upsertApplication = Effect.fnUntraced(function* ({
        id,
        news,
        existing,
        session,
      }: {
        id: string;
        news: ContainerApplicationProps;
        existing: ContainerApplication["Attributes"];
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* Effect.logInfo(
          `Cloudflare Container update: preparing ${existing.applicationName}`,
        );
        const { files, imageRef, imageHash } = yield* computeImageHash(
          id,
          news,
        );
        const configuration = desiredConfiguration(news, imageRef);

        if (imageHash !== existing.hash?.image) {
          yield* buildAndPushImage(id, news, files, imageRef, session);
        }

        yield* session.note(
          `Updating container application ${existing.applicationName}...`,
        );
        const application = yield* retryForContainerApplicationReadiness(
          "update",
          existing.applicationId,
          Containers.updateContainerApplication({
            accountId,
            applicationId: existing.applicationId,
            instances: news.instances ?? 1,
            maxInstances: news.maxInstances ?? 1,
            schedulingPolicy: news.schedulingPolicy ?? "default",
            constraints: news.constraints ?? {},
            affinities: news.affinities,
            configuration,
          }),
        );
        const updated = toAttributes(application);
        if (!deepEqual(existing.configuration, configuration)) {
          yield* Effect.logInfo(
            `Cloudflare Container update: creating rollout for ${updated.applicationName}`,
          );
          yield* maybeCreateRollout({
            applicationId: updated.applicationId,
            configuration,
            rollout: news.rollout,
          });
        }
        return { ...updated, configuration, hash: { image: imageHash } };
      });

      const getDurableObjects = (
        bindings: ResourceBinding<ContainerApplication["Binding"]>[],
      ) => {
        const dos = bindings.flatMap((b) =>
          b.data.durableObjects ? [b.data.durableObjects] : [],
        );
        // A single DO namespace may appear in multiple bindings (e.g. when
        // a Container is referenced by several resources). Dedupe by namespaceId.
        const uniqueDos = dos.filter(
          (d, i, arr) =>
            arr.findIndex((other) => other.namespaceId === d.namespaceId) === i,
        );
        if (uniqueDos.length === 0) {
          return Effect.succeed(undefined);
        }
        if (uniqueDos.length === 1) {
          return Effect.succeed(uniqueDos[0]);
        }
        return Effect.die(
          new Error(
            `A Container can only be bound to one Durable Object namespace. Found ${uniqueDos.length} unique namespaces in bindings: ${uniqueDos.map((d) => d.namespaceId).join(", ")}`,
          ),
        );
      };

      return Container.Provider.of({
        stables: ["applicationId", "accountId"],
        diff: Effect.fnUntraced(function* ({
          id,
          olds = {},
          news = {},
          output,
          newBindings,
          oldBindings,
        }) {
          if (!isResolved(news) || !isResolved(newBindings)) {
            return undefined;
          }
          const { accountId } = yield* yield* CloudflareEnvironment;

          const name = yield* createApplicationName(id, news.name);
          const oldName = output?.applicationName
            ? output.applicationName
            : yield* createApplicationName(id, olds.name);

          if (
            (output?.accountId ?? accountId) !== accountId ||
            name !== oldName
          ) {
            return { action: "replace" } as const;
          }

          const hasDurableObjects =
            (yield* getDurableObjects(newBindings)) !== undefined;
          const hadDurableObjects =
            (yield* getDurableObjects(oldBindings)) !== undefined;
          if (hasDurableObjects !== hadDurableObjects) {
            return { action: "replace" } as const;
          }

          if (!output) {
            return undefined;
          }

          const { imageHash } = yield* computeImageHash(id, news);
          if (imageHash !== output.hash?.image) {
            return { action: "update" } as const;
          }
        }),
        precreate: Effect.fnUntraced(function* ({ id, news = {}, session }) {
          const name = yield* createApplicationName(id, news.name);
          yield* Effect.logInfo(
            `Cloudflare Container precreate: starting ${name}`,
          );

          const { files, imageRef, imageHash } = yield* computeImageHash(
            id,
            news,
          );
          const configuration = desiredConfiguration(news, imageRef);
          yield* buildAndPushImage(id, news, files, imageRef, session);

          // Precreate intentionally omits the Durable Object attachment so the
          // worker can bind to this application id and break the circular
          // dependency. The final create step recreates the application with the
          // resolved namespace when needed.
          const result = yield* createApplication({
            id,
            news,
            name,
            configuration,
            durableObjects: undefined,
            session: {
              ...session,
              note: (message) =>
                session.note(message.replace("Creating", "Pre-creating")),
            },
          });
          return {
            ...("applicationId" in result ? result : toAttributes(result)),
            hash: { image: imageHash },
          };
        }),
        reconcile: Effect.fnUntraced(function* ({
          id,
          news = {},
          bindings,
          output,
          session,
        }) {
          const name = yield* createApplicationName(id, news.name);
          yield* Effect.logInfo(
            `Cloudflare Container reconcile: starting ${name}`,
          );
          const durableObjects = yield* getDurableObjects(bindings);
          const { files, imageRef, imageHash } = yield* computeImageHash(
            id,
            news,
          );
          const configuration = desiredConfiguration(news, imageRef);

          // Observe — re-fetch the cached application to confirm it still
          // exists. Cloudflare reports a deleted container application as
          // `ContainerApplicationNotFound`; we fall back to a name lookup
          // so we can recover from out-of-band deletes or partial state
          // persistence failures.
          let existing: ContainerApplication["Attributes"] | undefined;
          if (output?.applicationId) {
            existing = yield* Containers.getContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.map((app) => ({
                ...toAttributes(app),
                hash: output.hash,
              })),
              Effect.catchTag("ContainerApplicationNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          if (!existing) {
            const found = yield* findApplicationByName(name);
            if (found) {
              existing = {
                ...toAttributes(found),
                hash: output?.hash,
              };
            }
          }

          // Special case: precreate produced an application without the
          // durable object attachment, but the real reconcile now has one
          // (or vice versa). The DO attachment is immutable, so we delete
          // and recreate. Adoption-by-namespace is preferred when an app
          // already owns the namespace.
          if (existing && !deepEqual(existing.durableObjects, durableObjects)) {
            if (durableObjects) {
              const owner = yield* findApplicationByNamespace(
                durableObjects.namespaceId,
              );
              const recovery = resolveDurableObjectApplicationRecovery({
                namespaceId: durableObjects.namespaceId,
                expectedName: name,
                existingName: owner?.name,
              });
              if (recovery.canAdopt) {
                if (!owner) {
                  return yield* Effect.fail(
                    new Error(
                      `Container application for Durable Object namespace "${durableObjects.namespaceId}" already exists but could not be found for adoption.`,
                    ),
                  );
                }
                return yield* upsertApplication({
                  id,
                  news,
                  existing: toAttributes(owner),
                  session,
                });
              }
            }
            yield* Effect.logInfo(
              `Cloudflare Container reconcile: recreating ${name} to attach durable object binding`,
            );
            yield* session.note(
              `Recreating container application ${name} with durable object binding...`,
            );
            yield* Containers.deleteContainerApplication({
              accountId: existing.accountId,
              applicationId: existing.applicationId,
            }).pipe(
              Effect.catchTag(
                "ContainerApplicationNotFound",
                () => Effect.void,
              ),
            );
            if (imageHash !== existing.hash?.image) {
              yield* buildAndPushImage(id, news, files, imageRef, session);
            }
            const result = yield* createApplication({
              id,
              news,
              name,
              configuration,
              durableObjects,
              session,
            });
            return {
              ...("applicationId" in result ? result : toAttributes(result)),
              hash: { image: imageHash },
            };
          }

          // Sync — application exists with correct DO attachment. Apply
          // the desired configuration (image + scheduling + secrets, etc.)
          // through the upsert path, which builds and pushes the image
          // only when the hash changed and creates a rollout if the
          // configuration drifted.
          if (existing) {
            return yield* upsertApplication({
              id,
              news,
              existing,
              session,
            });
          }

          // Ensure — no application exists. Build and push the image,
          // then create. `createApplication` itself tolerates concurrent
          // creates by adopting an existing application with the same
          // name or namespace.
          yield* buildAndPushImage(id, news, files, imageRef, session);
          const result = yield* createApplication({
            id,
            news,
            name,
            configuration,
            durableObjects,
            session,
          });
          return {
            ...("applicationId" in result ? result : toAttributes(result)),
            hash: { image: imageHash },
          };
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
          yield* Effect.logInfo(
            `Cloudflare Container delete: deleting ${output.applicationName}`,
          );
          yield* Containers.deleteContainerApplication({
            accountId: output.accountId,
            applicationId: output.applicationId,
          }).pipe(
            Effect.catchTag("ContainerApplicationNotFound", () => Effect.void),
          );
        }),
        read: Effect.fnUntraced(function* ({ id, olds, output }) {
          const readByName = (name: string) =>
            Effect.gen(function* () {
              yield* Effect.logInfo(
                `Cloudflare Container read: looking up ${name}`,
              );
              const existing = yield* findApplicationByName(name);
              if (!existing) {
                yield* Effect.logInfo(
                  `Cloudflare Container read: ${name} not found`,
                );
                return undefined;
              }
              return {
                ...toAttributes(existing),
                hash: output?.hash,
              };
            });

          let attrs: ContainerApplication["Attributes"] | undefined;
          if (output?.applicationId) {
            yield* Effect.logInfo(
              `Cloudflare Container read: checking ${output.applicationName}`,
            );
            attrs = yield* Containers.getContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.map((app) => ({
                ...toAttributes(app),
                hash: output.hash,
              })),
              Effect.catchTag("ContainerApplicationNotFound", () =>
                readByName(output.applicationName),
              ),
            );
            // If we matched by id from prior state, treat as owned.
            return attrs;
          }

          const name = yield* createApplicationName(id, olds?.name);
          attrs = yield* readByName(name);
          if (!attrs) return undefined;
          // Cloudflare container applications carry no ownership signal that
          // we can read back from the API, so a name match is not proof of
          // ownership. Brand it `Unowned` so the engine surfaces
          // `OwnedBySomeoneElse` unless the caller opted in via `--adopt`.
          return Unowned(attrs);
        }),
        tail: ({ output }) =>
          telemetry.tailStream({
            accountId: output.accountId,
            filters: containerFilters(output.applicationId),
          }),
        logs: ({ output, options }) =>
          telemetry.queryLogs({
            accountId: output.accountId,
            filters: containerFilters(output.applicationId),
            options,
          }),
      });
    }),
  );

const containerFilters = (applicationId: string): TelemetryFilter[] => [
  {
    key: "$metadata.type",
    operation: "eq",
    type: "string",
    value: "cf-container",
  },
  {
    key: "$metadata.service",
    operation: "eq",
    type: "string",
    value: applicationId,
  },
];

const toAttributes = (
  application:
    | Containers.CreateContainerApplicationResponse
    | Containers.UpdateContainerApplicationResponse
    | Containers.GetContainerApplicationResponse,
): ContainerApplication["Attributes"] => ({
  applicationId: application.id,
  applicationName: application.name,
  accountId: application.accountId,
  schedulingPolicy: application.schedulingPolicy,
  instances: application.instances,
  maxInstances: application.maxInstances,
  constraints: normalizeNulls(
    application.constraints as ContainerApplication.Constraints | undefined,
  ),
  affinities: normalizeNulls(
    application.affinities as ContainerApplication.Affinities | undefined,
  ),
  configuration: normalizeNulls(
    application.configuration as ContainerApplication.Configuration,
  ),
  durableObjects: normalizeNulls(application.durableObjects) as
    | { namespaceId: string }
    | undefined,
  createdAt: application.createdAt,
  version: application.version,
});
