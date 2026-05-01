import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * Integration configuration for an API Gateway method (passed to `putIntegration`).
 */
export interface MethodIntegrationProps {
  type: ag.IntegrationType;
  integrationHttpMethod?: string;
  uri?: Input<string>;
  connectionType?: ag.ConnectionType;
  connectionId?: string;
  /**
   * IAM role ARN used by API Gateway for integration credentials.
   *
   * This is not a secret value; API Gateway stores an ARN or passthrough marker.
   */
  credentials?: string;
  requestParameters?: { [key: string]: string | undefined };
  requestTemplates?: { [key: string]: string | undefined };
  passthroughBehavior?: string;
  cacheNamespace?: string;
  cacheKeyParameters?: string[];
  contentHandling?: ag.ContentHandlingStrategy;
  timeoutInMillis?: number;
  tlsConfig?: ag.TlsConfig;
  responseTransferMode?: ag.ResponseTransferMode;
  integrationTarget?: string;
}

export interface MethodProps {
  restApiId: Input<string>;
  resourceId: Input<string>;
  /** HTTP verb, e.g. `GET`, `POST`, `ANY`. */
  httpMethod: string;
  /**
   * Authorization type (`NONE`, `IAM`, `CUSTOM`, `COGNITO_USER_POOLS`, etc.).
   * @default "NONE"
   */
  authorizationType?: string;
  authorizerId?: string;
  apiKeyRequired?: boolean;
  operationName?: string;
  requestParameters?: { [key: string]: boolean | undefined };
  requestModels?: { [key: string]: string | undefined };
  requestValidatorId?: string;
  authorizationScopes?: string[];
  /** When set, `putIntegration` is applied after `putMethod`. */
  integration?: MethodIntegrationProps;
}

export interface Method extends Resource<
  "AWS.ApiGateway.Method",
  MethodProps,
  {
    restApiId: string;
    resourceId: string;
    httpMethod: string;
    authorizationType: string;
    authorizerId: string | undefined;
    apiKeyRequired: boolean | undefined;
    operationName: string | undefined;
    requestParameters: { [key: string]: boolean | undefined } | undefined;
    requestModels: { [key: string]: string | undefined } | undefined;
    requestValidatorId: string | undefined;
    authorizationScopes: string[] | undefined;
    integration: MethodIntegrationProps | undefined;
  },
  never,
  Providers
> {}

/**
 * HTTP method on an API Gateway resource, optionally with Lambda/proxy integration.
 *
 * @section Lambda proxy
 * @example ANY method with AWS_PROXY
 * ```typescript
 * yield* ApiGateway.Method("RootAny", {
 *   restApiId: api.restApiId,
 *   resourceId: api.rootResourceId,
 *   httpMethod: "ANY",
 *   authorizationType: "NONE",
 *   integration: {
 *     type: "AWS_PROXY",
 *     integrationHttpMethod: "POST",
 *     uri: invokeUri,
 *   },
 * });
 * ```
 */
const MethodResource = Resource<Method>("AWS.ApiGateway.Method");

export { MethodResource as Method };

const putIntegrationRequest = (
  restApiId: string,
  resourceId: string,
  httpMethod: string,
  integration: MethodIntegrationProps,
): ag.PutIntegrationRequest => ({
  restApiId,
  resourceId,
  httpMethod,
  type: integration.type,
  integrationHttpMethod: integration.integrationHttpMethod,
  uri: integration.uri as string,
  connectionType: integration.connectionType,
  connectionId: integration.connectionId,
  credentials: integration.credentials,
  requestParameters: integration.requestParameters,
  requestTemplates: integration.requestTemplates,
  passthroughBehavior: integration.passthroughBehavior,
  cacheNamespace: integration.cacheNamespace,
  cacheKeyParameters: integration.cacheKeyParameters,
  contentHandling: integration.contentHandling,
  timeoutInMillis: integration.timeoutInMillis,
  tlsConfig: integration.tlsConfig,
  responseTransferMode: integration.responseTransferMode,
  integrationTarget: integration.integrationTarget,
});

