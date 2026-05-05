import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete database with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const database = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("DefaultDatabase");
      }),
    );

    expect(database.databaseName).toBeDefined();
    expect(database.databaseId).toBeDefined();

    const actualDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: database.databaseId,
    });
    expect(actualDatabase.uuid).toEqual(database.databaseId);

    yield* stack.destroy();

    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete database", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const database = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("TestDatabase", {
          readReplication: { mode: "disabled" },
        });
      }),
    );

    const actualDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: database.databaseId,
    });
    expect(actualDatabase.uuid).toEqual(database.databaseId);

    const updatedDatabase = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("TestDatabase", {
          readReplication: { mode: "auto" },
        });
      }),
    );

    expect(updatedDatabase.databaseId).toEqual(database.databaseId);

    const actualUpdatedDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: updatedDatabase.databaseId,
    });
    expect(actualUpdatedDatabase.readReplication?.mode).toEqual("auto");

    yield* stack.destroy();

    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider("applies migrations from migrationsDir", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationsDir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-migrations-",
    });

    yield* fs.writeFileString(
      path.join(migrationsDir, "0001_users.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
    );
    yield* fs.writeFileString(
      path.join(migrationsDir, "0002_posts.sql"),
      "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
    );

    yield* stack.destroy();

    const database = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("MigrationDatabase", {
          migrationsDir,
        });
      }),
    );

    expect(database.migrationsDir).toEqual(migrationsDir);
    expect(database.migrationsTable).toEqual("d1_migrations");
    expect(Object.keys(database.migrationsHashes).sort()).toEqual([
      "0001_users.sql",
      "0002_posts.sql",
    ]);

    const tables = yield* listTables(accountId, database.databaseId);
    expect(tables).toContain("users");
    expect(tables).toContain("posts");
    expect(tables).toContain("d1_migrations");

    const applied = yield* queryAll<{ id: string; name: string }>(
      accountId,
      database.databaseId,
      "SELECT id, name FROM d1_migrations ORDER BY id;",
    );
    expect(applied).toEqual([
      { id: "00001", name: "0001_users.sql" },
      { id: "00002", name: "0002_posts.sql" },
    ]);
    for (const row of applied) {
      expect(row.id).toMatch(/^\d{5}$/);
    }

    // Adding a new migration on update should apply only the new one and the
    // sequential id should continue from where it left off.
    yield* fs.writeFileString(
      path.join(migrationsDir, "0003_comments.sql"),
      "CREATE TABLE comments (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
    );

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("MigrationDatabase", {
          migrationsDir,
        });
      }),
    );
    expect(updated.databaseId).toEqual(database.databaseId);

    const tablesAfter = yield* listTables(accountId, database.databaseId);
    expect(tablesAfter).toContain("comments");

    const appliedAfter = yield* queryAll<{ id: string; name: string }>(
      accountId,
      database.databaseId,
      "SELECT id, name FROM d1_migrations ORDER BY id;",
    );
    expect(appliedAfter).toEqual([
      { id: "00001", name: "0001_users.sql" },
      { id: "00002", name: "0002_posts.sql" },
      { id: "00003", name: "0003_comments.sql" },
    ]);

    yield* stack.destroy();
    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider("applies migrations using a custom migrationsTable", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationsDir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-custom-migrations-",
    });
    yield* fs.writeFileString(
      path.join(migrationsDir, "0001_create.sql"),
      "CREATE TABLE test_migrations_table (id INTEGER PRIMARY KEY, name TEXT);",
    );

    yield* stack.destroy();

    const database = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("CustomMigrationsTableDb", {
          migrationsDir,
          migrationsTable: "custom_migration_tracking",
        });
      }),
    );

    expect(database.migrationsTable).toEqual("custom_migration_tracking");

    const tables = yield* listTables(accountId, database.databaseId);
    expect(tables).toContain("custom_migration_tracking");
    expect(tables).toContain("test_migrations_table");
    // The default table must NOT be created when a custom one is configured.
    expect(tables).not.toContain("d1_migrations");

    yield* stack.destroy();
    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider(
  "migrates legacy 2-column migration table to wrangler schema",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-legacy-",
      });
      yield* fs.writeFileString(
        path.join(migrationsDir, "0002_create_users.sql"),
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
      );
      yield* fs.writeFileString(
        path.join(migrationsDir, "0003_create_posts.sql"),
        "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
      );

      yield* stack.destroy();

      // Step 1: deploy the database without migrations so we can seed a legacy
      // 2-column d1_migrations table on it before re-deploying with a
      // migrationsDir.
      const seeded = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("LegacyMigrationDb");
        }),
      );

      yield* execSql(
        accountId,
        seeded.databaseId,
        `CREATE TABLE d1_migrations (
         id TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL
       );`,
      );
      yield* execSql(
        accountId,
        seeded.databaseId,
        `INSERT INTO d1_migrations (id, applied_at) VALUES
         ('0000_initial_setup.sql', datetime('now', '-1 day')),
         ('0001_add_indexes.sql', datetime('now', '-1 hour'));`,
      );

      // Step 2: deploy again with a migrationsDir; the resource should detect
      // the legacy 2-column schema, migrate to (id, name, applied_at), and apply
      // the new migrations on top.
      const upgraded = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("LegacyMigrationDb", {
            migrationsDir,
          });
        }),
      );
      expect(upgraded.databaseId).toEqual(seeded.databaseId);

      const columns = yield* queryAll<{ name: string }>(
        accountId,
        seeded.databaseId,
        "PRAGMA table_info(d1_migrations);",
      );
      const colNames = columns.map((c) => c.name).sort();
      expect(colNames).toEqual(["applied_at", "id", "name"]);

      const records = yield* queryAll<{ id: string; name: string }>(
        accountId,
        seeded.databaseId,
        "SELECT id, name FROM d1_migrations ORDER BY id;",
      );
      const names = records.map((r) => r.name);
      expect(names).toContain("0000_initial_setup.sql");
      expect(names).toContain("0001_add_indexes.sql");
      expect(names).toContain("0002_create_users.sql");
      expect(names).toContain("0003_create_posts.sql");

      // All ids should be 5-digit zero-padded sequential numbers.
      for (const r of records) {
        expect(r.id).toMatch(/^\d{5}$/);
      }
      expect(records[0].id).toBe("00001");
      expect(records[records.length - 1].id).toBe(
        records.length.toString().padStart(5, "0"),
      );

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(seeded.databaseId, accountId);
    }).pipe(logLevel),
);

