import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("create and delete deployment", (stack) =>
  Effect.gen(function* () {
    const { api, deployment } = yield* stack.deploy(
      Effect.gen(function* () {
        const api = yield* AWS.ApiGateway.RestApi("AgDepApi", {
          endpointConfiguration: { types: ["REGIONAL"] },
        });
        yield* AWS.ApiGateway.Method("AgDepMock", {
          restApiId: api.restApiId,
          resourceId: api.rootResourceId,
          httpMethod: "GET",
          authorizationType: "NONE",
          integration: { type: "MOCK" },
        });
        const deployment = yield* AWS.ApiGateway.Deployment("AgDep", {
          restApiId: api.restApiId,
          description: "alchemy-test-deployment",
        });
        return { api, deployment };
      }),
    );

    expect(deployment.deploymentId).toBeDefined();

    yield* stack.destroy();
  }),
);

test.provider("deployment trigger change creates new deployment", (stack) =>
  Effect.gen(function* () {
    const { api, d1 } = yield* stack.deploy(
      Effect.gen(function* () {
        const api = yield* AWS.ApiGateway.RestApi("AgTrigApi", {
          endpointConfiguration: { types: ["REGIONAL"] },
        });
        yield* AWS.ApiGateway.Method("AgTrigMock", {
          restApiId: api.restApiId,
          resourceId: api.rootResourceId,
          httpMethod: "GET",
          authorizationType: "NONE",
          integration: { type: "MOCK" },
        });
        const deployment = yield* AWS.ApiGateway.Deployment("AgTrigDep", {
          restApiId: api.restApiId,
          description: "v1",
          triggers: { t: "a" },
        });
        return { api, d1: deployment };
      }),
    );

    const { d2 } = yield* stack.deploy(
      Effect.gen(function* () {
        const api = yield* AWS.ApiGateway.RestApi("AgTrigApi", {
          endpointConfiguration: { types: ["REGIONAL"] },
        });
        yield* AWS.ApiGateway.Method("AgTrigMock", {
          restApiId: api.restApiId,
          resourceId: api.rootResourceId,
          httpMethod: "GET",
          authorizationType: "NONE",
          integration: { type: "MOCK" },
        });
        const deployment = yield* AWS.ApiGateway.Deployment("AgTrigDep", {
          restApiId: api.restApiId,
          description: "v1",
          triggers: { t: "b" },
        });
        return { d2: deployment };
      }),
    );

    expect(d2.deploymentId).not.toEqual(d1.deploymentId);

    yield* stack.destroy();
  }),
);
