import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type { HttpServerResponse } from "effect/unstable/http/HttpServerResponse";
import type { ContentType } from "../ContentType.ts";
import type { Instance } from "../Util/instance.ts";
import type * as Route from "./Operation.ts";
import type { Protocol } from "./Protocol.ts";

export interface EndpointService {
  fetch: (request: HttpServerRequest) => Effect.Effect<HttpServerResponse>;
}

export interface EndpointClass<
  Name extends string = any,
  Routes extends readonly Route.AnyOperation[] = any,
  Protocols extends Protocol[] = any,
  Accepts extends ContentType[] = any,
> extends ServiceMap.ServiceClass<
  Instance<Routes[number]>,
  `Endpoint<${Name}>`,
  EndpointService
> {
  readonly routes: Routes;
  readonly protocols: Protocols;
  readonly accepts: Accepts;
}

export const Endpoint = <
  Name extends string,
  const Routes extends readonly Route.AnyOperation[],
  const Protocols extends Protocol[] = [],
  const Accepts extends ContentType[] = [],
>(
  name: Name,
  props: {
    operations: Routes;
    protocols?: Protocols;
    accepts?: Accepts;
  },
): EndpointClass<Name, Routes, Protocols, Accepts> =>
  STag(name, {
    routes: props.operations,
    protocols: props.protocols,
    accepts: props.accepts,
  })<EndpointClass<Name, Routes, Protocols, Accepts>, EndpointService>() as any;
