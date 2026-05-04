import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import IndexDO, { INDEX_DO_NAME } from "./IndexDO.ts";
import {
  eventKey,
  fingerprint,
  issueIndexKey,
  reverseTs,
} from "./Fingerprint.ts";
import { classifyEvent, summarizeProject, DEFAULT_MODEL } from "./Triage.ts";
import type {
  Issue,
  IssueStatus,
  ProjectMeta,
  ProjectListEntry,
  ProjectSummary,
  RawEvent,
  TriageDecision,
} from "./Types.ts";

/**
 * One Durable Object per alchemy project (`alchemy.git.root_commit`). Holds
 * the entire history for that project — raw events, rolling counters, the
 * per-project issue catalog, and the latest AI summary.
 *
 * Data flow is strictly left-to-right:
 *
 * ```text
 *   handler ──recordBatch──▶ ProjectDO ──pushToIndex──▶ IndexDO
 * ```
 *
 * Per batch (`recordBatch`):
 *   1. Append every raw event to the event log.
 *   2. Bump per-resource and per-error counters.
 *   3. Classify each error (Workers AI) and upsert an Issue per fingerprint.
 *   4. Re-run the project summarizer (Workers AI) over the fresh counters.
 *   5. Push `(project meta, issues)` into the IndexDO so cross-project
 *      listings stay current. The push happens from inside the DO — the
 *      handler never talks to IndexDO directly.
 *
 * Storage layout (all KV, no SQL):
 *
 * ```text
 * meta                           → ProjectMeta
 *
 * event:<reverseTs>:<rand>       → RawEvent     (forever, ordered newest→oldest)
 *
 * count:resource:_total          → number
 * count:resource:<resource_type> → number
 * count:error:_total             → number
 * count:error:<errorType>        → number
 * sample:error:<errorType>       → string       (latest message for that type)
 *
 * issue:<fingerprint>            → Issue
 * issue_idx:<sevDesc>:<reverseLastSeen>:<fingerprint> → ""
 *
 * summary:current                → ProjectSummary
 * summary:<reverseTs>            → ProjectSummary  (history)
 * ```
 */

/** How many recent events to feed into the summarizer prompt. */
const SUMMARIZE_RECENT_EVENTS = 25;

const MAX_RESOURCE_TOPN = 20;
const MAX_ERROR_TOPN = 20;

export interface RecordBatchOptions {
  /** Workers AI model used for both classification and summarization. */
  model?: string;
  /** Skip running the summarizer at the end of the batch. Default: false. */
  skipSummarize?: boolean;
}

export interface BatchedIssueResult {
  fingerprint: string;
  decision: TriageDecision;
  issue: Issue;
  /** True when this is the first time we've seen this fingerprint. */
  isNew: boolean;
}

export interface RecordBatchResult {
  meta: ProjectMeta;
  issues: ReadonlyArray<BatchedIssueResult>;
  summary: ProjectSummary | null;
}