test.provider("imports SQL files via importFiles", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-imports-",
    });
    const importPath = path.join(dir, "seed.sql");

    yield* fs.writeFileString(
      importPath,
      [
        "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL);",
        "INSERT INTO widgets (id, label) VALUES (1, 'one');",
        "INSERT INTO widgets (id, label) VALUES (2, 'two');",
      ].join("\n"),
    );

    yield* stack.destroy();

    const database = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("ImportDatabase", {
          importFiles: [importPath],
        });
      }),
    );

    expect(database.importHashes[importPath]).toBeDefined();

    const widgets = yield* getResults<{ id: number; label: string }>(
      accountId,
      database.databaseId,
      "SELECT id, label FROM widgets ORDER BY id;",
    );
    expect(widgets).toEqual([
      { id: 1, label: "one" },
      { id: 2, label: "two" },
    ]);

    yield* stack.destroy();
    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider("clones a database by databaseId", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-clone-id-",
    });
    const seedPath = path.join(dir, "seed.sql");

    yield* fs.writeFileString(
      seedPath,
      [
        "CREATE TABLE colors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        "INSERT INTO colors (id, name) VALUES (1, 'red'), (2, 'green'), (3, 'blue');",
      ].join("\n"),
    );

    yield* stack.destroy();

    const { source, target } = yield* stack.deploy(
      Effect.gen(function* () {
        const source = yield* Cloudflare.D1Database("CloneByIdSource", {
          importFiles: [seedPath],
        });
        const target = yield* Cloudflare.D1Database("CloneByIdTarget", {
          clone: { databaseId: source.databaseId },
        });
        return { source, target };
      }),
    );

    expect(target.databaseId).not.toEqual(source.databaseId);

    const targetColors = yield* getResults<{ id: number; name: string }>(
      accountId,
      target.databaseId,
      "SELECT id, name FROM colors ORDER BY id;",
    );
    expect(targetColors).toEqual([
      { id: 1, name: "red" },
      { id: 2, name: "green" },
      { id: 3, name: "blue" },
    ]);

    yield* stack.destroy();
    yield* waitForDatabaseToBeDeleted(source.databaseId, accountId);
    yield* waitForDatabaseToBeDeleted(target.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider("clones a database by name lookup", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-clone-name-",
    });
    const seedPath = path.join(dir, "seed.sql");

    yield* fs.writeFileString(
      seedPath,
      [
        "CREATE TABLE animals (id INTEGER PRIMARY KEY, kind TEXT NOT NULL);",
        "INSERT INTO animals (id, kind) VALUES (1, 'cat'), (2, 'dog');",
      ].join("\n"),
    );

    yield* stack.destroy();

    const { source, target } = yield* stack.deploy(
      Effect.gen(function* () {
        const source = yield* Cloudflare.D1Database("CloneByNameSource", {
          importFiles: [seedPath],
        });
        const target = yield* Cloudflare.D1Database("CloneByNameTarget", {
          clone: { name: source.databaseName },
        });
        return { source, target };
      }),
    );

    expect(target.databaseId).not.toEqual(source.databaseId);

    const animals = yield* getResults<{ id: number; kind: string }>(
      accountId,
      target.databaseId,
      "SELECT id, kind FROM animals ORDER BY id;",
    );
    expect(animals).toEqual([
      { id: 1, kind: "cat" },
      { id: 2, kind: "dog" },
    ]);

    yield* stack.destroy();
    yield* waitForDatabaseToBeDeleted(source.databaseId, accountId);
    yield* waitForDatabaseToBeDeleted(target.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider(
  "clones a database by passing the source resource directly",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-clone-direct-",
      });
      const seedPath = path.join(dir, "seed.sql");

      yield* fs.writeFileString(
        seedPath,
        [
          "CREATE TABLE shapes (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
          "INSERT INTO shapes (id, name) VALUES (1, 'square'), (2, 'circle');",
        ].join("\n"),
      );

      yield* stack.destroy();

      const { source, target } = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* Cloudflare.D1Database("CloneDirectSource", {
            importFiles: [seedPath],
          });
          const target = yield* Cloudflare.D1Database("CloneDirectTarget", {
            clone: source,
          });
          return { source, target };
        }),
      );

      expect(target.databaseId).not.toEqual(source.databaseId);

      const shapes = yield* getResults<{ id: number; name: string }>(
        accountId,
        target.databaseId,
        "SELECT id, name FROM shapes ORDER BY id;",
      );
      expect(shapes).toEqual([
        { id: 1, name: "square" },
        { id: 2, name: "circle" },
      ]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(source.databaseId, accountId);
      yield* waitForDatabaseToBeDeleted(target.databaseId, accountId);
    }).pipe(logLevel),
);

