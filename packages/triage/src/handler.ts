import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import IndexDO, { INDEX_DO_NAME } from "./IndexDO.ts";
import ProjectDO, { type BatchedIssueResult } from "./ProjectDO.ts";
import type {
  Issue,
  IssueStatus,
  ProjectSummary,
  RawEvent,
  TriageDecision,
} from "./Types.ts";

export interface HandlerOptions {
  /**
   * Workers AI model used for both per-event classification and per-project
   * summarization. The same model is fine in practice — the prompts differ.
   *
   * @default "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
   */
  model?: string;
  /**
   * Discord webhook URL the triage worker posts new issues to. Falls back
   * to the `DISCORD_WEBHOOK_URL` worker env var.
   */
  discordWebhookUrl?: string;
  /**
   * Shared secret expected on `Authorization: Bearer ...` for the
   * `/webhooks/axiom` route. Falls back to the `TRIAGE_WEBHOOK_SECRET`
   * worker env var.
   */
  webhookSecret?: string;
  /**
   * Severity threshold below which we won't post to Discord. 1..5.
   * @default 3
   */
  discordSeverityFloor?: number;
  /**
   * The fallback project id used when an event arrives without telemetry
   * resource attributes (e.g. an unrelated tenant manually POSTing). Set
   * this to a stable string per deployment to avoid filling the index
   * with `unknown` projects.
   *
   * @default "unknown"
   */
  unknownProjectId?: string;
}

class Unauthorized extends Data.TaggedError("Unauthorized")<{}> {}

