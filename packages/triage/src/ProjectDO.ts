import * as Cloudflare from "alchemy/Cloudflare";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
  ProjectSummary,
  RawEvent,
  TriageDecision,
} from "./Types.ts";

/**
 * One Durable Object per alchemy project (`alchemy.git.root_commit`). Holds
 * the entire history for that project — raw events, rolling counters, the
 * per-project issue catalog, and the latest AI summary.
 *
 * Storage layout (all KV, no SQL — see comment in handler.ts for rationale):
 *
 * ```text
 * meta                           → ProjectMeta
 * dirty                          → 1 (set on every event, cleared on summarize)
 *
 * event:<reverseTs>:<rand>       → RawEvent     (forever, ordered newest→oldest)
 *
 * count:resource:_total          → number       (sum of all resource ops)
 * count:resource:<resource_type> → number
 * count:error:_total             → number
 * count:error:<errorType>        → number       (also stores `__sample__:msg`)
 * sample:error:<errorType>       → string       (latest message for the type)
 *
 * issue:<fingerprint>            → Issue
 * issue_idx:<sevDesc>:<reverseLastSeen>:<fingerprint> → ""
 *
 * summary:current                → ProjectSummary
 * summary:<reverseTs>            → ProjectSummary  (history)
 * ```
 *
 * The DO sets a 5-minute alarm whenever `dirty` flips on. The alarm runs
 * the AI summarizer and clears the flag. This batches AI calls so a burst
 * of 1000 events still costs 1 summary, not 1000.
 */

/** How long after a write to wait before re-running the AI summarizer. */
const SUMMARY_ALARM_MS = Duration.toMillis(Duration.minutes(5));

/** How many recent events to read into the summarizer prompt. */
const SUMMARIZE_RECENT_EVENTS = 25;

const MIN_RESOURCE_TOPN = 20;
const MIN_ERROR_TOPN = 20;

/**
 * Per-call options. The model can be overridden at the call site so the
 * stack can mix a cheap classifier with a beefier summarizer if it wants.
 */
export interface RecordEventOptions {
  /** Model used for classification. */
  classifyModel?: string;
  /** Skip Discord notification for this issue (handler decides). */
  suppressDiscord?: boolean;
}

export interface RecordEventResult {
  fingerprint: string;
  decision: TriageDecision;
  issue: Issue;
  /** True when this is the first time we've seen this fingerprint. */
  isNew: boolean;
}

export default class ProjectDO extends Cloudflare.DurableObjectNamespace<ProjectDO>()(
  "ProjectDO",
  Effect.gen(function* () {
    // Outer scope: bind shared services that all instances reuse.
    const ai = yield* Cloudflare.AI.bind();

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const storage = state.storage;

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

      const armSummarizer = Effect.gen(function* () {
        const existing = yield* storage.getAlarm();
        if (existing != null) return;
        yield* storage.setAlarm(Date.now() + SUMMARY_ALARM_MS);
      });

      const recordRaw = (event: RawEvent) =>
        Effect.gen(function* () {
          const tieBreak =
            // Adequate for tie-breaking inside a 1ms bucket; not crypto.
            Math.random().toString(36).slice(2, 10);
          yield* storage.put(eventKey(event.timestamp, tieBreak), event);
        });

      const recordResourceCounts = (event: RawEvent) =>
        Effect.gen(function* () {
          if (!event.resourceType) return;
          yield* incrCounter("count:resource:_total");
          yield* incrCounter(`count:resource:${event.resourceType}`);
        });

      const recordErrorCounts = (event: RawEvent) =>
        Effect.gen(function* () {
          const isError =
            event.status === "error" ||
            !!event.errorType ||
            /\b(error|fail|panic|exception)\b/i.test(event.message);
          if (!isError) return false;
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
          // Replace the secondary index entry on every update so the most
          // recent activity surfaces to the top of the list.
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

      // -------------------------------------------------------------------
      // public RPC
      // -------------------------------------------------------------------

      return {
        recordEvent: (
          event: RawEvent,
          options: RecordEventOptions = {},
        ): Effect.Effect<RecordEventResult, never, Cloudflare.WorkerEnvironment> =>
          Effect.gen(function* () {
            const meta = yield* ensureMeta(event);
            yield* recordRaw(event);
            yield* recordResourceCounts(event);
            const wasError = yield* recordErrorCounts(event);
            const decision = wasError
              ? yield* classifyEvent(ai, event, options.classifyModel)
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
              dirty: true,
              userId: meta.userId ?? event.userId ?? null,
              gitOriginHash:
                meta.gitOriginHash ?? event.gitOriginHash ?? null,
              gitBranchHash:
                meta.gitBranchHash ?? event.gitBranchHash ?? null,
              alchemyVersion:
                meta.alchemyVersion ?? event.alchemyVersion ?? null,
            };
            yield* putMeta(updatedMeta);
            yield* armSummarizer;
            return {
              fingerprint: issue.id,
              decision,
              issue,
              isNew,
            };
          }),

        getMeta: () => getMeta,

        /** Force-run the summarizer now and return the result. */
        summarizeNow: (model: string = DEFAULT_MODEL) =>
          runSummarize(ai, storage, model),

        getSummary: () =>
          Effect.gen(function* () {
            return yield* storage.get<ProjectSummary>("summary:current");
          }),

        listIssues: (options: { status?: IssueStatus; limit?: number } = {}) =>
          Effect.gen(function* () {
            const limit = options.limit ?? 50;
            const ids = yield* storage.list<string>({
              prefix: "issue_idx:",
              limit: limit * 2, // overscan in case of status filter
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

        /** Read raw events newest-first. */
        listEvents: (limit = 100) =>
          Effect.gen(function* () {
            const entries = yield* storage.list<RawEvent>({
              prefix: "event:",
              limit,
            });
            return [...entries.values()];
          }),

        // alarm — Cloudflare runtime hook. Effect-shaped.
        alarm: () =>
          Effect.gen(function* () {
            const meta = yield* getMeta;
            if (!meta?.dirty) return;
            yield* runSummarize(ai, storage, DEFAULT_MODEL);
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
    return tallies.slice(0, MIN_RESOURCE_TOPN);
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
    const trimmed = tallies.slice(0, MIN_ERROR_TOPN);
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