const putMethod = (news: Input.ResolveProps<MethodProps>) =>
  ag.putMethod({
    restApiId: news.restApiId as string,
    resourceId: news.resourceId as string,
    httpMethod: news.httpMethod,
    authorizationType: news.authorizationType ?? "NONE",
    authorizerId: news.authorizerId,
    apiKeyRequired: news.apiKeyRequired,
    operationName: news.operationName,
    requestParameters: news.requestParameters,
    requestModels: news.requestModels,
    requestValidatorId: news.requestValidatorId,
    authorizationScopes: news.authorizationScopes,
  });

const deleteIntegrationSafe = (p: {
  restApiId: string;
  resourceId: string;
  httpMethod: string;
}) =>
  ag
    .deleteIntegration({
      restApiId: p.restApiId,
      resourceId: p.resourceId,
      httpMethod: p.httpMethod,
    })
    .pipe(Effect.catchTag("NotFoundException", () => Effect.void));

const deleteMethodSafe = (p: {
  restApiId: string;
  resourceId: string;
  httpMethod: string;
}) =>
  ag
    .deleteMethod({
      restApiId: p.restApiId,
      resourceId: p.resourceId,
      httpMethod: p.httpMethod,
    })
    .pipe(Effect.catchTag("NotFoundException", () => Effect.void));

const readMethodSnapshot = (p: {
  restApiId: string;
  resourceId: string;
  httpMethod: string;
}) =>
  Effect.gen(function* () {
    const method = yield* ag
      .getMethod({
        restApiId: p.restApiId,
        resourceId: p.resourceId,
        httpMethod: p.httpMethod,
      })
      .pipe(
        Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
      );
    if (!method?.httpMethod) return undefined;

    const integ = yield* ag
      .getIntegration({
        restApiId: p.restApiId,
        resourceId: p.resourceId,
        httpMethod: p.httpMethod,
      })
      .pipe(
        Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
      );

    const integration: MethodIntegrationProps | undefined = integ?.type
      ? {
          type: integ.type!,
          integrationHttpMethod: integ.httpMethod,
          uri: integ.uri,
          connectionType: integ.connectionType,
          connectionId: integ.connectionId,
          credentials: integ.credentials,
          requestParameters: integ.requestParameters,
          requestTemplates: integ.requestTemplates,
          passthroughBehavior: integ.passthroughBehavior,
          cacheNamespace: integ.cacheNamespace,
          cacheKeyParameters: integ.cacheKeyParameters,
          contentHandling: integ.contentHandling,
          timeoutInMillis: integ.timeoutInMillis,
          tlsConfig: integ.tlsConfig,
          responseTransferMode: integ.responseTransferMode,
          integrationTarget: integ.integrationTarget,
        }
      : undefined;

    return {
      restApiId: p.restApiId,
      resourceId: p.resourceId,
      httpMethod: p.httpMethod,
      authorizationType: method.authorizationType ?? "NONE",
      authorizerId: method.authorizerId,
      apiKeyRequired: method.apiKeyRequired,
      operationName: method.operationName,
      requestParameters: method.requestParameters,
      requestModels: method.requestModels,
      requestValidatorId: method.requestValidatorId,
      authorizationScopes: method.authorizationScopes,
      integration,
    };
  });