const requireAuth = (expected: string | undefined) =>
  Effect.gen(function* () {
    if (!expected) return;
    const request = yield* HttpServerRequest;
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${expected}`) {
      return yield* Effect.fail(new Unauthorized());
    }
  });

/**
 * Triage worker handler. Wire as the third argument to `Cloudflare.Worker`:
 *
 * ```ts
 * import * as Triage from "@alchemy.run/triage";
 *
 * class TriageWorker extends Cloudflare.Worker<TriageWorker>()(
 *   "Triage",
 *   { main: import.meta.path, url: true, ... },
 *   Triage.handler({ webhookSecret: env.TRIAGE_WEBHOOK_SECRET }),
 * ) {}
 * ```
 *
 * Data flow is strictly left-to-right:
 *
 * ```text
 *   Axiom ──▶ handler ──recordBatch──▶ ProjectDO ──pushToIndex──▶ IndexDO
 *                                       (per project)              (single)
 * ```
 *
 * The handler shards the incoming batch by `alchemy.git.root_commit`
 * (the project id emitted by `packages/alchemy/src/Telemetry/Attributes.ts`)
 * and calls `recordBatch` exactly once per project. The ProjectDO writes
 * its own raw events, refreshes its own AI summary + issue list, and then
 * pushes both to the IndexDO. The handler never talks to the IndexDO
 * directly — that's the ProjectDO's job.
 *
 * Routes:
 *
 * - `POST /webhooks/axiom`  — Axiom Monitor / customWebhook payload.
 * - `GET  /projects`        — list known projects, ordered by recency.
 * - `GET  /projects/:id`    — return the project's meta + AI summary +
 *                              top resources/errors.
 * - `POST /projects/:id/summarize` — force the summarizer to run now.
 * - `GET  /projects/:id/issues`    — issues belonging to a single project.
 * - `GET  /projects/:id/events`    — raw events (newest first).
 * - `GET  /issues`          — top issues across every project.
 */
export const handler = (options: HandlerOptions = {}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectDO;
    const index = yield* IndexDO;

    const expectedSecret =
      options.webhookSecret ??
      (yield* readOptionalConfig("TRIAGE_WEBHOOK_SECRET"));

    const discordWebhookUrl =
      options.discordWebhookUrl ??
      (yield* readOptionalConfig("DISCORD_WEBHOOK_URL"));

    const discordFloor = options.discordSeverityFloor ?? 3;
    const unknownProjectId = options.unknownProjectId ?? "unknown";
    const model = options.model;

    const projectStub = (projectId: string) => projects.getByName(projectId);
    const indexStub = index.getByName(INDEX_DO_NAME);

    const postToDiscord = (issue: Issue, decision: TriageDecision) =>
      Effect.gen(function* () {
        if (!discordWebhookUrl) return;
        if (decision.severity < discordFloor) return;
        const payload = {
          username: "alchemy-triage",
          embeds: [
            {
              title: `[sev ${decision.severity}] ${decision.title}`,
              description: decision.summary,
              color: severityColor(decision.severity),
              fields: [
                {
                  name: "Project",
                  value: `\`${issue.projectId}\``,
                  inline: true,
                },
                {
                  name: "Occurrences",
                  value: String(issue.occurrences),
                  inline: true,
                },
                {
                  name: "Issue",
                  value: `\`${issue.id}\``,
                  inline: true,
                },
                ...(issue.axiomQuery
                  ? [
                      {
                        name: "Axiom",
                        value: `\`\`\`kql\n${issue.axiomQuery.slice(0, 800)}\n\`\`\``,
                        inline: false,
                      },
                    ]
                  : []),
              ],
            },
          ],
        };
        const res = yield* Effect.tryPromise({
          try: () =>
            fetch(`${discordWebhookUrl}?wait=true`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            }),
          catch: (cause) => new Error(`discord post failed: ${String(cause)}`),
        });
        if (!res.ok) return;
        const body = (yield* Effect.tryPromise({
          try: () => res.json() as Promise<{ id?: string }>,
          catch: () => new Error("discord parse failed"),
        }).pipe(Effect.orElseSucceed(() => ({}) as { id?: string })));
        if (body.id) {
          yield* projectStub(issue.projectId).setDiscordMessageId(
            issue.id,
            body.id,
          );
        }
      }).pipe(Effect.catch(() => Effect.void));

    const triageProjectBatch = (
      projectId: string,
      events: ReadonlyArray<RawEvent>,
    ) =>
      Effect.gen(function* () {
        const stub = projectStub(projectId);
        const result = yield* stub.recordBatch(events, { model });

        // Discord — fire-and-forget. Only ping on the first occurrence of
        // a fingerprint to avoid spam.
        for (const issue of result.issues) {
          if (issue.isNew) {
            yield* Effect.forkChild(
              postToDiscord(issue.issue, issue.decision),
            );
          }
        }

        return {
          projectId,
          eventCount: events.length,
          issues: result.issues.map((i: BatchedIssueResult) => ({
            fingerprint: i.fingerprint,
            isNew: i.isNew,
            severity: i.decision.severity,
            occurrences: i.issue.occurrences,
          })),
          summary: result.summary
            ? {
                resourcesSummary: result.summary.resourcesSummary,
                errorsSummary: result.summary.errorsSummary,
                generatedAt: result.summary.generatedAt,
              }
            : null,
        };
      });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(
          request.url,
          `https://${request.headers.host ?? "localhost"}`,
        );
        const path = url.pathname;
        const method = request.method;

        if (method === "POST" && path === "/webhooks/axiom") {
          const inner = Effect.gen(function* () {
            yield* requireAuth(expectedSecret);
            const text = yield* request.text;
            const body = parseWebhookPayload(text);
            if (body.events.length === 0) {
              return yield* HttpServerResponse.json(
                { ok: true, triaged: 0 },
                { status: 200 },
              );
            }
            // Group by projectId, then send each project's slice as one
            // batch. Each ProjectDO runs the AI summarizer once per batch
            // — bounding AI cost to O(distinct projects per webhook).
            const groups = groupByProject(body.events, unknownProjectId);
            const projectResults = yield* Effect.forEach(
              [...groups.entries()],
              ([projectId, events]) =>
                triageProjectBatch(projectId, events),
              { concurrency: 4 },
            );
            return yield* HttpServerResponse.json({
              ok: true,
              projects: projectResults.length,
              triaged: body.events.length,
              results: projectResults,
            });
          });
          return yield* Effect.catchTag(inner, "Unauthorized", () =>
            HttpServerResponse.json(
              { error: "unauthorized" },
              { status: 401 },
            ),
          );
        }

        // ------------------------------------------------------------------
        // /projects
        // ------------------------------------------------------------------

        if (method === "GET" && path === "/projects") {
          const limit = clampLimit(url.searchParams.get("limit"));
          const list = yield* indexStub.listProjects(limit);
          return yield* HttpServerResponse.json({ projects: list });
        }

        const projectMatch = path.match(
          /^\/projects\/([^/]+)(?:\/(summarize|issues|events))?$/,
        );
        if (projectMatch) {
          const [, projectId, sub] = projectMatch;
          const stub = projectStub(projectId!);

          if (method === "POST" && sub === "summarize") {
            const summary = yield* stub.summarizeNow(model);
            return summary
              ? yield* HttpServerResponse.json({ summary })
              : yield* HttpServerResponse.json(
                  { error: "no events yet" },
                  { status: 404 },
                );
          }

          if (method === "GET" && sub === "issues") {
            const status = url.searchParams.get("status") as
              | IssueStatus
              | null;
            const limit = clampLimit(url.searchParams.get("limit"));
            const issues = yield* stub.listIssues({
              status: status ?? undefined,
              limit,
            });
            return yield* HttpServerResponse.json({ issues });
          }

          if (method === "GET" && sub === "events") {
            const limit = clampLimit(url.searchParams.get("limit"), 100, 500);
            const events = yield* stub.listEvents(limit);
            return yield* HttpServerResponse.json({ events });
          }

          if (method === "GET" && !sub) {
            const [meta, summary] = yield* Effect.all([
              stub.getMeta(),
              stub.getSummary(),
            ]);
            if (!meta) {
              return yield* HttpServerResponse.json(
                { error: "not found" },
                { status: 404 },
              );
            }
            return yield* HttpServerResponse.json({
              project: meta,
              summary,
            });
          }
        }

        // ------------------------------------------------------------------
        // /issues — cross-project list (mirrored in IndexDO)
        // ------------------------------------------------------------------

        if (method === "GET" && path === "/issues") {
          const limit = clampLimit(url.searchParams.get("limit"));
          const issues = yield* indexStub.listIssues(limit);
          return yield* HttpServerResponse.json({ issues });
        }

        if (method === "GET" && path === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catch((error: any) =>
          Effect.succeed(
            HttpServerResponse.text(
              `Internal Server Error: ${error?.message ?? error?._tag ?? String(error)}`,
              { status: 500 },
            ),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.AILive), Effect.orDie);

const readOptionalConfig = (name: string) =>
  Effect.gen(function* () {
    const opt = yield* Config.string(name).pipe(Config.option);
    return opt._tag === "Some" ? opt.value : undefined;
  });

const clampLimit = (raw: string | null, def = 50, max = 200): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
};

