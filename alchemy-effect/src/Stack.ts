import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { DotAlchemy } from "./Config.ts";
import type { ResourceLike } from "./Resource.ts";
import { Stage } from "./Stage.ts";

export type StackServices =
  | Stack
  | Stage
  | FileSystem
  | Path
  | DotAlchemy
  | HttpClient;

export class Stack extends ServiceMap.Service<
  Stack,
  {
    name: string;
    stage: string;
    // @internal
    resources: {
      [logicalId: string]: ResourceLike;
    };
  }
>()("Stack") {}

export const StackName = Stack.use((stack) => Effect.succeed(stack.name));

export const make =
  <const Name extends string>(name: Name) =>
  <A, Err = never>(effect: Effect.Effect<A, Err, StackServices>) =>
    effect.pipe(
      Effect.provideServiceEffect(
        Stack,
        Stage.asEffect().pipe(
          Effect.map(
            (stage) =>
              ({
                name,
                stage,
                resources: {},
              }) satisfies Stack["Service"],
          ),
        ),
      ),
    );
