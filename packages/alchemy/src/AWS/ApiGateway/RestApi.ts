import { Region } from "@distilled.cloud/aws/Region";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, tagRecord } from "../../Tags.ts";

import { restApiArn, syncTags } from "./common.ts";

export interface RestApiProps {
  /**
   * Name of the REST API.
   *
   * If omitted, Alchemy generates a deterministic physical name.
   */
  name?: string;
  description?: string;
  version?: string;
  cloneFrom?: string;
  binaryMediaTypes?: string[];
  minimumCompressionSize?: number;
  apiKeySource?: ag.ApiKeySourceType;
  endpointConfiguration?: ag.EndpointConfiguration;
  /** Resource policy document as a JSON string. */
  policy?: string;
  disableExecuteApiEndpoint?: boolean;
  securityPolicy?: ag.SecurityPolicy;
  endpointAccessMode?: ag.EndpointAccessMode;
  /** User-defined tags (Alchemy internal tags are merged automatically). */
  tags?: Record<string, string>;
}

export interface RestApi extends Resource<
  "AWS.ApiGateway.RestApi",
  RestApiProps,
  {
    restApiId: string;
    rootResourceId: string;
    name: string;
    description: string | undefined;
    version: string | undefined;
    binaryMediaTypes: string[] | undefined;
    minimumCompressionSize: number | undefined;
    apiKeySource: ag.ApiKeySourceType | undefined;
    endpointConfiguration: ag.EndpointConfiguration | undefined;
    policy: string | undefined;
    disableExecuteApiEndpoint: boolean | undefined;
    securityPolicy: ag.SecurityPolicy | undefined;
    endpointAccessMode: ag.EndpointAccessMode | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon API Gateway REST API (v1).
 *
 * This is the low-level REST API primitive. Compose it with
 * `GatewayResource`, `Method`, `Deployment`, and `Stage` when you need
 * precise control over REST API configuration. Higher-level OpenAPI or
 * Effect HttpApi schema generation can be layered on top separately.
 *
 * @section Creating an API
 * @example Regional REST API with Generated Name
 * ```typescript
 * import * as ApiGateway from "alchemy/AWS/ApiGateway";
 *
 * const api = yield* ApiGateway.RestApi("PublicApi", {
 *   endpointConfiguration: { types: ["REGIONAL"] },
 *   tags: { service: "orders" },
 * });
 * ```
 *
 * @example Private REST API
 * ```typescript
 * const api = yield* ApiGateway.RestApi("PrivateApi", {
 *   endpointConfiguration: {
 *     types: ["PRIVATE"],
 *     vpcEndpointIds: [endpoint.vpcEndpointId],
 *   },
 *   policy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: "*",
 *       Action: "execute-api:Invoke",
 *       Resource: "*",
 *     }],
 *   }),
 * });
 * ```
 *
 * @section Binary payloads
 * @example Enable Binary Media Types
 * ```typescript
 * const api = yield* ApiGateway.RestApi("BinaryApi", {
 *   binaryMediaTypes: ["application/octet-stream", "image/png"],
 *   minimumCompressionSize: 1024,
 * });
 * ```
 *
 * @section Endpoint hardening
 * @example Disable Default Execute API Endpoint
 * ```typescript
 * const api = yield* ApiGateway.RestApi("CustomDomainOnlyApi", {
 *   endpointConfiguration: { types: ["REGIONAL"] },
 *   disableExecuteApiEndpoint: true,
 * });
 * ```
 */
export const RestApi = Resource<RestApi>("AWS.ApiGateway.RestApi");

const generatedName = (id: string, props: RestApiProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 128,
      });

const snapshotFromApi = (api: ag.RestApi) => ({
  restApiId: api.id!,
  rootResourceId: api.rootResourceId!,
  name: api.name ?? "",
  description: api.description,
  version: api.version,
  binaryMediaTypes: api.binaryMediaTypes,
  minimumCompressionSize: api.minimumCompressionSize,
  apiKeySource: api.apiKeySource,
  endpointConfiguration: api.endpointConfiguration,
  policy: api.policy,
  disableExecuteApiEndpoint: api.disableExecuteApiEndpoint,
  securityPolicy: api.securityPolicy,
  endpointAccessMode: api.endpointAccessMode,
  tags: tagRecord(api.tags),
});

const patchReplace = (path: string, value: string): ag.PatchOperation => ({
  op: "replace",
  path,
  value,
});

