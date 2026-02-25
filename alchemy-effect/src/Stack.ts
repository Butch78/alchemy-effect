import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import * as App from "./App.ts";
import { DotAlchemy } from "./Config.ts";
import type { Provider } from "./Provider.ts";
import type { ResourceLike } from "./Resource.ts";
import type { Stage } from "./Stage.ts";

export type StackServices =
  | App.App
  | Stage
  | FileSystem
  | Path
  | DotAlchemy
  | HttpClient;

export const make: {
  <const Name extends string>(
    name: Name,
  ): <A, Err = never, Req extends StackServices | ResourceLike = never>(
    eff: Effect.Effect<A, Err, Req>,
  ) => Effect.Effect<
    Stack<Name, A, Extract<Req, ResourceLike>>,
    never,
    Exclude<Req, ResourceLike> | Provider<Extract<Req, ResourceLike>>
  >;
  <
    const Name extends string,
    A,
    Err = never,
    Req extends StackServices | ResourceLike = never,
  >(
    name: Name,
    eff: Effect.Effect<A, Err, Req>,
  ): Effect.Effect<
    Stack<Name, A, Extract<Req, ResourceLike>>,
    never,
    Exclude<Req, ResourceLike> | Provider<Extract<Req, ResourceLike>>
  >;
} = undefined!;

export type Stack<
  Name extends string = string,
  Output = any,
  Resources extends ResourceLike = ResourceLike,
> = {
  name: Name;
  output: Output;
  resources: Resources[];
};