export default class ProjectDO extends Cloudflare.DurableObjectNamespace<ProjectDO>()(
  "ProjectDO",
  Effect.gen(function* () {
    // Outer scope: bind shared services that all DO instances reuse.
    const ai = yield* Cloudflare.AI.bind();
    const indexNs = yield* IndexDO;

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const storage = state.storage;
      const indexStub = indexNs.getByName(INDEX_DO_NAME);

      const getMeta = Effect.gen(function* () {
        return yield* storage.get<ProjectMeta>("meta");
      });

      const putMeta = (meta: ProjectMeta) => storage.put("meta", meta);

      const incrCounter = (key: string, by = 1) =>
        Effect.gen(function* () {
          const current = (yield* storage.get<number>(key)) ?? 0;
          yield* storage.put(key, current + by);
          return current + by;
        });

      const ensureMeta = (event: RawEvent): Effect.Effect<ProjectMeta> =>
        Effect.gen(function* () {
          const existing = yield* getMeta;
          if (existing) return existing;
          const fresh: ProjectMeta = {
            projectId: event.projectId ?? "unknown",
            userId: event.userId ?? null,
            gitOriginHash: event.gitOriginHash ?? null,
            gitBranchHash: event.gitBranchHash ?? null,
            alchemyVersion: event.alchemyVersion ?? null,
            firstSeen: event.timestamp,
            lastSeen: event.timestamp,
            eventCount: 0,
            errorCount: 0,
            resourceOpCount: 0,
            lastAnalyzed: null,
            dirty: false,
          };
          yield* putMeta(fresh);
          return fresh;
        });

      const recordRaw = (event: RawEvent) =>
        Effect.gen(function* () {
          // Adequate for tie-breaking inside a 1ms bucket; not crypto.
          const tieBreak = Math.random().toString(36).slice(2, 10);
          yield* storage.put(eventKey(event.timestamp, tieBreak), event);
        });

      const recordResourceCounts = (event: RawEvent) =>
        Effect.gen(function* () {
          if (!event.resourceType) return;
          yield* incrCounter("count:resource:_total");
          yield* incrCounter(`count:resource:${event.resourceType}`);
        });

      const isErrorEvent = (event: RawEvent): boolean =>
        event.status === "error" ||
        !!event.errorType ||
        /\b(error|fail|panic|exception)\b/i.test(event.message);

      const recordErrorCounts = (event: RawEvent) =>
        Effect.gen(function* () {
          if (!isErrorEvent(event)) return false;
          const type = event.errorType ?? "Error";
          yield* incrCounter("count:error:_total");
          yield* incrCounter(`count:error:${type}`);
          yield* storage.put(
            `sample:error:${type}`,
            truncate(event.message, 240),
          );
          return true;
        });

      const upsertIssue = (
        event: RawEvent,
        decision: TriageDecision,
      ): Effect.Effect<{ issue: Issue; isNew: boolean }> =>
        Effect.gen(function* () {
          const id = fingerprint([
            event.errorType ?? "",
            event.location ?? "",
            event.service ?? "",
            event.message,
          ]);
          const now = event.timestamp || Date.now();
          const projectId =
            event.projectId ?? (yield* getMeta)?.projectId ?? "unknown";
          const existing = yield* storage.get<Issue>(`issue:${id}`);
          const issue: Issue = existing
            ? {
                ...existing,
                lastSeen: now,
                occurrences: existing.occurrences + 1,
                severity: Math.max(existing.severity, decision.severity),
                summary: decision.summary,
                sampleEvent: sampleEventOf(event),
                axiomQuery: event.axiomQuery ?? existing.axiomQuery,
              }
            : {
                id,
                projectId,
                title: decision.title,
                summary: decision.summary,
                severity: decision.severity,
                status: "open",
                occurrences: 1,
                firstSeen: now,
                lastSeen: now,
                axiomQuery: event.axiomQuery ?? null,
                sampleEvent: sampleEventOf(event),
                prUrl: null,
                discordMessageId: null,
              };
          if (existing) {
            yield* storage.delete(
              issueIndexKey(existing.severity, existing.lastSeen, id),
            );
          }
          yield* storage.put({
            [`issue:${id}`]: issue,
            [issueIndexKey(issue.severity, issue.lastSeen, id)]: "",
          } as Record<string, unknown>);
          return { issue, isNew: !existing };
        });

      const recordOne = (event: RawEvent, model: string | undefined) =>
        Effect.gen(function* () {
          const meta = yield* ensureMeta(event);
          yield* recordRaw(event);
          yield* recordResourceCounts(event);
          const wasError = yield* recordErrorCounts(event);
          const decision = wasError
            ? yield* classifyEvent(ai, event, model)
            : decisionFromEvent(event);
          const { issue, isNew } = yield* upsertIssue(event, decision);
          const updatedMeta: ProjectMeta = {
            ...meta,
            lastSeen: Math.max(meta.lastSeen, event.timestamp),
            firstSeen: Math.min(meta.firstSeen, event.timestamp),
            eventCount: meta.eventCount + 1,
            errorCount: meta.errorCount + (wasError ? 1 : 0),
            resourceOpCount:
              meta.resourceOpCount + (event.resourceType ? 1 : 0),
            userId: meta.userId ?? event.userId ?? null,
            gitOriginHash: meta.gitOriginHash ?? event.gitOriginHash ?? null,
            gitBranchHash: meta.gitBranchHash ?? event.gitBranchHash ?? null,
            alchemyVersion:
              meta.alchemyVersion ?? event.alchemyVersion ?? null,
            dirty: true,
          };
          yield* putMeta(updatedMeta);
          return {
            fingerprint: issue.id,
            decision,
            issue,
            isNew,
          } satisfies BatchedIssueResult;
        });

      // -------------------------------------------------------------------
      // pushToIndex — runs at the tail of every batch. Sends the project's
      // meta + the full top-issue list to IndexDO so the aggregator's view
      // is always derived from this DO's view.
      // -------------------------------------------------------------------

      const pushToIndex = (
        meta: ProjectMeta,
        topIssues: ReadonlyArray<Issue>,
        summary: ProjectSummary | null,
      ) =>
        Effect.gen(function* () {
          const entry: ProjectListEntry = {
            projectId: meta.projectId,
            userId: meta.userId,
            gitOriginHash: meta.gitOriginHash,
            alchemyVersion: meta.alchemyVersion,
            eventCount: meta.eventCount,
            errorCount: meta.errorCount,
            lastSeen: meta.lastSeen,
            hasSummary: summary != null || meta.lastAnalyzed != null,
          };
          yield* indexStub.recordProject(entry);
          for (const issue of topIssues) {
            yield* indexStub.recordIssue({
              projectId: issue.projectId,
              fingerprint: issue.id,
              title: issue.title,
              severity: issue.severity,
              status: issue.status,
              occurrences: issue.occurrences,
              lastSeen: issue.lastSeen,
            });
          }
        }).pipe(Effect.catch(() => Effect.void));

      const readTopIssues = (limit: number) =>
        Effect.gen(function* () {
          const ids = yield* storage.list<string>({
            prefix: "issue_idx:",
            limit,
          });
          const issues: Issue[] = [];
          for (const key of ids.keys()) {
            const fp = key.split(":").pop();
            if (!fp) continue;
            const issue = yield* storage.get<Issue>(`issue:${fp}`);
            if (issue) issues.push(issue);
          }
          return issues;
        });

      // -------------------------------------------------------------------
      // public RPC
      // -------------------------------------------------------------------

      return {
        /**
         * Process a batch of events for this project: write them, refresh
         * the AI summary, and push the result to IndexDO. This is the only
         * write entry point — the handler always calls this, never the
         * single-event variant.
         */
        recordBatch: (
          events: ReadonlyArray<RawEvent>,
          options: RecordBatchOptions = {},
        ): Effect.Effect<RecordBatchResult, never, Cloudflare.WorkerEnvironment> =>
          Effect.gen(function* () {
            const issues: BatchedIssueResult[] = [];
            for (const event of events) {
              issues.push(yield* recordOne(event, options.model));
            }
            const summary = options.skipSummarize
              ? null
              : yield* runSummarize(ai, storage, options.model ?? DEFAULT_MODEL);
            const meta = (yield* getMeta) ?? null;
            if (meta) {
              const topIssues = yield* readTopIssues(50);
              yield* pushToIndex(meta, topIssues, summary);
            }
            return {
              meta: meta!,
              issues,
              summary,
            };
          }),

        getMeta: () => getMeta,

        /** Force-run the summarizer now (also pushes to IndexDO). */
        summarizeNow: (model: string = DEFAULT_MODEL) =>
          Effect.gen(function* () {
            const summary = yield* runSummarize(ai, storage, model);
            const meta = yield* getMeta;
            if (meta) {
              const topIssues = yield* readTopIssues(50);
              yield* pushToIndex(meta, topIssues, summary);
            }
            return summary;
          }),

        getSummary: () =>
          Effect.gen(function* () {
            return yield* storage.get<ProjectSummary>("summary:current");
          }),

        listIssues: (options: { status?: IssueStatus; limit?: number } = {}) =>
          Effect.gen(function* () {
            const limit = options.limit ?? 50;
            const ids = yield* storage.list<string>({
              prefix: "issue_idx:",
              limit: limit * 2,
            });
            const issues: Issue[] = [];
            for (const key of ids.keys()) {
              const fp = key.split(":").pop();
              if (!fp) continue;
              const issue = yield* storage.get<Issue>(`issue:${fp}`);
              if (!issue) continue;
              if (options.status && issue.status !== options.status) continue;
              issues.push(issue);
              if (issues.length >= limit) break;
            }
            return issues;
          }),

        getIssue: (id: string) =>
          Effect.gen(function* () {
            return yield* storage.get<Issue>(`issue:${id}`);
          }),

        setIssueStatus: (
          id: string,
          status: IssueStatus,
          prUrl?: string,
        ) =>
          Effect.gen(function* () {
            const issue = yield* storage.get<Issue>(`issue:${id}`);
            if (!issue) return null;
            const next: Issue = {
              ...issue,
              status,
              prUrl: prUrl ?? issue.prUrl,
            };
            yield* storage.put(`issue:${id}`, next);
            return next;
          }),

        setDiscordMessageId: (id: string, messageId: string) =>
          Effect.gen(function* () {
            const issue = yield* storage.get<Issue>(`issue:${id}`);
            if (!issue) return null;
            const next: Issue = { ...issue, discordMessageId: messageId };
            yield* storage.put(`issue:${id}`, next);
            return next;
          }),

        listEvents: (limit = 100) =>
          Effect.gen(function* () {
            const entries = yield* storage.list<RawEvent>({
              prefix: "event:",
              limit,
            });
            return [...entries.values()];
          }),
      };
    });
  }),
) {}

