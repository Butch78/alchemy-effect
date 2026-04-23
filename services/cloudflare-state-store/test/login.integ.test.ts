import * as CfCredentials from "@distilled.cloud/cloudflare/Credentials";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import {
  HttpStateStore,
  HttpStateStoreAuth,
  loginWithCloudflare,
} from "alchemy/State";
import {
  afterAll,
  beforeAll,
  deploy,
  destroy,
  expect,
  test,
} from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import StateStoreStack from "../alchemy.run.ts";
import TestStack from "./TestStack/Stack.ts";

/**
 * Project namespace used for every HTTP state-store call in this
 * file. Unique-per-run so repeated test invocations on the same
 * deployed state store don't share resources.
 */
const PROJECT = `login-integ-${Date.now()}`;

/**
 * Deploy the state-store stack itself. Uses the test harness's
 * `LocalState`; resources it creates end up in `.alchemy/state/`.
 * `waitForWorker` polls an authenticated RPC path until it responds
 * with JSON — without it the first request after deploy can hit
 * Cloudflare's edge before the workers.dev subdomain is propagated
 * and return an HTML error page instead.
 */
const stack = beforeAll(
  Effect.gen(function* () {
    const output = yield* deploy(StateStoreStack);
    const url = output.url as string;
    const authToken = output.authToken as string;
    yield* Effect.promise(() => waitForWorker(url, authToken));
    return { url, authToken };
  }),
  { timeout: 180_000 },
);

async function waitForWorker(url: string, token: string, maxRetries = 60) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${url}/projects/warmup/state/listStacks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const text = await res.text();
      if (res.status === 200 && text.startsWith("{")) {
        const json = JSON.parse(text);
        if (json?.ok) return;
      }
    } catch {
      // network / 521 / 522 — keep retrying
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Worker RPC path not warm after retries");
}

/**
 * Poll a newly-deployed workers.dev URL until it returns 200 with a
 * body containing `needle`. Cloudflare serves an HTML error page
 * (522, "workers.dev" not found, etc.) for the first few seconds
 * after a fresh deploy, so we can't rely on a single fetch.
 */
