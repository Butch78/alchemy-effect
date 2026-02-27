import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

export interface ServiceLike {
  kind: "Service";
}

export interface ServiceShape<
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends ServiceMap.ServiceClass.Shape<Identifier, Shape>, ServiceLike {}

export interface Service<
  Self,
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends ServiceMap.Service<Self, Shape>, ServiceLike {
  readonly key: Identifier;
  new (_: never): ServiceShape<Identifier, Shape>;
  bind: (
    ...args: Parameters<Shape>
  ) => Effect.Effect<
    Effect.Success<ReturnType<Shape>>,
    Effect.Error<ReturnType<Shape>>,
    Self | Effect.Services<ReturnType<Shape>>
  >;
}

export const Service =
  <Self, Shape extends (...args: any[]) => Effect.Effect<any, any, any>>() =>
  <Identifier extends string>(id: Identifier) => {
    const self = ServiceMap.Service<Self, Shape>(id) as Service<
      Self,
      Identifier,
      Shape
    >;
    return Object.assign(self, {
      bind: (...args: any[]) => self.use((f) => f(...args)),
    });
  };

export interface PolicyLike {
  kind: "Policy";
}

export interface PolicyShape<
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends ServiceMap.ServiceClass.Shape<Identifier, Shape>, PolicyLike {}

export interface Policy<
  in out Self,
  in out Identifier extends string,
  in out Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
> extends ServiceMap.Service<Self, Shape> {
  readonly key: Identifier;
  new (_: never): PolicyShape<Identifier, Shape>;
  bind: (
    ...args: Parameters<Shape>
  ) => Effect.Effect<
    Effect.Success<ReturnType<Shape>>,
    Effect.Error<ReturnType<Shape>>,
    Self | Effect.Services<ReturnType<Shape>>
  >;
}

export const Policy =
  <Self, Shape extends (...args: any[]) => Effect.Effect<any, any, any>>() =>
  <Identifier extends string>(id: Identifier) => {
    const self = ServiceMap.Service<Self, Shape>(id) as Policy<
      Self,
      Identifier,
      Shape
    >;
    return Object.assign(self, {
      bind: (...args: any[]) => self.use((f) => f(...args)),
    });
  };
