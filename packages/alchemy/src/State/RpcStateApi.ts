import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

/**
 * RPC counterpart to {@link HttpStateApi}.
 *
 * Same shape, same semantics, but the wire format is the Effect-RPC
 * transport (one POST per call, JSON-serialised payload + envelope)
 * instead of one REST route per operation. Persisted state values pass
 * through opaquely as `Schema.Unknown` — both the client and the worker
 * apply {@link encodeState} / {@link reviveStateRecursive} themselves.
 */

/** Path the RPC handler is mounted on inside the worker. */
export const RPC_PATH = "/rpc" as const;

const StackPayload = { stack: Schema.String };
const StackStagePayload = { stack: Schema.String, stage: Schema.String };
const ResourceKeyPayload = {
  stack: Schema.String,
  stage: Schema.String,
  fqn: Schema.String,
};

const listStacks = Rpc.make("listStacks", {
  success: Schema.Array(Schema.String),
});

const listStages = Rpc.make("listStages", {
  payload: StackPayload,
  success: Schema.Array(Schema.String),
});

const listResources = Rpc.make("listResources", {
  payload: StackStagePayload,
  success: Schema.Array(Schema.String),
});

const getState = Rpc.make("getState", {
  payload: ResourceKeyPayload,
  success: Schema.UndefinedOr(Schema.Unknown),
});

const setState = Rpc.make("setState", {
  payload: {
    ...ResourceKeyPayload,
    value: Schema.Unknown,
  },
  success: Schema.Unknown,
});

const deleteState = Rpc.make("deleteState", {
  payload: ResourceKeyPayload,
});

const deleteStack = Rpc.make("deleteStack", {
  payload: {
    stack: Schema.String,
    stage: Schema.optional(Schema.String),
  },
});

const getReplacedResources = Rpc.make("getReplacedResources", {
  payload: StackStagePayload,
  success: Schema.Array(Schema.Unknown),
});

const getStackOutput = Rpc.make("getStackOutput", {
  payload: StackStagePayload,
  success: Schema.UndefinedOr(Schema.Unknown),
});

const setStackOutput = Rpc.make("setStackOutput", {
  payload: {
    ...StackStagePayload,
    value: Schema.Unknown,
  },
  success: Schema.Unknown,
});

export class StateRpcs extends RpcGroup.make(
  listStacks,
  listStages,
  listResources,
  getState,
  setState,
  deleteState,
  deleteStack,
  getReplacedResources,
  getStackOutput,
  setStackOutput,
) {}
