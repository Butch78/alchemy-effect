import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

// RPCs served by the REMOTE proxy worker (called by local)
const remotePing = Rpc.make("remotePing", {
  success: Schema.Struct({ ts: Schema.Number }),
});

const remoteEcho = Rpc.make("remoteEcho", {
  payload: { message: Schema.String },
  success: Schema.Struct({ message: Schema.String }),
});

export class RemoteRpcs extends RpcGroup.make(remotePing, remoteEcho) {}

// RPCs served by the LOCAL client (called by remote)
const localPing = Rpc.make("localPing", {
  success: Schema.Struct({ ts: Schema.Number }),
});

const localEcho = Rpc.make("localEcho", {
  payload: { message: Schema.String },
  success: Schema.Struct({ message: Schema.String }),
});

export class LocalRpcs extends RpcGroup.make(localPing, localEcho) {}
