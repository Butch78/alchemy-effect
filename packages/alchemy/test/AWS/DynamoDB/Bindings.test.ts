import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import DynamoDBTestFunctionLive, { DynamoDBTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DynamoDBBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) plus the
// time it takes for the freshly-attached scan/query/etc. policies to
// propagate to the live invocation can stack to >150s on a busy account
// under parallel-suite load. Symptom: the URL returns 500s for the entire
// budget because the scan inside the handler hits AccessDenied until the
// policy lands. Budget 200s — well inside the surrounding beforeAll
// timeout — so the suite stays robust without slowing down the happy path.
const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(100)),
);

let baseUrl: string;
const sourceTableId = "TestTable";

describe("DynamoDB Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "DynamoDB test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("DynamoDB test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DynamoDBTestFunction;
        }).pipe(Effect.provide(DynamoDBTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      // Probe `/ready` — a no-binding endpoint that just confirms the
      // Lambda is up. We deliberately don't probe `/scan` here because
      // the handler `Effect.orDie`s any binding failure into a generic
      // "Internal Server Error", which means we can't tell IAM lag apart
      // from a real bug. Tests further down own their own retry budgets
      // for the IAM-propagation window.
      const readinessUrl = `${baseUrl}/ready`;

      yield* Effect.logInfo(
        `DynamoDB test setup: function URL ready (${functionUrl})`,
      );
      yield* Effect.logInfo(
        `DynamoDB test setup: probing readiness at ${readinessUrl} (20s budget)`,
      );

      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : response.text.pipe(
                Effect.flatMap((body) =>
                  Effect.fail(
                    new Error(
                      `Function not ready: ${response.status} body=${body.slice(0, 500)}`,
                    ),
                  ),
                ),
              ),
        ),
        Effect.tap(() =>
          Effect.logInfo("DynamoDB test setup: fixture responded successfully"),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `DynamoDB test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );

      // Warm the bindings: call `/scan` (which requires the dynamodb:Scan
      // policy) and retry on 5xx until it succeeds. IAM policy propagation
      // is global rather than per-role, so on a heavily-loaded account a
      // policy attached at deploy time can lag the Lambda's invocation
      // path by tens of seconds. Absorb that lag here so individual tests
      // don't need their own retries — by the time we return, the policy
      // is observable from inside the live Lambda.
      yield* Effect.logInfo(
        "DynamoDB test setup: warming bindings (waiting for IAM policy propagation)",
      );
      yield* HttpClient.get(`${baseUrl}/scan`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : response.text.pipe(
                Effect.flatMap((body) =>
                  Effect.fail(
                    new Error(
                      `scan binding not ready: ${response.status} body=${body.slice(0, 500)}`,
                    ),
                  ),
                ),
              ),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `DynamoDB test setup: bindings not warm yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      yield* Effect.logInfo("DynamoDB test setup: bindings warm");
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 60_000 });

  describe("PutItem", () => {
    test.provider("puts an item into the table", (_stack) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "put-test#1", sk: "item", data: "test data" },
          ),
        ).pipe(Effect.flatMap((r) => r.json));

        expect(response).toHaveProperty("success", true);
      }),
    );
  });

  describe("GetItem", () => {
    test.provider("gets an existing item from the table", (_stack) =>
      Effect.gen(function* () {
        yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "get-test#1", sk: "item", data: "get test data" },
          ),
        );

        const response = yield* HttpClient.get(
          `${baseUrl}/get?pk=${encodeURIComponent("get-test#1")}&sk=item`,
        ).pipe(Effect.flatMap((r) => r.json));

        expect(response).toHaveProperty("item");
        expect((response as any).item.pk.S).toBe("get-test#1");
        expect((response as any).item.sk.S).toBe("item");
        expect((response as any).item.data.S).toBe("get test data");
      }),
    );

    test.provider("returns undefined for non-existent item", (_stack) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(
          `${baseUrl}/get?pk=${encodeURIComponent("non-existent")}&sk=item`,
        ).pipe(Effect.flatMap((r) => r.json));

        expect((response as any).item).toBeUndefined();
      }),
    );
  });

  describe("DescribeTable", () => {
    test.provider("describes the bound table", (_stack) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(
          `${baseUrl}/describe-table`,
        ).pipe(Effect.flatMap((r) => r.json));

        expect((response as any).table.TableName).toBeTruthy();
        expect((response as any).table.KeySchema).toEqual([
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ]);
      }),
    );
  });

  describe("DescribeTimeToLive", () => {
    test.provider("describes table ttl configuration", (_stack) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(`${baseUrl}/describe-ttl`).pipe(
          Effect.flatMap((r) => r.json),
        );

        expect(response).toHaveProperty("timeToLiveDescription");
      }),
    );
  });

  describe("BatchWriteItem", () => {
    test.provider("writes multiple items through the bound table", (_stack) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/batch-write`),
            {
              RequestItems: {
                [sourceTableId]: [
                  {
                    PutRequest: {
                      Item: {
                        pk: { S: "batch-write#1" },
                        sk: { S: "item" },
                        data: { S: "first item" },
                      },
                    },
                  },
                  {
                    PutRequest: {
                      Item: {
                        pk: { S: "batch-write#2" },
                        sk: { S: "item" },
                        data: { S: "second item" },
                      },
                    },
                  },
                ],
              },
            },
          ),
        ).pipe(Effect.flatMap((r) => r.json));

        expect(Object.keys((response as any).unprocessedItems)).toHaveLength(0);
      }),
    );
  });

  describe("BatchGetItem", () => {
    test.provider("reads multiple items through the bound table", (_stack) =>
      Effect.gen(function* () {
        yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/batch-write`),
            {
              RequestItems: {
                [sourceTableId]: [
                  {
                    PutRequest: {
                      Item: {
                        pk: { S: "batch-get#1" },
                        sk: { S: "item" },
                        data: { S: "first item" },
                      },
                    },
                  },
                  {
                    PutRequest: {
                      Item: {
                        pk: { S: "batch-get#2" },
                        sk: { S: "item" },
                        data: { S: "second item" },
                      },
                    },
                  },
                ],
              },
            },
          ),
        );

        const response = yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/batch-get`),
            {
              RequestItems: {
                [sourceTableId]: {
                  Keys: [
                    { pk: { S: "batch-get#1" }, sk: { S: "item" } },
                    { pk: { S: "batch-get#2" }, sk: { S: "item" } },
                  ],
                },
              },
            },
          ),
        ).pipe(Effect.flatMap((r) => r.json));

        const items = Object.values((response as any).responses).flat();
        expect(items).toHaveLength(2);
      }),
    );
  });

  describe("UpdateTimeToLive", () => {
    test.provider("updates table ttl configuration", (_stack) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/update-ttl`),
            { attributeName: "expiresAt", enabled: true },
          ),
        ).pipe(Effect.flatMap((r) => r.json));

        expect((response as any).timeToLiveSpecification).toEqual({
          AttributeName: "expiresAt",
          Enabled: true,
        });
      }),
    );
  });

  describe("ExecuteStatement", () => {
    test.provider(
      "executes a PartiQL statement against the bound table",
      (_stack) =>
        Effect.gen(function* () {
          yield* HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/put`),
              { pk: "statement#1", sk: "item", data: "statement data" },
            ),
          );

          const response = yield* HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/execute-statement`),
              { pk: "statement#1", sk: "item" },
            ),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((response as any).items).toHaveLength(1);
          expect((response as any).items[0].data.S).toBe("statement data");
        }),
    );
  });

  describe("BatchExecuteStatement", () => {
    test.provider(
      "executes PartiQL statements against the bound table",
      (_stack) =>
        Effect.gen(function* () {
          yield* HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/batch-write`),
              {
                RequestItems: {
                  [sourceTableId]: [
                    {
                      PutRequest: {
                        Item: {
                          pk: { S: "batch-statement#1" },
                          sk: { S: "item" },
                          data: { S: "first item" },
                        },
                      },
                    },
                    {
                      PutRequest: {
                        Item: {
                          pk: { S: "batch-statement#2" },
                          sk: { S: "item" },
                          data: { S: "second item" },
                        },
                      },
                    },
                  ],
                },
              },
            ),
          );

          const response = yield* HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/batch-execute-statement`),
              {
                first: { pk: "batch-statement#1", sk: "item" },
                second: { pk: "batch-statement#2", sk: "item" },
              },
            ),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((response as any).responses).toHaveLength(2);
        }),
    );
  });

  describe("ExecuteTransaction", () => {
    test.provider(
      "executes a PartiQL transaction against the table",
      (_stack) =>
        Effect.gen(function* () {
          yield* HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/put`),
              { pk: "tx#1", sk: "item1", data: "first" },
            ),
          );
          yield* HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/put`),
              { pk: "tx#1", sk: "item2", data: "second" },
            ),
          );

          const response = yield* HttpClient.execute(
            HttpClientRequest.post(`${baseUrl}/execute-transaction`),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((response as any).responses).toHaveLength(2);
        }),
    );
  });

  describe("TransactWriteItems", () => {
    test.provider(
      "writes items transactionally through the bound table",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/transact-write`),
              {
                TransactItems: [
                  {
                    Put: {
                      Table: sourceTableId,
                      Item: {
                        pk: { S: "transact-write#1" },
                        sk: { S: "item" },
                        data: { S: "first item" },
                      },
                    },
                  },
                  {
                    Put: {
                      Table: sourceTableId,
                      Item: {
                        pk: { S: "transact-write#2" },
                        sk: { S: "item" },
                        data: { S: "second item" },
                      },
                    },
                  },
                ],
              },
            ),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((response as any).success).toBe(true);
        }),
    );
  });

  describe("TransactGetItems", () => {
    test.provider(
      "reads items transactionally through the bound table",
      (_stack) =>
        Effect.gen(function* () {
          yield* HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/transact-write`),
              {
                TransactItems: [
                  {
                    Put: {
                      Table: sourceTableId,
                      Item: {
                        pk: { S: "transact-get#1" },
                        sk: { S: "item" },
                        data: { S: "first item" },
                      },
                    },
                  },
                  {
                    Put: {
                      Table: sourceTableId,
                      Item: {
                        pk: { S: "transact-get#2" },
                        sk: { S: "item" },
                        data: { S: "second item" },
                      },
                    },
                  },
                ],
              },
            ),
          );

          const response = yield* HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/transact-get`),
              {
                TransactItems: [
                  {
                    Get: {
                      Table: sourceTableId,
                      Key: {
                        pk: { S: "transact-get#1" },
                        sk: { S: "item" },
                      },
                    },
                  },
                  {
                    Get: {
                      Table: sourceTableId,
                      Key: {
                        pk: { S: "transact-get#2" },
                        sk: { S: "item" },
                      },
                    },
                  },
                ],
              },
            ),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((response as any).responses).toHaveLength(2);
        }),
    );
  });

  describe("UpdateItem", () => {
    test.provider("updates an existing item", (_stack) =>
      Effect.gen(function* () {
        yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "update-test#1", sk: "item", data: "original" },
          ),
        );

        const response = yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/update`),
            { pk: "update-test#1", sk: "item", data: "updated" },
          ),
        ).pipe(Effect.flatMap((r) => r.json));

        expect(response).toHaveProperty("success", true);
        expect((response as any).attributes.data.S).toBe("updated");

        const getResponse = yield* HttpClient.get(
          `${baseUrl}/get?pk=${encodeURIComponent("update-test#1")}&sk=item`,
        ).pipe(Effect.flatMap((r) => r.json));

        expect((getResponse as any).item.data.S).toBe("updated");
      }),
    );
  });

  describe("DeleteItem", () => {
    test.provider("deletes an existing item", (_stack) =>
      Effect.gen(function* () {
        yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "delete-test#1", sk: "item", data: "to delete" },
          ),
        );

        const response = yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.delete(`${baseUrl}/delete`),
            { pk: "delete-test#1", sk: "item" },
          ),
        ).pipe(Effect.flatMap((r) => r.json));

        expect(response).toHaveProperty("success", true);

        const getResponse = yield* HttpClient.get(
          `${baseUrl}/get?pk=${encodeURIComponent("delete-test#1")}&sk=item`,
        ).pipe(Effect.flatMap((r) => r.json));

        expect((getResponse as any).item).toBeUndefined();
      }),
    );
  });

  describe("Query", () => {
    test.provider("queries items by partition key", (_stack) =>
      Effect.gen(function* () {
        yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "query-test#1", sk: "item1", data: "first" },
          ),
        );
        yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "query-test#1", sk: "item2", data: "second" },
          ),
        );

        // DynamoDB Query is eventually consistent by default, so a
        // brand-new PutItem may not appear in the immediately-following
        // Query. Poll briefly until both items are visible.
        const response = yield* Effect.gen(function* () {
          const r = yield* HttpClient.get(
            `${baseUrl}/query?pk=${encodeURIComponent("query-test#1")}`,
          ).pipe(Effect.flatMap((r) => r.json));
          if ((r as any).count !== 2) {
            return yield* Effect.fail(new QueryNotConsistent());
          }
          return r;
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "QueryNotConsistent",
            schedule: Schedule.fixed("500 millis").pipe(
              Schedule.both(Schedule.recurs(20)),
            ),
          }),
        );

        expect((response as any).count).toBe(2);
        expect((response as any).items.length).toBe(2);
      }),
    );
  });

  describe("ListTables", () => {
    test.provider("lists the deployed table", (_stack) =>
      Effect.gen(function* () {
        const described = yield* HttpClient.get(
          `${baseUrl}/describe-table`,
        ).pipe(Effect.flatMap((r) => r.json));

        const response = yield* HttpClient.get(`${baseUrl}/list-tables`).pipe(
          Effect.flatMap((r) => r.json),
        );

        expect((response as any).tableNames).toContain(
          (described as any).table.TableName,
        );
      }),
    );
  });

  describe("ListTagsOfResource", () => {
    test.provider("lists alchemy ownership tags for the table", (_stack) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(`${baseUrl}/list-tags`).pipe(
          Effect.flatMap((r) => r.json),
        );

        const keys = ((response as any).tags ?? []).map((tag: any) => tag.Key);
        expect(keys).toContain("alchemy::stack");
        expect(keys).toContain("alchemy::stage");
        expect(keys).toContain("alchemy::id");
      }),
    );
  });

  describe("RestoreTableToPointInTime", () => {
    test.provider(
      "returns a structured error when point-in-time recovery is unavailable",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/restore-table`),
              {},
            ),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((response as any).ok).toBe(false);
          expect([
            "PointInTimeRecoveryUnavailableException",
            "TableAlreadyExistsException",
          ]).toContain((response as any).error);
        }),
    );
  });

  describe("Scan", () => {
    test.provider("scans all items in the table", (_stack) =>
      Effect.gen(function* () {
        yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "scan-test#1", sk: "item", data: "scan data" },
          ),
        );

        const response = yield* HttpClient.get(`${baseUrl}/scan`).pipe(
          Effect.flatMap((r) => r.json),
        );

        expect((response as any).count).toBeGreaterThanOrEqual(1);
        expect((response as any).items.length).toBeGreaterThanOrEqual(1);
      }),
    );
  });
});

class QueryNotConsistent extends Data.TaggedError("QueryNotConsistent") {}
