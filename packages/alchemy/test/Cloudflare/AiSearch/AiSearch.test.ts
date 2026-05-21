import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Bucket } from "./fixtures/bucket.ts";
import { Search, Token } from "./fixtures/search.ts";
import AiSearchTestWorker from "./fixtures/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "create, update, delete ai search instance",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const search = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket;
          const token = yield* Cloudflare.AiSearchToken("CrudToken", {
            name: "alchemy-test-ai-search-crud-token",
          });
          return yield* Cloudflare.AiSearch("Search", {
            name: "alchemy-test-ai-search-crud",
            tokenId: token.tokenId,
            source: { type: "r2", bucketName: bucket.bucketName },
            chunkSize: 256,
            maxNumResults: 10,
          });
        }),
      );

      expect(search.instanceName).toEqual("alchemy-test-ai-search-crud");
      expect(search.type).toEqual("r2");

      const live = yield* aisearch.readInstance({
        accountId,
        id: search.instanceName,
      });
      expect(live.id).toEqual(search.instanceName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket;
          const token = yield* Cloudflare.AiSearchToken("CrudToken", {
            name: "alchemy-test-ai-search-crud-token",
          });
          return yield* Cloudflare.AiSearch("Search", {
            name: "alchemy-test-ai-search-crud",
            tokenId: token.tokenId,
            source: { type: "r2", bucketName: bucket.bucketName },
            chunkSize: 384,
            maxNumResults: 25,
          });
        }),
      );

      expect(updated.chunkSize).toEqual(384);
      expect(updated.maxNumResults).toEqual(25);

      yield* stack.destroy();
      yield* waitForInstanceDeleted(updated.instanceName, accountId);
    }).pipe(logLevel),
  { timeout: 300_000 },
);

const waitForInstanceDeleted = Effect.fn(function* (
  instanceName: string,
  accountId: string,
) {
  yield* aisearch.readInstance({ accountId, id: instanceName }).pipe(
    Effect.flatMap(() => Effect.fail(new InstanceStillExists())),
    Effect.retry({
      while: (e): e is InstanceStillExists => e instanceof InstanceStillExists,
      schedule: Schedule.exponential(100),
      times: 30,
    }),
    Effect.catchTag("NotFound", () => Effect.void),
  );
});

class InstanceStillExists extends Data.TaggedError("InstanceStillExists") {}

const Stack = Alchemy.Stack(
  "AiSearchBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* Token;
    const search = yield* Search;
    const worker = yield* AiSearchTestWorker;
    return {
      instanceName: search.instanceName,
      url: worker.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deployed worker can call AiSearch binding (info)",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.url).toBeTypeOf("string");
    expect(out.instanceName).toBe("alchemy-test-ai-search");

    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(`${out.url}/info`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 15,
      }),
    );
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { id: string };
    expect(body.id).toBe(out.instanceName);
  }).pipe(logLevel),
  { timeout: 300_000 },
);
