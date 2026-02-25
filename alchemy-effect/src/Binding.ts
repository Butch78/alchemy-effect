import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import { Plantime } from "./ExecutionContext.ts";
import type { Input } from "./Input.ts";
import { Phase } from "./Phase.ts";
import type { ResourceClass, ResourceLike } from "./Resource.ts";
import type { Instance } from "./Util/instance.ts";

export interface Binding<
  Tag extends string = string,
  R extends ResourceLike = ResourceLike,
  Props = any,
> {
  tag: Tag;
  resource: R;
  props: Props;
  bind<Self>(
    this: Self,
    to: R,
    props: Props,
  ): Effect.Effect<void, never, Instance<Self>>;
  new (): Binding<Tag, R, Props>;
}

export const Policy =
  <R extends ResourceLike, Props = never>() =>
  <Tag extends string>(tag: Tag): Binding<Tag, R, Props> =>
    class {
      static readonly type = tag;
      static bind(resource: R): Effect.Effect<void> {
        return Effect.succeed(undefined);
      }
    } as any;

export const effect = <
  B extends Binding,
  R extends ResourceClass,
  Err = never,
  Req = never,
>(
  [resource, binding]: [R, B],
  impl: NoInfer<
    (
      self: ResourceClass.ResourceInstance<R>,
      binding: B["resource"],
      props: B["props"],
    ) => Effect.Effect<
      {
        [prop in keyof R["ctor"]]?: Input<R["ctor"][prop]>;
      },
      Err,
      Req
    >
  >,
): Layer.Layer<[ResourceClass.ResourceInstance<R>, B["resource"]], Err, Req> =>
  Layer.succeed(BindingService(resource, binding), impl);

export const succeed = <R extends ResourceClass, B extends Binding>(
  [resource, binding]: [R, B],
  impl: NoInfer<
    (
      self: ResourceClass.ResourceInstance<R>,
      binding: B["resource"],
      props: B["props"],
      // ...props: never extends B["props"] ? [] : [props: B["props"]]
    ) => {
      [prop in keyof R["ctor"]]?: Input<R["ctor"][prop]>;
    }
  >,
): Layer.Layer<[ResourceClass.ResourceInstance<R>, B["resource"]]> =>
  Layer.succeed(BindingService(resource, binding), impl);

const BindingService = <R extends ResourceClass, B extends Binding>(
  resource: R,
  binding: B,
) =>
  ServiceMap.Service<[ResourceClass.ResourceInstance<R>, B["resource"]], any>()(
    `${resource.type}(${binding.tag})`,
  );

export type BindingFn<Req = never> = (
  ...args: any[]
) => Effect.Effect<void, never, Req | Plantime>;

export interface BindingTag<
  Tag extends string,
  Fn extends BindingFn<Req> = any,
  Req = any,
> {
  tag: Tag;
  fn: Fn;
  Req: Req;
  new (): BindingTag<Tag, Fn, Req>;
  service<Self>(): ServiceMap.Service<Instance<Self>, Fn>;
  layer<Self>(this: Self): Layer.Layer<Instance<Self>, never, Req>;
}

export const fn = <B extends BindingTag<any, any, any>>(
  tag: B["tag"],
): ((...args: Parameters<B["fn"]>) => Effect.Effect<void, never, B["Req"]>) =>
  Effect.fn(function* () {
    if ((yield* Phase) === "plan") {
      return yield* Service(tag).service();
    } else {
      return (yield* Plantime).get(tag);
    }
  }) as (
    ...args: Parameters<B["fn"]>
  ) => Effect.Effect<void, never, B | B["Req"]>;

export const Service: {
  <const Tag extends string>(tag: Tag): BindingTag<Tag>;
  <const Tag extends string, Fn extends BindingFn<Req>, Req = never>(
    tag: Tag,
    fn: Fn,
  ): BindingTag<Tag, Fn, Req>;
} = ((...[tag, fn]: [string, (...args: any[]) => any] | [string]) =>
  fn
    ? ServiceMap.Service()(tag, {
        make: Effect.succeed(fn),
      })
    : ServiceMap.Service()(tag)) as any;