const queryAll = Effect.fn(function* <T>(
  accountId: string,
  databaseId: string,
  sql: string,
) {
  const queryDb = yield* d1.queryDatabase;
  const result = yield* queryDb({ accountId, databaseId, sql });
  return (result.result[0]?.results ?? []) as T[];
});

const execSql = (accountId: string, databaseId: string, sql: string) =>
  queryAll<unknown>(accountId, databaseId, sql);

const listTables = Effect.fn(function* (accountId: string, databaseId: string) {
  const rows = yield* queryAll<{ name: string }>(
    accountId,
    databaseId,
    "SELECT name FROM sqlite_master WHERE type='table';",
  );
  return rows.map((r) => r.name);
});

/**
 * D1 query results are eventually consistent following an import/clone, so
 * retry until we see at least one row (matches v1's `getResults` helper).
 */
const getResults = Effect.fn(function* <T>(
  accountId: string,
  databaseId: string,
  sql: string,
) {
  return yield* queryAll<T>(accountId, databaseId, sql).pipe(
    Effect.flatMap((rows) =>
      rows.length > 0
        ? Effect.succeed(rows)
        : Effect.fail(new EmptyResults({ sql })),
    ),
    Effect.retry({
      while: (e) => e instanceof EmptyResults,
      schedule: Schedule.both(
        Schedule.spaced(Duration.seconds(1)),
        Schedule.recurs(10),
      ),
    }),
    Effect.orDie,
  );
});