async function waitForBody(
  url: string,
  needle: string,
  maxRetries = 60,
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      const body = await res.text();
      if (res.status === 200 && body.includes(needle)) return body;
    } catch {
      // transient — keep retrying
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Worker at ${url} did not return expected body after retries`,
  );
}

// Skip teardown with NO_DESTROY=1 for local iteration.
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(StateStoreStack), {
  timeout: 180_000,
});

/**
 * Composed layer that makes `State` resolve to the HTTP state store.
 * Provided to `deploy(TestStack)` / `destroy(TestStack)` so the
 * downstream stack's state lives in our service, not on local disk.
 *
 * `HttpStateStoreAuth` registers the auth provider into the
 * `AuthProviders` registry first; `HttpStateStore` then reads the
 * credentials (written by `loginWithCloudflare`) to build its
 * `StateService`.
 */
const remoteState = HttpStateStore.pipe(Layer.provide(HttpStateStoreAuth));

/**
 * Minimal Cloudflare runtime for `loginWithCloudflare`. We avoid the
 * full `Cloudflare.providers()` layer because it transitively pulls
 * in `Stack`/`Stage`/`DotAlchemy` — services only plumbed inside
 * `deploy()`, not in a bare test body. All we actually need for the
 * login is `CloudflareEnvironment` + the distilled `Credentials`
 * service, both satisfiable from env vars.
 */
const cloudflareForLogin = Layer.mergeAll(
  CfCredentials.fromEnv(),
  Layer.succeed(CloudflareEnvironment, {
    type: "apiToken" as const,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    apiToken: Redacted.make(process.env.CLOUDFLARE_API_TOKEN!),
    source: { type: "env" as const },
  }),
);

// ---- HTTP RPC helper (same shape as integ.test.ts) ----------------

async function listFqns(
  baseUrl: string,
  authToken: string,
  project: string,
  stateStack: string,
  stage: string,
): Promise<string[]> {
  const res = await fetch(
    `${baseUrl}/projects/${encodeURIComponent(project)}/state/list`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ stack: stateStack, stage }),
    },
  );
  const text = await res.text();
  let json: {
    ok: boolean;
    result?: string[];
    error?: { code: string; message: string };
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `list returned non-JSON (status ${res.status}): ${text.slice(0, 300)}`,
    );
  }
  if (!json.ok) {
    throw new Error(
      `list failed: [${json.error?.code}] ${json.error?.message}`,
    );
  }
  return json.result ?? [];
}

/**
 * `TestStack` above uses stack name `AlchemyStateStoreLoginTest`
 * and the test harness hardcodes stage `"test"` — those become the
 * keys the HTTP state-store sees.
 */
const DOWNSTREAM_STACK_NAME = "AlchemyStateStoreLoginTest";
const DOWNSTREAM_STAGE = "test";

// ---- the actual scenario -----------------------------------------

test(
  "spin up → login → deploy downstream worker → verify state → teardown",
  Effect.gen(function* () {
    const { url: stateStoreUrl, authToken } = yield* stack;

    // 1. Log in. Uses `loginWithCloudflare` (edge-preview probe →
    //    token, subdomain lookup → URL) and writes
    //    `~/.alchemy/credentials/default/http-state-store.json`.
    //    Project is passed explicitly because tests don't have a TTY
    //    for the interactive prompt.
    //
    //    `cloudflareForLogin` provides the minimum set of services
    //    `loginWithCloudflare` needs beyond what the test harness
    //    already supplies.
    yield* loginWithCloudflare({ project: PROJECT }).pipe(
      Effect.provide(cloudflareForLogin),
    );

    // 2. State store should be empty for this unique project before
    //    we deploy anything.
    const before = yield* Effect.promise(() =>
      listFqns(
        stateStoreUrl,
        authToken,
        PROJECT,
        DOWNSTREAM_STACK_NAME,
        DOWNSTREAM_STAGE,
      ),
    );
    expect(before).toEqual([]);

    // 3. Deploy the downstream worker — its state goes to our HTTP
    //    state store, not local disk. Providing `remoteState` here
    //    overrides the harness's default `LocalState` for this call
    //    (inner `Effect.provide` wins).
    const deployed = yield* deploy(TestStack).pipe(
      Effect.provide(remoteState),
    );
    const workerUrl = deployed.url as string;
    expect(workerUrl).toBeString();

    // 4. State store should now have at least one resource recorded
    //    for the downstream stack/stage under our project.
    const afterDeploy = yield* Effect.promise(() =>
      listFqns(
        stateStoreUrl,
        authToken,
        PROJECT,
        DOWNSTREAM_STACK_NAME,
        DOWNSTREAM_STAGE,
      ),
    );
    expect(afterDeploy.length).toBeGreaterThan(0);

    // 5. Hit the worker itself — it should respond 200 with the
    //    canary string defined in `TestStack`. Poll until the
    //    workers.dev subdomain is propagated so we don't read a
    //    Cloudflare edge error page.
    const body = yield* Effect.promise(() =>
      waitForBody(workerUrl, "state-store-test-worker OK"),
    );
    expect(body).toContain("state-store-test-worker OK");

    // 6. Tear down the downstream stack. Same override so `destroy`
    //    reads/writes the HTTP state store.
    yield* destroy(TestStack).pipe(Effect.provide(remoteState));

    // 7. State store should be empty again for this project after
    //    teardown.
    const afterDestroy = yield* Effect.promise(() =>
      listFqns(
        stateStoreUrl,
        authToken,
        PROJECT,
        DOWNSTREAM_STACK_NAME,
        DOWNSTREAM_STAGE,
      ),
    );
    expect(afterDestroy).toEqual([]);
  }),
  { timeout: 300_000 },
);
