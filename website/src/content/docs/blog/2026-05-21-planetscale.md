---
title: PlanetScale — Postgres and MySQL, branches, migrations, and Hyperdrive in one Effect
date: 2026-05-21
excerpt: PlanetScale Postgres and MySQL are now first-class in Alchemy. Schema → branch → migrations → role → Hyperdrive → Worker is one dependency graph — copy-on-write data branching per PR, the role's connection shape feeds Hyperdrive directly, and the whole thing is Effect-native end to end.
---

PlanetScale shipped in [#113](https://github.com/alchemy-run/alchemy-effect/pull/113) — both flavors. Six resources: `PostgresDatabase`, `MySQLDatabase`, `PostgresBranch`, `MySQLBranch`, `PostgresRole` + `PostgresDefaultRole`, and `MySQLPassword`. Plus first-class migrations, seed imports, and a one-line wiring into `Cloudflare.Hyperdrive`.

Big thanks to **[Lucas Thevenet](https://github.com/lucasthevenet)** who drove the implementation, and to **[Michael Kassabov](https://github.com/Mkassabov)** and **John Royal** for the review pass.

The interesting part isn't that the resources exist. It's that the whole chain — schema → branch → migrations → role → Hyperdrive → Worker — collapses into a single Effect graph where each node's `Output` is the next node's input. No glue, no copy-pasted connection strings, no separate "run migrations" step in CI.

## The whole stack in one file

```typescript
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Planetscale from "alchemy/Planetscale";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "App",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Drizzle.providers(),
      Planetscale.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const schema = yield* Drizzle.Schema("app-schema", {
      schema: "./src/schema.ts",
      out: "./migrations",
    });

    const database = yield* Planetscale.PostgresDatabase("app-db", {
      region: { slug: "us-east" },
      clusterSize: "PS_10",
    });

    const branch = yield* Planetscale.PostgresBranch("app-branch", {
      database,
      migrationsDir: schema.out,
    });

    const role = yield* Planetscale.PostgresRole("app-role", {
      database,
      branch,
      inheritedRoles: ["postgres"],
    });

    const hyperdrive = yield* Cloudflare.Hyperdrive("app-hyperdrive", {
      origin: role.origin,
    });

    const api = yield* Api;

    return { url: api.url.as<string>() };
  }),
);
```

That's the entire infrastructure. Six resources, one dependency edge each.

Two things worth pausing on:

**1. `migrationsDir: schema.out`** — `Drizzle.Schema` runs first, regenerates migration SQL into `./migrations`, and exposes the path as an `Output`. `PostgresBranch` consumes it, scans the directory, hashes each file, and applies whatever's new transactionally against the branch. The tracking table is `__alchemy_migrations` — same name across both engines. Add a column to `schema.ts`, redeploy, the new migration runs. Don't touch `schema.ts`, redeploy, the branch reconciler sees the input hash hasn't moved and skips the apply entirely.

**2. `origin: role.origin`** — the role exposes a `PostgresOrigin` attribute whose shape is exactly what `Cloudflare.Hyperdrive` consumes (`scheme`, `host`, `port`, `database`, `user`, `password: Redacted<string>`). No URL parsing, no template string, no `connectionString.split(":")`. The role's output is the Hyperdrive's input, fields lined up. MySQL works the same way via `password.origin`.

## In the Worker

```typescript
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Hyperdrive } from "../alchemy.run.ts";
import { relations, Users } from "./schema.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.bind(Hyperdrive);
    const db = yield* Drizzle.postgres(conn.connectionString, { relations });

    return {
      fetch: Effect.gen(function* () {
        const users = yield* db.select().from(Users);
        return yield* HttpServerResponse.json({ users });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.HyperdriveBindingLive)),
) {}
```

`Cloudflare.Hyperdrive.bind(Hyperdrive)` resolves the runtime binding inside the Worker. `conn.connectionString` is an `Effect<Redacted<string>, never, RuntimeContext>` — feed it to `Drizzle.postgres` and you get a typed, relational query builder. The credentials never appear in plaintext anywhere in your source.

## Why engine-prefixed resource names?

PlanetScale runs Postgres and MySQL through deeply different machinery — Vitess underneath MySQL, native Postgres for the other — and the differences leak into the resource model:

- **Branching semantics differ.** MySQL branches have `isProduction`, `safeMigrations`, promote/demote — those don't exist on Postgres branches. So `MySQLBranch` and `PostgresBranch` are separate resources with their own prop sets, not a unified `Branch` with optional fields.
- **Auth differs.** MySQL hands out **passwords** with roles (`reader` / `writer` / `readwriter` / `admin`). Postgres hands out **roles** with PG inheritance (`postgres`, `pg_read_all_data`, …) and has a singleton **default role** per branch. So you get `MySQLPassword`, `PostgresRole`, and `PostgresDefaultRole` — never one without the other.
- **Cluster sizing differs.** `MySQLClusterSize` and `PostgresClusterSize` are distinct string-template types, so if PlanetScale spins up a new SKU on one side without the other, you don't get stuck on a union.

The engine prefix is doing real work — it's how the type system tells you "you can't put `inheritedRoles: ['postgres']` on a MySQL database" before you ever run `alchemy plan`.

## Copy-on-write data branching per PR

This is the workflow PlanetScale was designed for, and it's where the resource model earns its keep.

The example splits stages into two tiers:

```typescript
import * as Alchemy from "alchemy";
import * as Planetscale from "alchemy/Planetscale";
import * as Effect from "effect/Effect";

export const PlanetscaleDb = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  const database = stage.startsWith("pr-")
    ? yield* Planetscale.PostgresDatabase.ref("app-db", {
        stage: `staging-${stage}`,
      })
    : yield* Planetscale.PostgresDatabase("app-db", {
        region: { slug: "us-east" },
        clusterSize: "PS_10",
      });

  const branch = yield* Planetscale.PostgresBranch("app-branch", {
    database,
    migrationsDir: "./migrations",
  });

  const role = yield* Planetscale.PostgresRole("app-role", {
    database,
    branch,
    inheritedRoles: ["postgres"],
  });

  return { database, branch, role };
});
```

`staging-*` stages own the long-lived database. `pr-*` stages don't provision their own — they call `PostgresDatabase.ref("app-db", { stage: "staging-pr-42" })` to read the deployed attributes of the staging database, then create their own ephemeral branch off it. The branch is copy-on-write, applies any new migrations from the PR's source tree, and gets its own role + Hyperdrive + Worker.

PR opens → branch + role + Hyperdrive + preview Worker (seconds, not minutes — the database is already there). PR merges → branch deletes, role deletes, Hyperdrive deletes, Worker deletes, staging database is untouched.

The full walkthrough lives in [Branch from a shared database](/tutorial/cloudflare/branch-from-shared-database).

## MySQL is the same shape

Swap `Postgres*` for `MySQL*` and `Role` for `Password`:

```typescript
const database = yield* Planetscale.MySQLDatabase("app-db", {
  region: { slug: "us-east" },
  clusterSize: "PS_10",
});

const branch = yield* Planetscale.MySQLBranch("app-branch", {
  database,
  isProduction: false,
  migrationsDir: "./migrations",
});

const password = yield* Planetscale.MySQLPassword("app-password", {
  database,
  branch,
  role: "readwriter",
});

const hyperdrive = yield* Cloudflare.Hyperdrive("app-hyperdrive", {
  origin: password.origin,
});
```

Same `migrationsDir` machinery, same `origin → Hyperdrive` wiring, same Worker binding on the other side.

:::caution
For MySQL, prefer the **PlanetScale serverless driver** over `mysql2`. `mysql2` pulls in CJS dependencies that don't survive the Worker bundler today — Hyperdrive itself works fine with MySQL, but the driver choice on top is the lever. Postgres bundles cleanly with the standard `postgres-js` / Drizzle path shown above.
:::

## Seed data with `importFiles`

Branches and databases both accept an `importFiles` prop — a list of SQL files applied after migrations on every reconcile, hashed so they're idempotent:

```typescript
const branch = yield* Planetscale.PostgresBranch("app-branch", {
  database,
  migrationsDir: schema.out,
  importFiles: ["./seed/users.sql", "./seed/posts.sql"],
});
```

Same input-hash machinery as migrations. Edit the file, redeploy, it re-runs. Don't edit it, redeploy, it skips. No "should I run the seed script?" decision to make.

## Auth

`bun alchemy login` now has a `Planetscale` step. It picks up `PLANETSCALE_API_TOKEN_ID`, `PLANETSCALE_API_TOKEN`, and `PLANETSCALE_ORGANIZATION` from your environment, or prompts you for them and writes them into your local credentials store. Same flow as the other providers — no separate config file, no per-resource auth juggling.

## Why this is the right shape

PlanetScale's branching workflow has always been the selling point — what's been missing in IaC is a way to drive it from your stack without dropping into shell scripts for migrations and connection-string formatting. The Effect graph dissolves that boundary:

- Migration files are an `Output` of `Drizzle.Schema`, consumed by the branch.
- Connection origin is an `Output` of the role/password, consumed by Hyperdrive.
- The Worker's runtime binding is resolved from the Hyperdrive resource.
- Stage references let preview environments treat the shared staging database as just another `Output`.

One graph. Typed edges all the way through. Nothing in your source ever holds a raw connection string.

## Get started

- Tutorial: [Connect to a Database with Hyperdrive](/tutorial/cloudflare/neon-hyperdrive) — same tutorial covers Neon, PlanetScale Postgres, and PlanetScale MySQL via tabs.
- Shared-database pattern: [Branch from a shared database](/tutorial/cloudflare/branch-from-shared-database).
- Postgres example: [`examples/cloudflare-planetscale-postgres-drizzle`](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-planetscale-postgres-drizzle)
- MySQL example: [`examples/cloudflare-planetscale-mysql-drizzle`](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-planetscale-mysql-drizzle)

---

## Also worth calling out

- **Email Routing + `SendEmail` Worker binding** ([#314](https://github.com/alchemy-run/alchemy-effect/pull/314)) — Cloudflare Email Routing resources land alongside a typed Worker binding for sending mail from a Worker. Same pattern as Hyperdrive: declare the resource on the stack, bind it inside the Worker, get a typed Effect-shaped client back. Pairs nicely with the PlanetScale flow above — write a row, fire a confirmation email, all in the same `fetch` handler.
