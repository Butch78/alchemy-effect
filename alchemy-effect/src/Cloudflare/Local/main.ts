import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as WorkerD from "./workerd.ts";

Bun.serve({
  port: 9898,
  fetch: async (request) => {
    return new Response("Hello from Bun!", { status: 200 });
  },
});

const program = Effect.gen(function* () {
  const runtime = yield* WorkerD.Runtime;
  const result = yield* runtime.serve({
    sockets: [
      {
        name: "http",
        address: "127.0.0.1:3002",
        service: {
          name: "worker",
        },
      },
    ],
    services: [
      {
        name: "worker",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: [
            {
              name: "worker",
              esModule: `export default { 
                fetch: async (request, env) => {
                  return env.TEST.fetch(request);
                } 
              }`,
            },
          ],
          bindings: [
            {
              name: "TEST",
              service: {
                name: "rpc",
              },
            },
            {
              name: "CONTAINER",
              durableObjectNamespace: {
                className: "MyContainer",
              },
            },
          ],
          durableObjectNamespaces: [
            {
              className: "MyContainer",
              container: {
                imageName: "nginx:latest",
              },
            },
          ],
          containerEngine: {
            localDocker: {
              socketPath: "unix:///var/run/docker.sock",
            },
          },
        },
      },
      {
        name: "rpc",
        external: {
          address: "127.0.0.1:9898",
          http: {},
        },
      },
    ],
  });
  console.log(result);
  yield* Effect.never;
});

NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(WorkerD.RuntimeLive),
    Effect.provide(NodeServices.layer),
  ),
);

// Local -> Worker (Web Socket)
// Bi-directional RPC
// Worker -> Local RPC
// Local -> Worker RPC
