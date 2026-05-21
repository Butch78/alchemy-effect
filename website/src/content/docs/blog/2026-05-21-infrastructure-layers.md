---
title: Service Layers, infrastructure behind a typed interface
date: 2026-05-21T21:00:00Z
excerpt: A refreshed Service Layers doc plus a new step-by-step guide for building one. The encapsulation example is now Worker-shaped and idiomatic — the same init/runtime split you actually write — and the guide walks `JobService` end-to-end with one diff per step.
---

A **Service Layer** packages a slice of infrastructure behind a
typed service. Code that depends on the service stays
cloud-agnostic; swapping the implementation swaps the underlying
resources, bindings, and runtime glue. The mechanism has been
there for a while — what changed in this release is how it's
documented.

## The doc is now Worker-shaped

The old encapsulation example reached for a one-off `getJob(id)`
helper to show that `WorkerEnvironment` was leaking through.
That's not where the pain actually shows up. The pain shows up
in real handlers — a Worker `fetch` welded to one cloud's
binding:

```typescript
Effect.gen(function* () {
  const kv = yield* Cloudflare.KVNamespaceBinding.bind(MyKV);

  return {
    fetch: Effect.gen(function* () {
      const job = yield* kv.get<Job>("job-1", "json");
      return HttpServerResponse.json(job);
    }),
  };
});
```

KV error, KV value shape, KV binding — all leaking into `fetch`.
Moving the data to DynamoDB or swapping in an in-memory fake
for tests means rewriting the handler, not just the storage
wiring.

[Service Layers](/concepts/layers) now opens with this exact
shape and walks through collapsing it into a `JobService` Service
Layer the consumer never has to know is KV-backed. The init /
runtime phase split matches how `Cloudflare.Worker` is actually
authored, so the example reads like the code you'd write — not
an abstract sketch. ([#386](https://github.com/alchemy-run/alchemy-effect/pull/386))

## And there's a new guide for building one

[`/guides/infrastructure-layers`](/guides/infrastructure-layers)
is the "now build one yourself" companion. It walks
`JobService` end-to-end — one heading, one diff, one
explanation per step — from contract to provided Service Layer.

The progression:

1. Define the service contract (`Context.Service` + the typed methods)
2. Scaffold a Service Layer with stubbed methods
3. Declare the KV namespace inside the Layer
4. Bind the namespace with `KVNamespaceBinding.bind(...)`
5. Implement the methods against the typed client
6. Resolve `JobService` in the Worker init closure
7. Provide the Service Layer (`Effect.provide(JobServiceKV)`)
8. Provide the runtime binding (`Layer.provide(KVNamespaceBindingLive)`)

The punchline is step 8. `Layer.provide` satisfies the Service
Layer's dependency on `KVNamespaceBinding` *privately*, so the
consumer's required context shrinks back to just `JobService`.
Swap the implementation for a DynamoDB-backed Service Layer, the
consumer's signature is unchanged — that's the whole point of
encapsulation, but it only works if the wiring is done
correctly. The guide makes the wiring explicit. ([#383](https://github.com/alchemy-run/alchemy-effect/pull/383))

## Where to go next

- [Service Layers](/concepts/layers) — the refreshed encapsulation walkthrough
- [Building Infrastructure Layers](/guides/infrastructure-layers) — the new step-by-step guide
- [Binding](/concepts/binding) — what `.bind(...)` does under the hood
- [Phases](/concepts/phases) — when init vs runtime code runs
- [Circular Bindings](/guides/circular-bindings) — two Service Layers referencing each other