// Engine-level adoption: D1 databases have no ownership signal (Cloudflare
// doesn't expose tags on D1), so a name match in `read` is treated as silent
// adoption.
test.provider(
  "existing database (matching name) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const databaseName = `alchemy-test-d1-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Phase 1: deploy normally so a real D1 database exists.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("AdoptableDatabase", {
            name: databaseName,
          });
        }),
      );
      expect(initial.databaseName).toEqual(databaseName);
      const initialId = initial.databaseId;

      // Phase 2: wipe local state — the database stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableDatabase",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy without `adopt(true)`. The engine calls
      // `provider.read`, which lists databases by name and returns plain
      // attrs — silent adoption.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("AdoptableDatabase", {
            name: databaseName,
          });
        }),
      );

      // Same physical database — adoption, not re-creation.
      expect(adopted.databaseId).toEqual(initialId);
      expect(adopted.databaseName).toEqual(databaseName);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableDatabase",
        });
      }).pipe(Effect.provide(stack.state));

      expect(persisted?.attr).toMatchObject({
        databaseId: initialId,
        databaseName,
      });

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(initialId, accountId);
    }).pipe(logLevel),
);

const waitForDatabaseToBeDeleted = Effect.fn(function* (
  databaseId: string,
  accountId: string,
) {
  yield* d1
    .getDatabase({
      accountId,
      databaseId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new DatabaseStillExists())),
      Effect.retry({
        while: (e): e is DatabaseStillExists =>
          e instanceof DatabaseStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("DatabaseNotFound", () => Effect.void),
    );
});

class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}
class EmptyResults extends Data.TaggedError("EmptyResults")<{
  sql: string;
}> {}

// ─────────────────────────────────────────────────────────────────────
// Lifecycle convergence
//
// Reconcile must converge from any starting state — pristine, drifted,
// out-of-band-deleted, or replaced — without leaning on `olds` as the
// source of truth. The tests below pin down each of those starting
// states.
// ─────────────────────────────────────────────────────────────────────

