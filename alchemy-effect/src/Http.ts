import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type { HttpServerResponse } from "effect/unstable/http/HttpServerResponse";
import { Middleware, type MiddlewareClass } from "./Server/Middleware.ts";
import { Protocol } from "./Server/Protocol.ts";
import { applyTrait, defineTrait, type Trait, type TraitDef } from "./Trait.ts";

export const Rest = undefined!;
export const RestServer = undefined!;
export const RestClient = undefined!;

export const JsonRpc = undefined!;
export const JsonRpcServer = undefined!;
export const JsonRpcClient = undefined!;

export class HttpProtocol extends Protocol("HTTP")<HttpProtocol>() {}

export interface Header<
  Name extends string | undefined = undefined,
> extends Trait<"Header"> {
  name: Name;
}

export const Header = defineTrait(
  "Header",
  <Name extends string | undefined = undefined>(
    name: Name = undefined as Name,
  ) =>
    applyTrait<Header<Name>>("Header", {
      name,
    }),
);

export interface Upgrade extends Trait<"Upgrade"> {}
export const Upgrade = defineTrait<Upgrade>("Upgrade", {});

export interface HttpMiddleware<
  T extends Trait,
  Err = never,
  Req = never,
> extends MiddlewareClass<HttpProtocol, T, HttpServerResponse, Err, Req> {}

export namespace middleware {
  export const effect = <T extends TraitDef, Err = never, Req = never>(
    trait: T,
    fn: (context: {
      input: any;
      trait: T["trait"];
      next: Effect.Effect<HttpServerResponse, Err, Req>;
    }) => Effect.Effect<HttpServerResponse, Err, Req>,
  ) =>
    Layer.succeed(
      Middleware(HttpProtocol, trait)<HttpServerResponse, Err, Req, never>(),
      {
        fn,
      },
    );
}

export const serve = Effect.fn(function* (
  handler: (
    request: HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse, HttpBodyError, HttpServerRequest>,
) {});