// ---------------------------------------------------------------------------
// helpers (kept outside the class so the closure stays small)
// ---------------------------------------------------------------------------

const runSummarize = (
  ai: Cloudflare.AIClient,
  storage: Cloudflare.DurableObjectStorage,
  model: string,
) =>
  Effect.gen(function* () {
    const meta = yield* storage.get<ProjectMeta>("meta");
    if (!meta) return null;

    const [topResources, topErrors, recentEvents] = yield* Effect.all([
      readTopResources(storage),
      readTopErrors(storage),
      readRecentEvents(storage, SUMMARIZE_RECENT_EVENTS),
    ]);

    const decision = yield* summarizeProject(
      ai,
      {
        meta,
        topResources,
        topErrors,
        recentEvents,
      },
      model,
    );

    const summary: ProjectSummary = {
      projectId: meta.projectId,
      resourcesSummary: decision.resourcesSummary,
      errorsSummary: decision.errorsSummary,
      topResources,
      topErrors,
      resourceOpCount: meta.resourceOpCount,
      errorCount: meta.errorCount,
      eventCount: meta.eventCount,
      model,
      generatedAt: Date.now(),
    };

    yield* storage.put({
      "summary:current": summary,
      [`summary:${reverseTs(summary.generatedAt)}`]: summary,
      meta: { ...meta, dirty: false, lastAnalyzed: summary.generatedAt },
    } as Record<string, unknown>);

    return summary;
  });

