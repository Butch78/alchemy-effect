import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  afterAll as vitestAfterAll,
  afterEach as vitestAfterEach,
  beforeAll as vitestBeforeAll,
  beforeEach as vitestBeforeEach,
} from "vitest";

import type { AlchemyContext } from "../AlchemyContext.ts";
import type { CompiledStack } from "../Stack.ts";
import type { Stage } from "../Stage.ts";
import * as Core from "./Core.ts";

// Detect whether we are running under `bun test` rather than `bun vitest run`.
// We can't statically `import "bun:test"` because vitest (running on Vite's
// resolver) does not understand the bun: scheme. Instead we synchronously
// `require("bun:test")` when `Bun` is available — the import will only
// succeed inside a `bun test` process, where bun:test's runtime is wired up.
//
// The discriminator matters because `@effect/vitest`'s `it.live` registers
// each test as `it(name, options, (ctx) => run(...))`. Bun:test treats any
// function with arity >= 1 as having a `done` callback and waits forever for
// it to fire. When that's our runner we bypass `it.live` and call bun:test
// directly with a 0-arg wrapper.
const bunTest: { it: any } | null = (() => {
  if (typeof (globalThis as any).Bun === "undefined") return null;
  try {
    // `import.meta.require` is bun-only and works in pure ESM modules where
    // CommonJS `require` is unavailable. Bun resolves `bun:test` only inside
    // a `bun test` process, so this throws (and we return null) under
    // `bun vitest run`, `bun run`, or any non-test bun process.
    return (import.meta as any).require("bun:test") as { it: any };
  } catch {
    return null;
  }
})();
const bunTestIt = bunTest?.it;
const isUnderBunTest = bunTest !== null;

export type MakeOptions<ROut = any> = Core.MakeOptions<ROut>;
export type ScratchStack = Core.ScratchStack;
export type TestEffect<A, R = never> = Core.TestEffect<A, R>;

type TestOptions = number | { timeout?: number };

const timeoutOf = (opts: TestOptions | undefined): number | undefined =>
  typeof opts === "number" ? opts : opts?.timeout;

interface TestFn {
  (name: string, eff: TestEffect<void>, options?: TestOptions): void;
  skip: (name: string, eff: TestEffect<void>, options?: TestOptions) => void;
  skipIf: (
    condition: boolean,
  ) => (name: string, eff: TestEffect<void>, options?: TestOptions) => void;
  only: (name: string, eff: TestEffect<void>, options?: TestOptions) => void;
  todo: (name: string, eff: TestEffect<void>, options?: TestOptions) => void;
  provider: ProviderFn;
}

interface ProviderFn {
  (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    options?: TestOptions,
  ): void;
  skip: (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    options?: TestOptions,
  ) => void;
  skipIf: (
    condition: boolean,
  ) => (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    options?: TestOptions,
  ) => void;
}

interface BeforeAllFn {
  <A>(eff: TestEffect<A>, options?: TestOptions): Effect.Effect<A>;
}

interface BeforeEachFn {
  (eff: TestEffect<void>, options?: TestOptions): void;
}

interface AfterAllFn {
  (eff: TestEffect<any>, options?: TestOptions): void;
  skipIf: (
    predicate: boolean,
  ) => (eff: TestEffect<any>, options?: TestOptions) => void;
}

interface AfterEachFn {
  (eff: TestEffect<void>, options?: TestOptions): void;
}

export interface TestApi {
  test: TestFn;
  beforeAll: BeforeAllFn;
  beforeEach: BeforeEachFn;
  afterAll: AfterAllFn;
  afterEach: AfterEachFn;
  deploy: <A>(
    stack: TestEffect<CompiledStack<A>, Stage | AlchemyContext>,
    options?: { stage?: string },
  ) => ReturnType<typeof Core.deploy<A>>;
  destroy: (
    stack: TestEffect<CompiledStack, Stage | AlchemyContext>,
    options?: { stage?: string },
  ) => ReturnType<typeof Core.destroy>;
}

const DEFAULT_TIMEOUT = 120_000;

/**
 * Build the per-file test API. See {@link "./Bun.ts"} for the same shape
 * over `bun:test`. Vitest variant uses `@effect/vitest`'s `it.live` so
 * Effect-aware tests stay first-class.
 */