const groupByProject = (
  events: ReadonlyArray<RawEvent>,
  fallbackProjectId: string,
): Map<string, RawEvent[]> => {
  const groups = new Map<string, RawEvent[]>();
  for (const raw of events) {
    const projectId = raw.projectId ?? fallbackProjectId;
    const event: RawEvent = raw.projectId ? raw : { ...raw, projectId };
    let bucket = groups.get(projectId);
    if (!bucket) {
      bucket = [];
      groups.set(projectId, bucket);
    }
    bucket.push(event);
  }
  return groups;
};

interface WebhookPayload {
  events: RawEvent[];
}

const parseWebhookPayload = (text: string): WebhookPayload => {
  if (!text) return { events: [] };
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { events: [] };
  }
  // Three accepted shapes:
  //   1. { events: [...] }
  //   2. Axiom Monitor MatchEvent: { matchedEvent, query, monitor }
  //   3. Axiom Monitor Threshold:  { aggregations: [...], query, monitor }
  if (Array.isArray(parsed?.events)) {
    return {
      events: parsed.events.map((e: any) => coerce(e, parsed.query)),
    };
  }
  if (parsed?.matchedEvent) {
    return {
      events: [coerce(parsed.matchedEvent, parsed.query)],
    };
  }
  if (Array.isArray(parsed?.aggregations)) {
    return {
      events: parsed.aggregations.map((row: any) =>
        coerce(
          {
            message:
              parsed.monitor?.name ??
              `aggregate over ${Object.keys(row).join(",")}`,
            attributes: row,
            ...row,
          },
          parsed.query,
        ),
      ),
    };
  }
  return { events: [coerce(parsed, parsed?.query)] };
};

