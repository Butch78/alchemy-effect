import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import { omit } from "effect/Struct";
import { asEffect } from ".//Util/types.ts";
import type { NoopDiff, UpdateDiff } from "./Diff.ts";
import { InstanceId } from "./InstanceId.ts";
import * as Output from "./Output.ts";
import type { Provider } from "./Provider.ts";
import { getProviderByType, type ProviderService } from "./Provider.ts";
import type { Resource, ResourceLike } from "./Resource.ts";
import { StackName } from "./Stack.ts";
import { Stage } from "./Stage.ts";
import {
  State,
  StateStoreError,
  type CreatedResourceState,
  type CreatingResourceState,
  type ReplacedResourceState,
  type ReplacingResourceState,
  type ResourceState,
  type UpdatedResourceState,
  type UpdatingReourceState,
} from "./State/index.ts";

export type PlanError = never;

export const isCRUD = (node: any): node is CRUD => {
  return (
    node &&
    typeof node === "object" &&
    (node.action === "create" ||
      node.action === "update" ||
      node.action === "replace" ||
      node.action === "noop")
  );
};

/**
 * A node in the plan that represents a resource CRUD operation.
 */
export type CRUD<R extends ResourceLike = any> =
  | Create<R>
  | Update<R>
  | Delete<R>
  | Replace<R>
  | NoopUpdate<R>;

export type Apply<R extends ResourceLike = any> =
  | Create<R>
  | Update<R>
  | Replace<R>
  | NoopUpdate<R>;

export interface BaseNode<R extends ResourceLike = ResourceLike> {
  resource: R;
  provider: ProviderService<R>;
  downstream: string[];
}

export interface Create<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "create";
  props: R["Props"];
  bindings: R["binding"][];
  state: CreatingResourceState | undefined;
}

export interface Update<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "update";
  props: R["Props"];
  state:
    | CreatedResourceState
    | UpdatedResourceState
    | UpdatingReourceState
    // the props can change after creating the replacement resource,
    // so Apply needs to handle updates and then continue with cleaning up the replaced graph
    | ReplacedResourceState;
}

export interface Delete<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "delete";
  // a resource can be deleted no matter what state it's in
  state: ResourceState;
}

export interface NoopUpdate<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "noop";
  state: CreatedResourceState | UpdatedResourceState;
}

export interface Replace<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "replace";
  props: any;
  deleteFirst: boolean;
  state:
    | CreatingResourceState
    | CreatedResourceState
    | UpdatingReourceState
    | UpdatedResourceState
    | ReplacingResourceState
    | ReplacedResourceState;
}

export type Plan = {
  resources: {
    [id in string]: Apply<any>;
  };
  deletions: {
    [id in string]?: Delete<ResourceLike>;
  };
};