test.provider(
  "redeploy with same props is a no-op — physical id preserved",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("IdempotentDb", {
            readReplication: { mode: "disabled" },
          });
        }),
      );

      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("IdempotentDb", {
            readReplication: { mode: "disabled" },
          });
        }),
      );

      // Same physical id — reconciler did not replace and did not
      // collide with itself on the createDatabase race path.
      expect(v2.databaseId).toEqual(v1.databaseId);
      expect(v2.databaseName).toEqual(v1.databaseName);

      // The database is still healthy on Cloudflare.
      const live = yield* d1.getDatabase({
        accountId,
        databaseId: v2.databaseId,
      });
      expect(live.uuid).toEqual(v1.databaseId);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(v1.databaseId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile resets read_replication.mode mutated out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Phase 1: deploy with replication explicitly disabled.
      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("DriftDb", {
            readReplication: { mode: "disabled" },
          });
        }),
      );

      // Mutate replication out-of-band — patch directly via the raw D1
      // SDK. This is the kind of drift you'd see from someone editing
      // the database in the Cloudflare dashboard.
      const patched = yield* d1.patchDatabase({
        accountId,
        databaseId: v1.databaseId,
        readReplication: { mode: "auto" },
      });
      expect(patched.readReplication?.mode).toEqual("auto");

      // Re-deploy with the original desired props — reconcile must
      // observe the drifted "auto" mode and patch back to "disabled"
      // even though `olds.readReplication.mode` matches `news`. This
      // is the observe-vs-`olds` invariant.
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("DriftDb", {
            readReplication: { mode: "disabled" },
          });
        }),
      );
      expect(v2.databaseId).toEqual(v1.databaseId);

      const live = yield* d1.getDatabase({
        accountId,
        databaseId: v2.databaseId,
      });
      expect(live.readReplication?.mode).toEqual("disabled");

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(v1.databaseId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "reconcile re-creates a database that was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const databaseName = `alchemy-test-d1-recreate-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("RecreateDb", {
            name: databaseName,
          });
        }),
      );
      expect(v1.databaseName).toEqual(databaseName);
      const originalId = v1.databaseId;

      // Delete the database out-of-band — local state still says it
      // exists, Cloudflare disagrees.
      yield* d1.deleteDatabase({
        accountId,
        databaseId: originalId,
      });
      yield* waitForDatabaseToBeDeleted(originalId, accountId);

      // Reconcile must observe the missing database via getDatabase
      // (now `DatabaseNotFound`), fall through to listDatabases (also
      // missing), and create a fresh one with the same desired name.
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("RecreateDb", {
            name: databaseName,
          });
        }),
      );
      expect(v2.databaseName).toEqual(databaseName);
      // Different physical uuid — Cloudflare assigns a new one on
      // re-create. The state must be the new id, not the stale one.
      expect(v2.databaseId).not.toEqual(originalId);

      const live = yield* d1.getDatabase({
        accountId,
        databaseId: v2.databaseId,
      });
      expect(live.uuid).toEqual(v2.databaseId);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(v2.databaseId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "changing databaseName triggers replace; old database is deleted",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const suffix = Math.random().toString(36).slice(2, 8);
      const nameA = `alchemy-test-d1-replace-a-${suffix}`;
      const nameB = `alchemy-test-d1-replace-b-${suffix}`;

      const a = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("RenameDb", {
            name: nameA,
          });
        }),
      );
      expect(a.databaseName).toEqual(nameA);

      const b = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("RenameDb", {
            name: nameB,
          });
        }),
      );
      expect(b.databaseName).toEqual(nameB);
      // Different physical database — replacement, not in-place rename.
      expect(b.databaseId).not.toEqual(a.databaseId);

      // The previous physical database must be gone after replace. The
      // engine creates B, swaps the reference, then deletes A.
      yield* waitForDatabaseToBeDeleted(a.databaseId, accountId);

      const liveB = yield* d1.getDatabase({
        accountId,
        databaseId: b.databaseId,
      });
      expect(liveB.uuid).toEqual(b.databaseId);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(b.databaseId, accountId);
    }).pipe(logLevel),
);