const coerce = (raw: any, fallbackQuery?: string): RawEvent => {
  const resourceAttrs =
    (raw?.["resource.attributes"] as Record<string, unknown> | undefined) ??
    (raw?.resource?.attributes as Record<string, unknown> | undefined) ??
    undefined;

  const projectId = pickStr(
    raw?.projectId,
    raw?.project_id,
    raw?.["alchemy.git.root_commit"],
    resourceAttrs?.["alchemy.git.root_commit"],
    raw?.["alchemy.git.origin_hash"],
    resourceAttrs?.["alchemy.git.origin_hash"],
  );

  const userId = pickStr(
    raw?.userId,
    raw?.user_id,
    raw?.["alchemy.user.id"],
    resourceAttrs?.["alchemy.user.id"],
  );

  const gitOriginHash = pickStr(
    raw?.["alchemy.git.origin_hash"],
    resourceAttrs?.["alchemy.git.origin_hash"],
  );

  const gitBranchHash = pickStr(
    raw?.["alchemy.git.branch_hash"],
    resourceAttrs?.["alchemy.git.branch_hash"],
  );

  const alchemyVersion = pickStr(
    raw?.["alchemy.version"],
    resourceAttrs?.["alchemy.version"],
  );

  const attrs =
    (raw?.attributes as Record<string, unknown> | undefined) ?? undefined;

  return {
    timestamp:
      typeof raw?.timestamp === "number"
        ? raw.timestamp
        : raw?._time
          ? new Date(raw._time).getTime()
          : Date.now(),
    message:
      typeof raw?.message === "string"
        ? raw.message
        : (raw?.body ??
          raw?.name ??
          raw?.event ??
          JSON.stringify(raw ?? {}).slice(0, 500)),
    errorType: pickStr(
      raw?.errorType,
      raw?.["error.type"],
      raw?.type,
      attrs?.["exception.type"],
    ),
    service: pickStr(raw?.service, raw?.["service.name"]),
    location: pickStr(raw?.location, raw?.["code.filepath"]),
    resourceType: pickStr(
      raw?.resourceType,
      raw?.resource_type,
      attrs?.resource_type,
    ),
    resourceOp: pickStr(raw?.resourceOp, raw?.op, attrs?.op),
    status: pickStr(raw?.status, attrs?.status),
    projectId,
    userId,
    gitOriginHash,
    gitBranchHash,
    alchemyVersion,
    attributes: attrs,
    axiomQuery:
      typeof raw?.axiomQuery === "string" ? raw.axiomQuery : fallbackQuery,
  };
};

const pickStr = (...values: unknown[]): string | undefined => {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
};

const severityColor = (severity: number): number => {
  switch (severity) {
    case 5:
      return 0xb91c1c;
    case 4:
      return 0xea580c;
    case 3:
      return 0xeab308;
    case 2:
      return 0x3b82f6;
    default:
      return 0x6b7280;
  }
};

// Re-export for the type's `ProjectSummary` reference if a downstream caller
// imports the handler module without going through the package entry point.
export type { ProjectSummary };