export const plan = <const Resources extends Resource[]>(
  ..._resources: Resources
): Plan =>
  Effect.gen(function* () {
    const state = yield* State;

    const findResources = (
      resource: Resource,
      visited: Set<string>,
    ): Resource[] => {
      if (visited.has(resource.LogicalId)) {
        return [];
      }
      visited.add(resource.LogicalId);
      const upstream = Object.values(Output.upstreamAny(resource.Props));
      return [
        resource,
        ...upstream,
        ...upstream.flatMap((r) => findResources(r, visited)),
      ];
    };
    const resources = _resources
      .flatMap((r) => findResources(r, new Set()))
      .filter(
        (r, i, arr) =>
          arr.findIndex((r2) => r2.LogicalId === r.LogicalId) === i,
      );

    // TODO(sam): rename terminology to Stack
    const stackName = yield* StackName;
    const stage = yield* Stage;

    const resourceIds = yield* state.list({
      stack: stackName,
      stage: stage,
    });
    const oldResources = yield* Effect.all(
      resourceIds.map((id) =>
        state.get({ stack: stackName, stage: stage, resourceId: id }),
      ),
      { concurrency: "unbounded" },
    );

    type ResolveEffect<T> = Effect.Effect<T, ResolveErr, ResolveReq>;
    type ResolveErr = StateStoreError;
    type ResolveReq =
      | ServiceMap.ServiceClass<Provider, string, ProviderService>
      | State;

    const resolvedResources: Record<
      string,
      Effect.Effect<
        | {
            [attr in string]: any;
          }
        | undefined,
        any,
        any
      >
    > = {};

    const resolveResource = (resourceExpr: Output.ResourceExpr<any, any>) =>
      Effect.gen(function* () {
        return yield* (resolvedResources[resourceExpr.src.LogicalId] ??=
          yield* Effect.cached(
            Effect.gen(function* () {
              const resource = resourceExpr.src as Resource & {
                provider: ServiceMap.ServiceClass<
                  Provider,
                  string,
                  ProviderService
                >;
              };
              const provider = yield* resource.provider;
              const props = yield* resolveInput(resource.Props);
              const oldState = yield* state.get({
                stack: stackName,
                stage: stage,
                resourceId: resource.LogicalId,
              });

              if (!oldState || oldState.status === "creating") {
                return resourceExpr;
              }

              const oldProps =
                oldState.status === "created" ||
                oldState.status === "updated" ||
                oldState.status === "replaced"
                  ? // if we're in a stable state, then just use the props
                    oldState.props
                  : // if we failed to update or replace, compare with the last known stable props
                    oldState.status === "updating" ||
                      oldState.status === "replacing"
                    ? oldState.old.props
                    : // TODO(sam): it kinda doesn't make sense to diff with a "deleting" state
                      oldState.props;

              const diff = yield* provider.diff
                ? provider
                    .diff({
                      id: resource.LogicalId,
                      olds: oldProps,
                      instanceId: oldState.instanceId,
                      news: props,
                      output: oldState.attr,
                    })
                    .pipe(
                      Effect.provide(
                        Layer.succeed(InstanceId, oldState.instanceId),
                      ),
                    )
                : Effect.succeed(undefined);

              const stables: string[] = [
                ...(provider.stables ?? []),
                ...(diff?.stables ?? []),
              ];

              const withStables = (output: any) =>
                stables.length > 0
                  ? new Output.ResourceExpr(
                      resourceExpr.src,
                      Object.fromEntries(
                        stables.map((stable) => [stable, output?.[stable]]),
                      ),
                    )
                  : // if there are no stable properties, treat every property as changed
                    resourceExpr;

              if (diff == null) {
                if (arePropsChanged(oldProps, props)) {
                  // the props have changed but the provider did not provide any hints as to what is stable
                  // so we must assume everything has changed
                  return withStables(oldState?.attr);
                }
              } else if (diff.action === "update") {
                return withStables(oldState?.attr);
              } else if (diff.action === "replace") {
                return resourceExpr;
              }
              if (
                oldState.status === "created" ||
                oldState.status === "updated" ||
                oldState.status === "replaced"
              ) {
                // we can safely return the attributes if we know they have stabilized
                return oldState?.attr;
              } else {
                // we must assume the resource doesn't exist if it hasn't stabilized
                return resourceExpr;
              }
            }),
          ));
      });

    const resolveInput = (input: any): ResolveEffect<any> =>
      Effect.gen(function* () {
        if (!input) {
          return input;
        } else if (Output.isExpr(input)) {
          return yield* resolveOutput(input);
        } else if (Array.isArray(input)) {
          return yield* Effect.all(input.map(resolveInput), {
            concurrency: "unbounded",
          });
        } else if (typeof input === "object") {
          return Object.fromEntries(
            yield* Effect.all(
              Object.entries(input).map(([key, value]) =>
                resolveInput(value).pipe(Effect.map((value) => [key, value])),
              ),
              { concurrency: "unbounded" },
            ),
          );
        }
        return input;
      });

    const resolveOutput = (expr: Output.Expr<any>): ResolveEffect<any> =>
      Effect.gen(function* () {
        if (Output.isResourceExpr(expr)) {
          return yield* resolveResource(expr);
        } else if (Output.isPropExpr(expr)) {
          const upstream = yield* resolveOutput(expr.expr);
          return upstream?.[expr.identifier];
        } else if (Output.isApplyExpr(expr)) {
          const upstream = yield* resolveOutput(expr.expr);
          return Output.hasOutputs(upstream) ? expr : expr.f(upstream);
        } else if (Output.isEffectExpr(expr)) {
          const upstream = yield* resolveOutput(expr.expr);
          return Output.hasOutputs(upstream) ? expr : yield* expr.f(upstream);
        } else if (Output.isAllExpr(expr)) {
          return yield* Effect.all(expr.outs.map(resolveOutput), {
            concurrency: "unbounded",
          });
        }
        return yield* Effect.die(new Error("Not implemented yet"));
      });

    // map of resource ID -> its downstream dependencies (resources that depend on it)
    const oldDownstreamDependencies: {
      [resourceId: string]: string[];
    } = Object.fromEntries(
      oldResources
        .filter((resource) => !!resource)
        .map((resource) => [resource.logicalId, resource.downstream]),
    );

    const newUpstreamDependencies: {
      [resourceId: string]: string[];
    } = Object.fromEntries(
      resources.map((resource) => [
        resource.LogicalId,
        [
          ...Object.values(Output.upstreamAny(resource.Props)).map(
            (r) => r.LogicalId,
          ),
          ...(isService(resource)
            ? resource.Props.bindings.capabilities.map((cap) => cap.resource.id)
            : []),
        ],
      ]),
    );

    const newDownstreamDependencies: {
      [resourceId: string]: string[];
    } = Object.fromEntries(
      resources.map((resource) => [
        resource.LogicalId,
        Object.entries(newUpstreamDependencies)
          .filter(([_, downstream]) => downstream.includes(resource.LogicalId))
          .map(([id]) => id),
      ]),
    );

    const resourceGraph = Object.fromEntries(
      (yield* Effect.all(
        resources
          .flatMap((resource) => [
            ...(isService(resource)
              ? resource.Props.bindings.capabilities.map(
                  (cap: Capability) => cap.resource as Resource,
                )
              : []),
            ...Object.values(Output.upstreamAny(resource.Props)),
            resource,
          ])
          .filter(
            (node, i, arr) => arr.findIndex((n) => n.id === node.id) === i,
          )
          .map(
            Effect.fn(function* (node) {
              const id = node.id;
              const resource = node as Resource & {
                provider: ResourceTags<Resource<string, string, any, any>>;
              };
              const news = yield* resolveInput(resource.Props);

              const oldState = yield* state.get({
                stack: stackName,
                stage: stage,
                resourceId: id,
              });
              const provider = yield* resource.provider.tag;

              const downstream = newDownstreamDependencies[id] ?? [];

              const bindings = undefined!;

              const Node = <T extends Apply>(
                node: Omit<
                  T,
                  "provider" | "resource" | "bindings" | "downstream"
                >,
              ) =>
                ({
                  ...node,
                  provider,
                  resource,
                  bindings,
                  downstream,
                }) as any as T;

              // handle empty and intermediate (non-final) states:
              if (oldState === undefined) {
                return Node<Create<Resource>>({
                  action: "create",
                  props: news,
                  state: oldState,
                });
              } else if (
                oldState.status === "creating" &&
                oldState.attr === undefined
              ) {
                if (provider.read) {
                  const attr = yield* provider
                    .read({
                      id,
                      instanceId: oldState.instanceId,
                      olds: oldState.props,
                      output: oldState.attr,
                      bindings,
                    })
                    .pipe(
                      Effect.provide(
                        Layer.succeed(InstanceId, oldState.instanceId),
                      ),
                    );
                  if (attr) {
                    return Node<Create<Resource>>({
                      action: "create",
                      props: news,
                      state: { ...oldState, attr },
                    });
                  }
                }
              }

              // TODO(sam): is this correct for all possible states a resource can be in?
              const oldProps = oldState.props;

              const diff = yield* asEffect(
                provider.diff
                  ? provider
                      .diff({
                        id,
                        olds: oldProps,
                        instanceId: oldState.instanceId,
                        output: oldState.attr,
                        news,
                      })
                      .pipe(
                        Effect.provide(
                          Layer.succeed(InstanceId, oldState.instanceId),
                        ),
                      )
                  : undefined,
              ).pipe(
                Effect.map(
                  (diff) =>
                    diff ??
                    ({
                      action: arePropsChanged(oldProps, news)
                        ? "update"
                        : "noop",
                    } as UpdateDiff | NoopDiff),
                ),
              );

              if (oldState.status === "creating") {
                if (diff.action === "noop") {
                  // we're in the creating state and props are un-changed
                  // let's just continue where we left off
                  return Node<Create<Resource>>({
                    action: "create",
                    props: news,
                    state: oldState,
                  });
                } else if (diff.action === "update") {
                  // props have changed in a way that is updatable
                  // again, just continue with the create
                  // TODO(sam): should we maybe try an update instead?
                  return Node<Create<Resource>>({
                    action: "create",
                    props: news,
                    state: oldState,
                  });
                } else {
                  // props have changed in an incompatible way
                  // because it's possible that an un-updatable resource has already been created
                  // we must use a replace step to create a new one and delete the potential old one
                  return Node<Replace<Resource>>({
                    action: "replace",
                    props: news,
                    deleteFirst: diff.deleteFirst ?? false,
                    state: oldState,
                  });
                }
              } else if (oldState.status === "updating") {
                // we started to update a resource but did not complete
                if (diff.action === "update" || diff.action === "noop") {
                  return Node<Update<Resource>>({
                    action: "update",
                    props: news,
                    state: oldState,
                  });
                } else {
                  // we started to update a resource but now believe we should replace it
                  return Node<Replace<Resource>>({
                    action: "replace",
                    deleteFirst: diff.deleteFirst ?? false,
                    props: news,
                    // TODO(sam): can Apply handle replacements when the oldState is UpdatingResourceState?
                    // -> or is there we do a provider.read to try and reconcile back to UpdatedResourceState?
                    state: oldState,
                  });
                }
              } else if (oldState.status === "replacing") {
                // resource replacement started, but the replacement may or may not have been created
                if (diff.action === "noop") {
                  // this is the stable case - noop means just continue with the replacement
                  return Node<Replace<Resource>>({
                    action: "replace",
                    deleteFirst: oldState.deleteFirst,
                    props: news,
                    state: oldState,
                  });
                } else if (diff.action === "update") {
                  // potential problem here - the props have changed since we tried to replace,
                  // but not enough to trigger another replacement. the resource provider should
                  // be designed as idempotent to converge to the right state when creating the new resource
                  // the newly generated instanceId is intended to assist with this
                  return Node<Replace<Resource>>({
                    action: "replace",
                    deleteFirst: oldState.deleteFirst,
                    props: news,
                    state: oldState,
                  });
                } else {
                  // ah shit, so we tried to replace the resource and then crashed
                  // now the props have changed again in such a way that the (maybe, maybe not)
                  // created resource should also be replaced

                  // TODO(sam): what should we do?
                  // 1. trigger a deletion of the potentially created resource
                  // 2. expect the resource provider to handle it idempotently?
                  // -> i don't think this case is fair to put on the resource provider
                  //    because if the resource was created, it's in a state that can't be updated
                  return yield* Effect.fail(
                    new CannotReplacePartiallyReplacedResource(id),
                  );
                }
              } else if (oldState.status === "replaced") {
                // replacement has been created but we're not done cleaning up the old state
                if (diff.action === "noop") {
                  // this is the stable case - noop means just continue cleaning up the replacement
                  return Node<Replace<Resource>>({
                    action: "replace",
                    deleteFirst: oldState.deleteFirst,
                    props: news,
                    state: oldState,
                  });
                } else if (diff.action === "update") {
                  // the replacement has been created but now also needs to be updated
                  // the resource provider should:
                  // 1. Update the newly created replacement resource
                  // 2. Then proceed as normal to delete the replaced resources (after all downstream references are updated)
                  return Node<Update<Resource>>({
                    action: "update",
                    props: news,
                    state: oldState,
                  });
                } else {
                  // the replacement has been created but now it needs to be replaced
                  // this is the worst-case scenario because downstream resources
                  // could have been been updated to point to the replaced resources
                  return yield* Effect.fail(
                    new CannotReplacePartiallyReplacedResource(id),
                  );
                }
              } else if (oldState.status === "deleting") {
                if (diff.action === "noop" || diff.action === "update") {
                  // we're in a partially deleted state, it is unclear whether it was or was not deleted
                  // it should be safe to re-create it with the same instanceId?
                  return Node<Create<Resource>>({
                    action: "create",
                    props: news,
                    state: {
                      ...oldState,
                      status: "creating",
                      props: news,
                    },
                  });
                } else {
                  return yield* Effect.fail(
                    new CannotReplacePartiallyReplacedResource(id),
                  );
                }
              } else if (diff.action === "update") {
                return Node<Update<Resource>>({
                  action: "update",
                  props: news,
                  state: oldState,
                });
              } else if (diff.action === "replace") {
                return Node<Replace<Resource>>({
                  action: "replace",
                  props: news,
                  state: oldState,
                  deleteFirst: diff?.deleteFirst ?? false,
                });
              } else {
                return Node<NoopUpdate<Resource>>({
                  action: "noop",
                  state: oldState,
                });
              }
            }),
          ),
        { concurrency: "unbounded" },
      )).map((update) => [update.resource.LogicalId, update]),
    ) as Plan["resources"];

    const deletions = Object.fromEntries(
      (yield* Effect.all(
        (yield* state.list({ stack: stackName, stage: stage })).map(
          Effect.fn(function* (id) {
            if (id in resourceGraph) {
              return;
            }
            const oldState = yield* state.get({
              stack: stackName,
              stage: stage,
              resourceId: id,
            });
            let attr: any = oldState?.attr;
            if (oldState) {
              const provider = yield* getProviderByType(oldState.resourceType);
              if (oldState.attr === undefined) {
                if (provider.read) {
                  attr = yield* provider
                    .read({
                      id,
                      instanceId: oldState.instanceId,
                      olds: oldState.props as never,
                      output: oldState.attr as never,
                      bindings: oldState.bindings ?? [],
                    })
                    .pipe(
                      Effect.provide(
                        Layer.succeed(InstanceId, oldState.instanceId),
                      ),
                    );
                }
              }
              return [
                id,
                {
                  action: "delete",
                  state: { ...oldState, attr },
                  // // TODO(sam): Support Detach Bindings
                  bindings: [],
                  provider,
                  resource: {
                    LogicalId: id,
                    Type: oldState.resourceType,
                    attr,
                    Props: oldState.props,
                  } as Resource,
                  // TODO(sam): is it enough to just pass through oldState?
                  downstream: oldDownstreamDependencies[id] ?? [],
                } satisfies Delete<Resource>,
              ] as const;
            }
          }),
        ),
        { concurrency: "unbounded" },
      )).filter((v) => !!v),
    );

    for (const [resourceId, deletion] of Object.entries(deletions)) {
      const dependencies = deletion.state.downstream.filter(
        (d) => d in resourceGraph,
      );
      if (dependencies.length > 0) {
        return yield* Effect.fail(
          new DeleteResourceHasDownstreamDependencies({
            message: `Resource ${resourceId} has downstream dependencies`,
            resourceId,
            dependencies,
          }),
        );
      }
    }

    return {
      resources: resourceGraph,
      deletions,
    } satisfies Plan;
  }) as any;

