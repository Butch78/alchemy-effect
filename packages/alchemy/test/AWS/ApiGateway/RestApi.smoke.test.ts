import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { TestFunction, TestFunctionLive } from "../Lambda/handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "REST API proxies to Lambda (primitives)",
  (stack) =>
    Effect.gen(function* () {
      const { region, accountId } = yield* AWSEnvironment;

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* TestFunction.asEffect().pipe(
            Effect.provide(TestFunctionLive),
          );

          const api = yield* AWS.ApiGateway.RestApi("AgSmokeApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });

          const proxyResource = yield* AWS.ApiGateway.Resource("AgSmokeProxy", {
            restApiId: api.restApiId,
            parentId: api.rootResourceId,
            pathPart: "{proxy+}",
          });

          const invokeUri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${fn.functionArn}/invocations`;

          yield* AWS.ApiGateway.Method("AgSmokeRootAny", {
            restApiId: api.restApiId,
            resourceId: api.rootResourceId,
            httpMethod: "ANY",
            authorizationType: "NONE",
            integration: {
              type: "AWS_PROXY",
              integrationHttpMethod: "POST",
              uri: invokeUri,
            },
          });

          yield* AWS.ApiGateway.Method("AgSmokeProxyAny", {
            restApiId: api.restApiId,
            resourceId: proxyResource.resourceId,
            httpMethod: "ANY",
            authorizationType: "NONE",
            integration: {
              type: "AWS_PROXY",
              integrationHttpMethod: "POST",
              uri: invokeUri,
            },
          });

          const deployment = yield* AWS.ApiGateway.Deployment("AgSmokeDep", {
            restApiId: api.restApiId,
            description: "smoke",
          });

          const stage = yield* AWS.ApiGateway.Stage("AgSmokeStage", {
            restApiId: api.restApiId,
            stageName: "test",
            deploymentId: deployment.deploymentId,
          });

          yield* AWS.Lambda.Permission("AgSmokePerm", {
            action: "lambda:InvokeFunction",
            functionName: fn.functionName,
            principal: "apigateway.amazonaws.com",
            sourceArn: `arn:aws:execute-api:${region}:${accountId}:${api.restApiId}/*/*/*`,
          });

          const invokeUrl = `https://${api.restApiId}.execute-api.${region}.amazonaws.com/${stage.stageName}/`;

          return { invokeUrl };
        }),
      );

      const response = yield* HttpClient.get(out.invokeUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`invoke URL returned ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.exponential(500).pipe(
            Schedule.both(Schedule.recurs(10)),
          ),
        }),
      );

      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("Hello, world!");

      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);
