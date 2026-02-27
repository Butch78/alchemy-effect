import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { pipeArguments, type Pipeable } from "effect/Pipeable";
import { SingleShotGen } from "effect/Utils";
import type { Input } from "./Input.ts";
import type { InstanceId } from "./InstanceId.ts";
import * as Output from "./Output.ts";
import type { Provider, ProviderService } from "./Provider.ts";
import { Stack } from "./Stack.ts";

export type ResourceCtor<R extends ResourceLike, Req = never> = (
  id: string,
  props?: R["Props"],
) => Effect.Effect<R, never, Req | Stack>;

export type ResourceClass<Self extends ResourceLike> = ResourceCtor<
  Self,
  Provider<Self>
> &
  Effect.Effect<ResourceCtor<Self>> & {
    provider: ResourceProviders<Self>;
  };

export type LogicalId = string;

export interface ResourceLike<
  Type extends string = any,
  Props extends object = any,
  Attributes extends object = any,
  Binding = any,
> extends Pipeable {
  Type: Type;
  LogicalId: LogicalId;
  Props: Props;
  /** @internal phantom */
  Attributes: Attributes;
  /** @internal phantom */
  Binding: Binding;
}

export type Resource<
  Type extends string = any,
  Props extends object = any,
  Attributes extends object = any,
  Binding = never,
> = ResourceLike<Type, Props, Attributes, Binding> & {
  bind(binding: Input<Binding>): Effect.Effect<void>;
} & {
  [attr in keyof Attributes]-?: Output.Output<Attributes[attr], never>;
};

export const Resource = <R extends ResourceLike>(
  type: R["Type"],
): ResourceClass<R> => {
  const constructor = Effect.fnUntraced(function* (
    id: string,
    props?: R["Props"],
  ) {
    const stack = yield* Stack;

    const existing = stack.resources[id];
    if (existing) {
      // TODO(sam): check if props are same and allow duplicates
      return yield* Effect.die(new Error(`Resource ${id} already exists`));
    }

    const Resource = (stack.resources[id] = new Proxy(
      {
        Type: type,
        LogicalId: id,
        Props: props,
        // Attributes: undefined!,
        // Binding: undefined!,
        bind() {},
      } as any,
      {
        get: (target, prop) => {
          if (prop in target) {
            return target[prop as keyof typeof target];
          }
          const resourceExpr = Output.of(Resource as R) as Output.ResourceExpr<
            R["Attributes"],
            never
          >;
          return new Output.PropExpr(resourceExpr, prop);
        },
      },
    )) as R;
    return Resource;
  });

  const Service = {
    [Symbol.iterator]() {
      return new SingleShotGen(this);
    },
    pipe() {
      return pipeArguments(this.asEffect(), arguments);
    },
    asEffect() {
      return Effect.map(
        Effect.services(),
        (services) => (id: string, props: R["Props"]) =>
          constructor(id, props).pipe(Effect.provide(services)),
      );
    },
  };

  return Object.assign(constructor, Service) as any as ResourceClass<R>;
};

export interface ResourceProviders<Resource extends ResourceLike> {
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
        Resource,
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
    Provider<Resource>,
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
      Resource,
      ReadReq,
      DiffReq,
      PrecreateReq,
      CreateReq,
      UpdateReq,
      DeleteReq
    >,
  ) => ProviderService<
    Resource,
    ReadReq,
    DiffReq,
    PrecreateReq,
    CreateReq,
    UpdateReq,
    DeleteReq
  >;
}