export class CannotReplacePartiallyReplacedResource extends Data.TaggedError(
  "CannotReplacePartiallyReplacedResource",
)<{
  message: string;
  logicalId: string;
}> {
  constructor(logicalId: string) {
    super({
      message:
        `Resource '${logicalId}' did not finish being replaced in a previous deployment ` +
        `and is expected to be replaced again in this deployment. ` +
        `You should revert its properties and try again after a successful deployment.`,
      logicalId,
    });
  }
}

export class DeleteResourceHasDownstreamDependencies extends Data.TaggedError(
  "DeleteResourceHasDownstreamDependencies",
)<{
  message: string;
  resourceId: string;
  dependencies: string[];
}> {}

const arePropsChanged = <R extends ResourceLike>(
  oldProps: R["Props"] | undefined,
  newProps: R["Props"],
) => {
  return (
    Output.hasOutputs(newProps) ||
    JSON.stringify(omit((oldProps ?? {}) as any, "bindings")) !==
      JSON.stringify(omit((newProps ?? {}) as any, "bindings"))
  );
};

// TODO(sam): compare props
// oldBinding.props !== newBinding.props;

/**
 * Print a plan in a human-readable format that shows the graph topology.
 */
export const printPlan = (plan: Plan): string => {
  const lines: string[] = [];
  const allNodes = { ...plan.resources, ...plan.deletions };

  // Build reverse mapping: upstream -> downstream
  const upstreamMap: Record<string, string[]> = {};
  for (const [id] of Object.entries(allNodes)) {
    upstreamMap[id] = [];
  }
  for (const [id, node] of Object.entries(allNodes)) {
    if (!node) continue;
    for (const downstreamId of node.state?.downstream ?? []) {
      if (upstreamMap[downstreamId]) {
        upstreamMap[downstreamId].push(id);
      }
    }
  }

  // Action symbols
  const actionSymbol = (action: string) => {
    switch (action) {
      case "create":
        return "+";
      case "update":
        return "~";
      case "delete":
        return "-";
      case "replace":
        return "±";
      case "noop":
        return "=";
      default:
        return "?";
    }
  };

  // Print header
  lines.push(
    "╔════════════════════════════════════════════════════════════════╗",
  );
  lines.push(
    "║                           PLAN                                 ║",
  );
  lines.push(
    "╠════════════════════════════════════════════════════════════════╣",
  );
  lines.push(
    "║ Legend: + create, ~ update, - delete, ± replace, = noop        ║",
  );
  lines.push(
    "╚════════════════════════════════════════════════════════════════╝",
  );
  lines.push("");

  // Print resources section
  lines.push(
    "┌─ Resources ────────────────────────────────────────────────────┐",
  );
  const resourceIds = Object.keys(plan.resources).sort();
  for (const id of resourceIds) {
    const node = plan.resources[id];
    const symbol = actionSymbol(node.action);
    const type = node.resource?.type ?? "unknown";
    const downstream = node.state?.downstream?.length
      ? ` → [${node.state?.downstream.join(", ")}]`
      : "";
    lines.push(`│ [${symbol}] ${id} (${type})${downstream}`);
  }
  if (resourceIds.length === 0) {
    lines.push("│ (none)");
  }
  lines.push(
    "└────────────────────────────────────────────────────────────────┘",
  );
  lines.push("");

  // Print deletions section
  lines.push(
    "┌─ Deletions ────────────────────────────────────────────────────┐",
  );
  const deletionIds = Object.keys(plan.deletions).sort();
  for (const id of deletionIds) {
    const node = plan.deletions[id]!;
    const type = node.resource?.Type ?? "unknown";
    const downstream = node.state.downstream?.length
      ? ` → [${node.state.downstream.join(", ")}]`
      : "";
    lines.push(`│ [-] ${id} (${type})${downstream}`);
  }
  if (deletionIds.length === 0) {
    lines.push("│ (none)");
  }
  lines.push(
    "└────────────────────────────────────────────────────────────────┘",
  );
  lines.push("");

  return lines.join("\n");
};