test.provider(
  "migrations recover from a partial-failure mid-batch on next deploy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-resume-",
      });

      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_first.sql"),
        "CREATE TABLE first_table (id INTEGER PRIMARY KEY);",
      );
      yield* fs.writeFileString(
        path.join(migrationsDir, "0002_second.sql"),
        "CREATE TABLE second_table (id INTEGER PRIMARY KEY);",
      );

      yield* stack.destroy();

      // Phase 1: deploy without a migrationsDir so the database exists
      // but no migrations table is set up.
      const seeded = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("ResumeMigrationsDb");
        }),
      );

      // Simulate a partial failure: pretend the previous run applied
      // 0001 but crashed before applying 0002. We seed the migrations
      // table by hand with the wrangler-compatible 3-column schema and
      // run the 0001 SQL ourselves. The next deploy must observe that
      // 0001 is already applied (skip it) and apply only 0002.
      yield* execSql(
        accountId,
        seeded.databaseId,
        `CREATE TABLE d1_migrations (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           applied_at TEXT NOT NULL
         );`,
      );
      yield* execSql(
        accountId,
        seeded.databaseId,
        "CREATE TABLE first_table (id INTEGER PRIMARY KEY);",
      );
      yield* execSql(
        accountId,
        seeded.databaseId,
        `INSERT INTO d1_migrations (id, name, applied_at)
         VALUES ('00001', '0001_first.sql', datetime('now'));`,
      );

      // Phase 2: deploy with the migrationsDir. Reconcile reads the
      // applied set from d1_migrations, sees 0001 is already there, and
      // applies only 0002. It must NOT re-run 0001 (which would fail
      // with "table first_table already exists").
      const resumed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("ResumeMigrationsDb", {
            migrationsDir,
          });
        }),
      );
      expect(resumed.databaseId).toEqual(seeded.databaseId);

      const tables = yield* listTables(accountId, seeded.databaseId);
      expect(tables).toContain("first_table");
      expect(tables).toContain("second_table");

      const applied = yield* queryAll<{ id: string; name: string }>(
        accountId,
        seeded.databaseId,
        "SELECT id, name FROM d1_migrations ORDER BY id;",
      );
      // 0001 was already there with id 00001; 0002 picks up the next
      // sequential id (00002) — no duplicate rows for 0001.
      expect(applied).toEqual([
        { id: "00001", name: "0001_first.sql" },
        { id: "00002", name: "0002_second.sql" },
      ]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(seeded.databaseId, accountId);
    }).pipe(logLevel),
);

test.provider("destroying an already-deleted database is a no-op", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const db = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("DoubleDestroyDb");
      }),
    );

    // Delete out-of-band so the next destroy hits the
    // `DatabaseNotFound` path inside provider.delete. It must succeed.
    yield* d1.deleteDatabase({
      accountId,
      databaseId: db.databaseId,
    });
    yield* waitForDatabaseToBeDeleted(db.databaseId, accountId);

    // First destroy: the engine still has state for this resource;
    // delete should idempotently succeed because the underlying
    // `deleteDatabase` call catches DatabaseNotFound.
    yield* stack.destroy();

    // Second destroy: state is gone; this is a true no-op. Repeated
    // destroys must never throw.
    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("adopt(true) re-claims a foreign database by name", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const databaseName = `alchemy-test-d1-takeover-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    // Phase 1: deploy under one logical id so a real D1 database
    // exists outside of the to-be-tested logical id.
    const original = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("OriginalOwner", {
          name: databaseName,
        });
      }),
    );
    expect(original.databaseName).toEqual(databaseName);

    // Phase 2: drop the local state for the original logical id — the
    // database stays on Cloudflare with no owning state row.
    yield* Effect.gen(function* () {
      const state = yield* State;
      yield* state.delete({
        stack: stack.name,
        stage: "test",
        fqn: "OriginalOwner",
      });
    }).pipe(Effect.provide(stack.state));

    // Phase 3: deploy under a *different* logical id with `adopt(true)`.
    // D1 has no tag-based ownership, so `read` matches the database by
    // name and the engine adopts it under the new logical id. The
    // physical database is the same; only the local state row's fqn
    // changes.
    const adopted = yield* stack
      .deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1Database("NewOwner", {
            name: databaseName,
          });
        }),
      )
      .pipe(adopt(true));

    expect(adopted.databaseName).toEqual(databaseName);
    expect(adopted.databaseId).toEqual(original.databaseId);

    yield* stack.destroy();
    yield* waitForDatabaseToBeDeleted(original.databaseId, accountId);
  }).pipe(logLevel),
);
