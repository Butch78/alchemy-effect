import { BunServices } from "@effect/platform-bun";
import bun from "bun:test";
import { ConfigProvider } from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { HookOptions } from "node:test";
import * as Apply from "../Apply.ts";
import { provideFreshArtifactStore } from "../Artifacts.ts";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { DotAlchemy, dotAlchemy } from "../Config.ts";
import type { Input } from "../Input.ts";
import * as Plan from "../Plan.ts";
import { type CompiledStack, type StackServices } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import * as State from "../State/index.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { TestCli } from "./TestCli.ts";

export type ProvidedServices = StackServices;

type TestEffect<A, Req = never> = Effect.Effect<
  A,
  any,
  | BunServices.BunServices
  | HttpClient
  | Scope
  | AuthProviders
  | DotAlchemy
  | State.State
  | Req
>;

const platform = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

// CLI/reporting + dotAlchemy (state store is composed separately so
// callers can override it per-test via `deploy`/`destroy` options).
const alchemy = Layer.mergeAll(
  // CLI.inkCLI(),
  // optional
  Logger.layer([Logger.consolePretty()]),
  dotAlchemy,
);

/**
 * Fallback `State` layer. Applied at the outermost level by `run`,
 * so any test that wants a different backend just wraps its
 * `deploy`/`destroy` call with its own `Effect.provide(…)` — the
 * inner provide wins the State requirement before this fallback is
 * reached.
 *
 * ```ts
 * // uses LocalState (default)
 * yield* deploy(Stack);
 *
 * // uses HttpStateStore
 * yield* deploy(Stack).pipe(Effect.provide(HttpStateStore));
 * ```
 */
const defaultState: Layer.Layer<State.State, never, BunServices.BunServices> =
  State.LocalState;

const run = <A>(effect: TestEffect<A>) =>
  Effect.gen(function* () {
    const configProvider = yield* loadConfigProvider(Option.none());

    return yield* effect.pipe(
      provideFreshArtifactStore,
      Effect.provide(Layer.succeed(ConfigProvider, configProvider)),
    );
  }).pipe(
    Effect.provideService(AuthProviders, {}),
    // `defaultState` is provided outside `exec` too so plain `test(...)`
    // bodies (which don't go through `deploy`/`destroy`) still have a
    // `State` service available.
    Effect.provide(defaultState),
    Effect.provide(Layer.provideMerge(alchemy, platform)),
    Effect.scoped,
    Effect.runPromise,
  );

export const it = test;

export const expect = bun.expect;

export function test(
  name: string,
  test: TestEffect<void>,
  options?: bun.TestOptions,
) {
  bun.test(name, () => run(test), options);
}

export namespace test {
  export function skipIf(condition: boolean) {
    return (
      name: string,
      test: TestEffect<void>,
      options?: bun.TestOptions,
    ) => {
      bun.test.skipIf(condition)(name, () => run(test), options);
    };
  }

  export function skip(
    name: string,
    test: TestEffect<void>,
    options?: bun.TestOptions,
  ) {
    bun.test.skip(name, () => run(test), options);
  }

  export function only(
    name: string,
    test: TestEffect<void>,
    options?: bun.TestOptions,
  ) {
    bun.test.only(name, () => run(test), options);
  }

  export function todo(
    name: string,
    test: TestEffect<void>,
    options?: bun.TestOptions,
  ) {
    bun.test.todo(name, () => run(test), options);
  }
}

export const describe = bun.describe;

export function beforeAll<A>(eff: TestEffect<A>, options?: HookOptions) {
  let a: A;
  bun.beforeAll(
    () => run(eff).then((v) => (a = v)),
    options ?? {
      timeout: 120_000,
    },
  );
  return Effect.sync(() => a);
}

export function beforeEach(eff: TestEffect<void>, options?: HookOptions) {
  bun.beforeEach(() => run(eff), options);
}

export function afterAll(eff: TestEffect<any>, options?: HookOptions) {
  bun.afterAll(() => run(eff), options);
}

export namespace afterAll {
  export const skipIf =
    (predicate: boolean) => (test: TestEffect<void>, options?: HookOptions) => {
      if (predicate) {
      } else {
        bun.afterAll(
          () => run(test),
          options ?? {
            timeout: 120_000,
          },
        );
      }
    };
}

export function afterEach(eff: TestEffect<void>, options?: HookOptions) {
  bun.afterEach(() => run(eff), options);
}

export const deploy = <A>(
  effect: TestEffect<CompiledStack<A>, Stage | DotAlchemy>,
  options?: {
    /** @default test */
    stage?: string;
  },
) =>
  exec(
    effect,
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* Plan.make(stack);
        const output = yield* Apply.apply(plan);
        return output as Input.Resolve<A>;
      }),
    options,
  );

export const destroy = (
  effect: TestEffect<CompiledStack, Stage | DotAlchemy>,
  options?: {
    /** @default test */
    stage?: string;
  },
) =>
  exec(
    effect,
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* Plan.make({
          ...stack,
          // zero these out (destroy will treat all as orphans)
          // TODO(sam): probably better to have Plan.destroy and Plan.update
          resources: {},
          bindings: {},
          output: {},
        });
        yield* Apply.apply(plan);
      }),
    options,
  );

const exec = <A, B>(
  effect: TestEffect<CompiledStack<A>, Stage | DotAlchemy>,
  fn: (stack: CompiledStack<A>) => Effect.Effect<B, any, any>,
  options?: {
    /** @default test */
    stage?: string;
  },
) =>
  Effect.gen(function* () {
    const stack = yield* effect;
    const configProvider = yield* loadConfigProvider(Option.none());

    return yield* fn(stack).pipe(
      provideFreshArtifactStore,
      Effect.provide(stack.services),
      Effect.provide(Layer.succeed(ConfigProvider, configProvider)),
    );
  }).pipe(
    // `State` is intentionally NOT provided here — its requirement
    // propagates up so a caller can override it with
    // `deploy(Stack).pipe(Effect.provide(MyState))`. The outer `run`
    // applies `defaultState` as a fallback.
    Effect.provideService(AuthProviders, {}),
    Effect.provide(Layer.succeed(Stage, options?.stage ?? "test")),
    Effect.provide(TestCli),
    Effect.provide(Layer.provideMerge(alchemy, platform)),
    Effect.scoped,
  );