const encodeJsonPointerSegment = (s: string) =>
  s.replace(/~/g, "~0").replace(/\//g, "~1");

const binaryMediaTypePath = (mediaType: string) =>
  `/binaryMediaTypes/${encodeJsonPointerSegment(mediaType)}`;

const buildBinaryMediaTypePatches = (
  prev: string[] | undefined,
  next: string[] | undefined,
): ag.PatchOperation[] => {
  const prevSet = [...new Set(prev ?? [])];
  const nextSet = [...new Set(next ?? [])];
  const patches: ag.PatchOperation[] = [];
  for (const m of prevSet) {
    if (!nextSet.includes(m)) {
      patches.push({ op: "remove", path: binaryMediaTypePath(m) });
    }
  }
  for (const m of nextSet) {
    if (!prevSet.includes(m)) {
      patches.push({
        op: "add",
        path: binaryMediaTypePath(m),
        value: m,
      });
    }
  }
  return patches;
};

const buildUpdatePatches = (
  news: RestApiProps,
  prev: RestApi["Attributes"],
): ag.PatchOperation[] => {
  const patches: ag.PatchOperation[] = [];
  if (news.name !== undefined && news.name !== prev.name) {
    patches.push(patchReplace("/name", news.name));
  }
  if (news.description !== prev.description) {
    patches.push(patchReplace("/description", news.description ?? ""));
  }
  if (news.version !== prev.version) {
    patches.push(patchReplace("/version", news.version ?? ""));
  }
  patches.push(
    ...buildBinaryMediaTypePatches(
      prev.binaryMediaTypes,
      news.binaryMediaTypes,
    ),
  );
  if (news.minimumCompressionSize !== prev.minimumCompressionSize) {
    patches.push(
      patchReplace(
        "/minimumCompressionSize",
        String(news.minimumCompressionSize ?? ""),
      ),
    );
  }
  if (news.apiKeySource !== prev.apiKeySource) {
    patches.push(patchReplace("/apiKeySource", news.apiKeySource ?? "HEADER"));
  }
  if (news.policy !== prev.policy) {
    patches.push(patchReplace("/policy", news.policy ?? ""));
  }
  if (news.disableExecuteApiEndpoint !== prev.disableExecuteApiEndpoint) {
    patches.push(
      patchReplace(
        "/disableExecuteApiEndpoint",
        String(!!news.disableExecuteApiEndpoint),
      ),
    );
  }
  if (news.securityPolicy !== prev.securityPolicy) {
    patches.push(
      patchReplace("/securityPolicy", news.securityPolicy ?? "TLS_1_0"),
    );
  }
  if (news.endpointAccessMode !== prev.endpointAccessMode) {
    patches.push(
      patchReplace("/endpointAccessMode", news.endpointAccessMode ?? ""),
    );
  }
  return patches;
};

export const RestApiProvider = () =>
  Provider.effect(
    RestApi,
    Effect.gen(function* () {
      const awsRegion = yield* Region;

      return {
        stables: ["restApiId", "rootResourceId"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as RestApiProps;
          if (
            // Endpoint type, private endpoint IDs, and IP address type are part
            // of the REST API endpoint shape; replacing avoids partial endpoint
            // drift that API Gateway cannot consistently patch in place.
            !deepEqual(
              news.endpointConfiguration?.types,
              olds.endpointConfiguration?.types,
            ) ||
            !deepEqual(
              news.endpointConfiguration?.vpcEndpointIds,
              olds.endpointConfiguration?.vpcEndpointIds,
            ) ||
            !deepEqual(
              news.endpointConfiguration?.ipAddressType,
              olds.endpointConfiguration?.ipAddressType,
            )
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.restApiId) return undefined;
          const api = yield* ag
            .getRestApi({ restApiId: output.restApiId })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!api?.id) return undefined;
          return snapshotFromApi(api);
        }),
        create: Effect.fn(function* ({ id, news: newsIn, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("RestApi props were not resolved");
          }
          const news = newsIn as RestApiProps;
          const name = yield* generatedName(id, news);
          const internalTags = yield* createInternalTags(id);
          const userTags = news.tags ?? {};
          const allTags = { ...userTags, ...internalTags };

          const created = yield* ag.createRestApi({
            name,
            description: news.description,
            version: news.version,
            cloneFrom: news.cloneFrom,
            binaryMediaTypes: news.binaryMediaTypes,
            minimumCompressionSize: news.minimumCompressionSize,
            apiKeySource: news.apiKeySource,
            endpointConfiguration: news.endpointConfiguration,
            policy: news.policy,
            tags: allTags,
            disableExecuteApiEndpoint: news.disableExecuteApiEndpoint,
            securityPolicy: news.securityPolicy,
            endpointAccessMode: news.endpointAccessMode,
          });

          if (!created.id || !created.rootResourceId) {
            return yield* Effect.die(
              "createRestApi missing id or rootResourceId",
            );
          }

          yield* session.note(`Created REST API ${created.id}`);

          const full = yield* ag.getRestApi({ restApiId: created.id });
          if (!full.id || !full.rootResourceId) {
            return yield* Effect.die("getRestApi missing id or rootResourceId");
          }
          return snapshotFromApi(full);
        }),
        update: Effect.fn(function* ({ id, news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("RestApi props were not resolved");
          }
          const news = newsIn as RestApiProps;
          const patches = buildUpdatePatches(news, output);
          if (patches.length > 0) {
            yield* ag.updateRestApi({
              restApiId: output.restApiId,
              patchOperations: patches,
            });
          }

          const internalTags = yield* createInternalTags(id);
          const newTags = { ...news.tags, ...internalTags };
          if (!deepEqual(output.tags, newTags)) {
            const arn = restApiArn(awsRegion, output.restApiId);
            yield* syncTags({
              resourceArn: arn,
              oldTags: output.tags,
              newTags,
            });
          }

          yield* session.note(`Updated REST API ${output.restApiId}`);

          const full = yield* ag.getRestApi({ restApiId: output.restApiId });
          if (!full.id) {
            return yield* Effect.die("getRestApi missing id after update");
          }
          return snapshotFromApi(full);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteRestApi({ restApiId: output.restApiId })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Deleted REST API ${output.restApiId}`);
        }),
      };
    }),
  );
