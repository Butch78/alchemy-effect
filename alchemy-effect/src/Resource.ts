import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Pipeable } from "effect/Pipeable";
import type { Input } from "./Input.ts";
import type { InstanceId } from "./InstanceId.ts";
import type * as Output from "./Output.ts";
import type { Provider, ProviderService } from "./Provider.ts";

export interface ResourceLike<
  Base = any,
  Type extends string = any,
  Id extends string = any,
  Props extends object = any,
  Attributes extends object = any,
  Binding = any,
> extends Pipeable {
  kind: "Resource";
  type: Type;
  id: Id;
  attr: Attributes;
  props: Props;
  base: Base;
  binding: Binding;
}

export type Resource<
  Base = any,
  Type extends string = any,
  Id extends string = any,
  Props extends object = any,
  Attributes extends object = any,
  Binding = never,
> = ResourceLike<Base, Type, Id, Props, Attributes, Binding> & {
  bind(binding: Input<Binding>): Effect.Effect<void>;
} & {
  [attr in keyof Attributes]: Output.Output<Attributes[attr], never>;
};

export type ResourceCtor = (id: string, props?: any) => ResourceEffect<any>;

export type ResourceClass<Ctor extends ResourceCtor = ResourceCtor> = Ctor &
  Effect.Effect<Ctor, never, ResourceServices<Ctor>> & {
    readonly type: ResourceType<Ctor>;
    readonly ctor: Ctor;
    new (): ResourceInstance<Ctor>;
    provider: ResourceProviders<Ctor>;
  };

export const Resource = <Fn extends ResourceCtor>(
  type: ResourceType<Fn>,
): ResourceClass<Fn> => {
  const fn = (id: string, props?: any) => Effect.gen(function* () {});

  return Object.assign(fn, {
    type,
    fn,
    bind: Effect.fn(function* (binding: Input<any>) {
      // const runtime = yield* Stack;
    }),
  }) as any as ResourceClass<Fn>;
};

export type ResourceEffect<R extends ResourceLike, Req = never> = Effect.Effect<
  R,
  never,
  Req
>;

export type ResourceType<Ctor extends ResourceCtor> =
  ResourceInstance<Ctor>["type"];

export type ResourceServices<Ctor extends ResourceCtor> = Ctor extends (
  ...args: any
) => Effect.Effect<infer _A, infer _E, infer R>
  ? R
  : never;

export type ResourceInstance<Ctor extends ResourceCtor> = Ctor extends (
  ...args: any
) => Effect.Effect<infer A, infer _E, infer _R>
  ? A
  : never;

export interface ResourceProviders<Ctor extends ResourceCtor = ResourceCtor> {
  effect<
    Req = never,
    ReadReq = never,
    DiffReq = never,
    PrecreateReq = never,
    CreateReq = never,
    UpdateReq = never,
    DeleteReq = never,
  >(
    eff: Effect.Effect<
      ProviderService<
        Extract<Effect.Success<ReturnType<Ctor>>, ResourceLike>,
        ReadReq,
        DiffReq,
        PrecreateReq,
        CreateReq,
        UpdateReq,
        DeleteReq
      >,
      never,
      Req
    >,
  ): Layer.Layer<
    Provider<Extract<Effect.Success<ReturnType<Ctor>>, ResourceLike>>,
    never,
    Exclude<
      | Req
      | ReadReq
      | DiffReq
      | PrecreateReq
      | CreateReq
      | UpdateReq
      | DeleteReq,
      InstanceId
    >
  >;
  of: <
    ReadReq = never,
    DiffReq = never,
    PrecreateReq = never,
    CreateReq = never,
    UpdateReq = never,
    DeleteReq = never,
  >(
    service: ProviderService<
      ResourceInstance<Ctor>,
      ReadReq,
      DiffReq,
      PrecreateReq,
      CreateReq,
      UpdateReq,
      DeleteReq
    >,
  ) => ProviderService<
    ResourceInstance<Ctor>,
    ReadReq,
    DiffReq,
    PrecreateReq,
    CreateReq,
    UpdateReq,
    DeleteReq
  >;
}
