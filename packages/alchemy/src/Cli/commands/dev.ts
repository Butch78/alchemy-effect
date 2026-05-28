import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Command from "effect/unstable/cli/Command";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import type { Plugin, PluginContext, ResolvedId } from "rolldown";
import * as Bundle from "../../Bundle/Bundle.ts";
import { SPAWNER_URL_ENV_KEY } from "../../Local/RpcProviderProxy.ts";
import * as RpcSpawner from "../../Local/RpcSpawner.ts";
import { envFile, force, profile, script, stage } from "./_shared.ts";
import { ExecStackOptions } from "./deploy.ts";

export const devCommand = Command.make(
  "dev",
  {
    force,
    main: script,
    envFile,
    stage,
    profile,
  },
  Effect.fn(
    function* (args) {
      if (typeof globalThis.Bun !== "undefined") {
        yield* spawnBun(args);
      } else {
        yield* spawnNode(args);
      }
    },
    (effect, args) =>
      Effect.provide(
        RpcSpawner.layerServer({
          profile: args.profile,
          envFile: Option.getOrUndefined(args.envFile),
        }),
      )(effect),
  ),
);

const makeEnv = (options: ExecStackOptions) =>
  Effect.zipWith(
    RpcSpawner.RpcSpawner.useSync((spawner) => spawner.url),
    Schema.encodeEffect(ExecStackOptions)({ ...options, yes: true, dev: true }),
    (url, options) => ({
      ALCHEMY_EXEC_OPTIONS: JSON.stringify(options),
      [SPAWNER_URL_ENV_KEY]: url,
    }),
    { concurrent: true },
  );

const spawnBun = (args: ExecStackOptions) =>
  makeEnv(args).pipe(
    Effect.flatMap((env) =>
      ChildProcess.make(
        "bun",
        [
          "run",
          ...process.execArgv,
          "--watch",
          "--no-clear-screen",
          fileURLToPath(import.meta.resolve("alchemy/bin/exec.ts")),
        ],
        {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          extendEnv: true,
          detached: false,
          env,
        },
      ),
    ),
    Effect.flatMap((child) => child.exitCode),
  );

const spawnNode = (args: ExecStackOptions) =>
  Effect.gen(function* () {
    const main = yield* bundleNode(args.main);
    const env = yield* makeEnv({
      ...args,
      main,
    });
    const child = yield* ChildProcess.make(
      "node",
      [
        ...process.execArgv,
        "--import",
        main,
        "--watch",
        "--watch-preserve-output",
        fileURLToPath(import.meta.resolve("alchemy/bin/exec.js")),
      ],
      {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        extendEnv: true,
        detached: false,
        env,
      },
    );
    yield* child.exitCode;
  });

const NODE_BUILTIN_MODULES = [
  /^node:/,
  new RegExp(`^${builtinModules.join("|")}$`),
];
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/;

const bundleNode = (input: string) =>
  Effect.gen(function* () {
    const path = yield* Path;
    const ENTRY_DIR = ".alchemy/bundles/entry";
    const bundle = Bundle.watch(
      {
        input,
        external: NODE_BUILTIN_MODULES,
        platform: "node",
        plugins: [ExternalNodeModulesPlugin()],
      },
      {
        format: "esm",
        dir: ENTRY_DIR,
        sourcemap: false,
      },
      { pure: false },
    );
    const main = yield* Deferred.make<string>();
    yield* bundle.pipe(
      Stream.tap((event) =>
        event._tag === "Success"
          ? Deferred.succeed(
              main,
              path.resolve(ENTRY_DIR, event.output.files[0].path),
            )
          : Effect.void,
      ),
      Stream.runDrain,
      Effect.forkScoped,
    );
    return yield* Deferred.await(main);
  });

function ExternalNodeModulesPlugin(): Plugin {
  const NODE_MODULES = "/node_modules/";
  function parseNodeModulesPath(
    id: string,
  ): [name: string, subpath: string, root: string] | undefined {
    const slashed = id.replaceAll("\\", "/");
    const lastNmIdx = slashed.lastIndexOf(NODE_MODULES);
    if (lastNmIdx === -1) return;

    const afterNm = slashed.slice(lastNmIdx + NODE_MODULES.length);

    const [name, subpath] = parsePackageSpecifier(afterNm);
    const root = slashed.slice(
      0,
      lastNmIdx + NODE_MODULES.length + name.length,
    );

    return [name, subpath, root];
  }
  function parsePackageSpecifier(id: string): [name: string, subpath: string] {
    const [first, second] = id.split("/", 3);

    const name = first[0] === "@" && second ? `${first}/${second}` : first;
    const subpath = id.slice(name.length);

    return [name, subpath];
  }

  async function resolveDepSubpath(
    this: PluginContext,
    id: string,
    resolved: ResolvedId | null,
  ) {
    if (!resolved?.packageJsonPath) return;

    const parts = id.split("/");
    // ignore scope
    if (parts[0][0] === "@") parts.shift();
    // ignore no subpath or file imports
    if (parts.length === 1 || parts.at(-1)!.includes(".")) return;

    let pkgJson: Record<string, any>;
    try {
      pkgJson = JSON.parse(
        await this.fs.readFile(resolved.packageJsonPath, {
          encoding: "utf8",
        }),
      );
    } catch {
      return;
    }

    // no `exports` field
    if (pkgJson.exports) return;

    const parsed = parseNodeModulesPath(resolved.id);
    if (!parsed) return;

    const result = parsed[0] + parsed[1];
    if (result === id) return;

    return result;
  }

  const isAlchemyModule = (id: string) =>
    id === "alchemy" ||
    id.match(/^@alchemy\.run\/.+$/) ||
    id.match(/^alchemy\/.+$/);

  return {
    name: "alchemy:external-node-modules",
    resolveId: {
      filter: {
        id: {
          exclude: NODE_BUILTIN_MODULES,
        },
      },
      async handler(source, importer, options) {
        const resolved = await this.resolve(source, importer, options);
        if (
          resolved &&
          (resolved.external ||
            NODE_MODULES_RE.test(resolved.id) ||
            isAlchemyModule(resolved.id) ||
            isAlchemyModule(source))
        ) {
          const id = await resolveDepSubpath.call(this, source, resolved);
          return {
            ...resolved,
            id: id ?? resolved.id,
            external: true,
          };
        }
        return resolved;
      },
    },
  };
}