export const MethodProvider = () =>
  Provider.effect(
    MethodResource,
    Effect.gen(function* () {
      return {
        stables: ["restApiId", "resourceId", "httpMethod"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as Input.ResolveProps<MethodProps>;
          if (
            news.restApiId !== olds.restApiId ||
            news.resourceId !== olds.resourceId ||
            news.httpMethod !== olds.httpMethod
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          return yield* readMethodSnapshot({
            restApiId: output.restApiId,
            resourceId: output.resourceId,
            httpMethod: output.httpMethod,
          });
        }),
        create: Effect.fn(function* ({ news: newsIn, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Method props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<MethodProps>;
          const authType = news.authorizationType ?? "NONE";
          yield* putMethod(news);
          if (news.integration) {
            yield* ag.putIntegration(
              putIntegrationRequest(
                news.restApiId as string,
                news.resourceId as string,
                news.httpMethod,
                news.integration,
              ),
            );
          }
          yield* session.note(
            `Put method ${news.httpMethod} on resource ${news.resourceId}`,
          );
          return {
            restApiId: news.restApiId as string,
            resourceId: news.resourceId as string,
            httpMethod: news.httpMethod,
            authorizationType: authType,
            authorizerId: news.authorizerId,
            apiKeyRequired: news.apiKeyRequired,
            operationName: news.operationName,
            requestParameters: news.requestParameters,
            requestModels: news.requestModels,
            requestValidatorId: news.requestValidatorId,
            authorizationScopes: news.authorizationScopes,
            integration: news.integration,
          };
        }),
        update: Effect.fn(function* ({ news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Method props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<MethodProps>;
          const authType = news.authorizationType ?? "NONE";

          if (
            news.operationName !== output.operationName ||
            !deepEqual(news.requestParameters, output.requestParameters) ||
            !deepEqual(news.requestModels, output.requestModels) ||
            news.requestValidatorId !== output.requestValidatorId ||
            !deepEqual(news.authorizationScopes, output.authorizationScopes)
          ) {
            yield* deleteIntegrationSafe({
              restApiId: output.restApiId,
              resourceId: output.resourceId,
              httpMethod: output.httpMethod,
            });
            yield* deleteMethodSafe({
              restApiId: output.restApiId,
              resourceId: output.resourceId,
              httpMethod: output.httpMethod,
            });
            yield* putMethod({
              ...news,
              restApiId: output.restApiId,
              resourceId: output.resourceId,
              httpMethod: output.httpMethod,
            });
            if (news.integration) {
              yield* ag.putIntegration(
                putIntegrationRequest(
                  output.restApiId,
                  output.resourceId,
                  output.httpMethod,
                  news.integration,
                ),
              );
            }
            yield* session.note(`Recreated method ${output.httpMethod}`);
            return {
              restApiId: output.restApiId,
              resourceId: output.resourceId,
              httpMethod: output.httpMethod,
              authorizationType: authType,
              authorizerId: news.authorizerId,
              apiKeyRequired: news.apiKeyRequired,
              operationName: news.operationName,
              requestParameters: news.requestParameters,
              requestModels: news.requestModels,
              requestValidatorId: news.requestValidatorId,
              authorizationScopes: news.authorizationScopes,
              integration: news.integration,
            };
          }

          const patches: ag.PatchOperation[] = [];
          if (authType !== output.authorizationType) {
            patches.push({
              op: "replace",
              path: "/authorizationType",
              value: authType,
            });
          }
          if (news.authorizerId !== output.authorizerId) {
            patches.push({
              op: "replace",
              path: "/authorizerId",
              value: news.authorizerId ?? "",
            });
          }
          if (news.apiKeyRequired !== output.apiKeyRequired) {
            patches.push({
              op: "replace",
              path: "/apiKeyRequired",
              value: String(news.apiKeyRequired ?? false),
            });
          }
          if (patches.length > 0) {
            yield* ag.updateMethod({
              restApiId: output.restApiId,
              resourceId: output.resourceId,
              httpMethod: output.httpMethod,
              patchOperations: patches,
            });
          }

          if (!deepEqual(news.integration, output.integration)) {
            if (news.integration) {
              yield* ag.putIntegration(
                putIntegrationRequest(
                  output.restApiId,
                  output.resourceId,
                  output.httpMethod,
                  news.integration,
                ),
              );
            } else {
              yield* deleteIntegrationSafe({
                restApiId: output.restApiId,
                resourceId: output.resourceId,
                httpMethod: output.httpMethod,
              });
            }
          }

          yield* session.note(`Updated method ${output.httpMethod}`);
          const snap = yield* readMethodSnapshot({
            restApiId: output.restApiId,
            resourceId: output.resourceId,
            httpMethod: output.httpMethod,
          });
          if (!snap) {
            return yield* Effect.die("getMethod missing after update");
          }
          return snap;
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* deleteIntegrationSafe({
            restApiId: output.restApiId,
            resourceId: output.resourceId,
            httpMethod: output.httpMethod,
          });
          yield* deleteMethodSafe({
            restApiId: output.restApiId,
            resourceId: output.resourceId,
            httpMethod: output.httpMethod,
          });
          yield* session.note(`Deleted method ${output.httpMethod}`);
        }),
      };
    }),
  );