export const make = <ROut = any>(options: MakeOptions<ROut>): TestApi => {
  const wrap = <A>(eff: TestEffect<A>) => Core.toEffect(eff, options);
  const runEff = <A>(eff: TestEffect<A>) => Core.run(eff, options);

  // Test registration helper. Under `bun test` we go straight to bun:test's
  // `it` family with a 0-arg runner returning a Promise, sidestepping the
  // arity-1 callback that `@effect/vitest`'s `it.live` would have produced
  // (which deadlocks bun:test on its done-callback heuristic). Under real
  // vitest we keep `it.live` so Effect-aware test fixtures stay first-class.
  const registerTest = (
    name: string,
    runner: () => Promise<unknown>,
    opts: TestOptions | undefined,
  ) => {
    if (isUnderBunTest) {
      bunTestIt(name, runner, timeoutOf(opts));
    } else {
      it.live(
        name,
        () =>
          Effect.promise(runner) as unknown as Effect.Effect<unknown, never>,
        timeoutOf(opts),
      );
    }
  };
  const registerOnly = (
    name: string,
    runner: () => Promise<unknown>,
    opts: TestOptions | undefined,
  ) => {
    if (isUnderBunTest) {
      bunTestIt.only(name, runner, timeoutOf(opts));
    } else {
      it.only(
        name,
        () =>
          Effect.promise(runner) as unknown as Effect.Effect<unknown, never>,
        timeoutOf(opts),
      );
    }
  };
  const registerSkip = (name: string, opts: TestOptions | undefined) => {
    if (isUnderBunTest) {
      bunTestIt.skip(name, () => {}, timeoutOf(opts));
    } else {
      it.skip(name, () => {}, timeoutOf(opts));
    }
  };
  const registerTodo = (name: string) => {
    if (isUnderBunTest) {
      bunTestIt.todo(name);
    } else {
      it.todo(name);
    }
  };

  const test = ((name, eff, opts) => {
    registerTest(name, () => runEff(eff), opts);
  }) as TestFn;

  test.skip = (name, _eff, opts) => registerSkip(name, opts);
  test.skipIf = (condition) => (name, eff, opts) => {
    if (condition) {
      registerSkip(name, opts);
    } else {
      registerTest(name, () => runEff(eff), opts);
    }
  };
  test.only = (name, eff, opts) => {
    registerOnly(name, () => runEff(eff), opts);
  };
  test.todo = (name, _eff, _opts) => registerTodo(name);

  const runProvider = (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
  ) => {
    const scratch = Core.scratchStack(options, name);
    return Core.run(Core.withProviders(fn(scratch), options, scratch.name), {
      ...options,
      state: scratch.state,
    });
  };

  const provider = ((name, fn, opts) => {
    registerTest(name, () => runProvider(name, fn), opts);
  }) as ProviderFn;
  provider.skip = (name, _fn, opts) => registerSkip(name, opts);
  provider.skipIf = (condition) => (name, fn, opts) => {
    if (condition) {
      registerSkip(name, opts);
    } else {
      registerTest(name, () => runProvider(name, fn), opts);
    }
  };
  test.provider = provider;

  const beforeAll: BeforeAllFn = <A>(
    eff: TestEffect<A>,
    hookOptions?: TestOptions,
  ) => {
    let result: A;
    vitestBeforeAll(
      () => runEff(eff).then((v) => (result = v)),
      timeoutOf(hookOptions) ?? DEFAULT_TIMEOUT,
    );
    return Effect.sync(() => result);
  };

  const beforeEach: BeforeEachFn = (eff, hookOptions) => {
    vitestBeforeEach(() => runEff(eff), timeoutOf(hookOptions));
  };

  const afterAll = ((eff, hookOptions) => {
    vitestAfterAll(
      () => runEff(eff),
      timeoutOf(hookOptions) ?? DEFAULT_TIMEOUT,
    );
  }) as AfterAllFn;
  afterAll.skipIf = (predicate) => (eff, hookOptions) => {
    if (predicate) return;
    vitestAfterAll(
      () => runEff(eff),
      timeoutOf(hookOptions) ?? DEFAULT_TIMEOUT,
    );
  };

  const afterEach: AfterEachFn = (eff, hookOptions) => {
    vitestAfterEach(() => runEff(eff), timeoutOf(hookOptions));
  };

  return {
    test,
    beforeAll,
    beforeEach,
    afterAll,
    afterEach,
    deploy: (stack, callOpts) => Core.deploy(options, stack, callOpts),
    destroy: (stack, callOpts) => Core.destroy(options, stack, callOpts),
  };
};