const readTopResources = (storage: Cloudflare.DurableObjectStorage) =>
  Effect.gen(function* () {
    const entries = yield* storage.list<number>({
      prefix: "count:resource:",
    });
    const tallies: Array<{ type: string; count: number }> = [];
    for (const [key, count] of entries.entries()) {
      const type = key.slice("count:resource:".length);
      if (type === "_total") continue;
      tallies.push({ type, count });
    }
    tallies.sort((a, b) => b.count - a.count);
    return tallies.slice(0, MAX_RESOURCE_TOPN);
  });

const readTopErrors = (storage: Cloudflare.DurableObjectStorage) =>
  Effect.gen(function* () {
    const entries = yield* storage.list<number>({ prefix: "count:error:" });
    const tallies: Array<{ type: string; count: number; sample?: string }> = [];
    for (const [key, count] of entries.entries()) {
      const type = key.slice("count:error:".length);
      if (type === "_total") continue;
      tallies.push({ type, count });
    }
    tallies.sort((a, b) => b.count - a.count);
    const trimmed = tallies.slice(0, MAX_ERROR_TOPN);
    for (const t of trimmed) {
      const sample = yield* storage.get<string>(`sample:error:${t.type}`);
      if (sample) t.sample = sample;
    }
    return trimmed;
  });

const readRecentEvents = (
  storage: Cloudflare.DurableObjectStorage,
  limit: number,
) =>
  Effect.gen(function* () {
    const entries = yield* storage.list<RawEvent>({
      prefix: "event:",
      limit,
    });
    return [...entries.values()];
  });

const decisionFromEvent = (event: RawEvent): TriageDecision => ({
  title: `${event.resourceType ?? "event"} ${event.resourceOp ?? ""}`.trim(),
  summary: event.message,
  severity: 1,
});

const sampleEventOf = (event: RawEvent) => ({
  message: event.message,
  errorType: event.errorType,
  service: event.service,
  location: event.location,
  attributes: event.attributes,
  resourceType: event.resourceType,
  resourceOp: event.resourceOp,
  status: event.status,
});

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;
