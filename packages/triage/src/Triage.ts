import * as Effect from "effect/Effect";
import type { AIClient, WorkerEnvironment } from "alchemy/Cloudflare";
import type { ProjectMeta, RawEvent, TriageDecision } from "./Types.ts";

/**
 * Default Workers AI model used for triage. Cheap, fast, good enough at
 * 70B for short JSON outputs. Override at the call site if you want more.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/
 */
export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

interface AIChatResponse {
  response?: string;
  result?: { response?: string };
}

// ---------------------------------------------------------------------------
// classifyEvent — used on every error event for fingerprint-based dedup.
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM_PROMPT = `You are an SRE triage assistant. Given one error event from production telemetry, produce a short JSON object describing the underlying issue.

Rules:
- "title" must be <= 80 characters and identify the bug, not the symptom.
- "summary" is 1-2 sentences explaining what likely happened and why it matters.
- "severity" is an integer 1..5: 1 = informational, 3 = user-facing bug, 5 = data loss / outage.
- Output ONLY the JSON object, no prose, no markdown.`;

const buildClassifyPrompt = (event: RawEvent): string => {
  const attrs = event.attributes
    ? `\nAttributes: ${JSON.stringify(event.attributes)}`
    : "";
  return [
    event.service ? `Service: ${event.service}` : "",
    event.errorType ? `Error type: ${event.errorType}` : "",
    event.location ? `Location: ${event.location}` : "",
    event.projectId ? `Project: ${event.projectId}` : "",
    `Message: ${event.message}`,
    attrs,
  ]
    .filter(Boolean)
    .join("\n");
};

/**
 * Ask Workers AI to classify an event and return a {@link TriageDecision}.
 * On model failure or invalid JSON we fall back to a deterministic decision
 * so the worker still produces a triaged issue (better degraded than dropped).
 */
export const classifyEvent = (
  ai: AIClient,
  event: RawEvent,
  model: string = DEFAULT_MODEL,
): Effect.Effect<TriageDecision, never, WorkerEnvironment> =>
  ai
    .run<AIChatResponse>(model, {
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
        { role: "user", content: buildClassifyPrompt(event) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 256,
    })
    .pipe(
      Effect.map((res) => {
        const raw = res.response ?? res.result?.response ?? "";
        return parseDecision(raw, event);
      }),
      Effect.catch(() => Effect.succeed(fallbackDecision(event))),
    );

const parseDecision = (raw: string, event: RawEvent): TriageDecision => {
  const trimmed = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "");
  try {
    const parsed = JSON.parse(trimmed) as Partial<TriageDecision>;
    const severity =
      typeof parsed.severity === "number" && parsed.severity >= 1
        ? Math.min(5, Math.max(1, Math.round(parsed.severity)))
        : 3;
    return {
      title:
        (parsed.title ?? "").toString().slice(0, 80) || fallbackTitle(event),
      summary: (parsed.summary ?? "").toString() || event.message,
      severity,
    };
  } catch {
    return fallbackDecision(event);
  }
};

const fallbackTitle = (event: RawEvent) =>
  `${event.errorType ?? "Error"}: ${event.message.slice(0, 60)}`;

const fallbackDecision = (event: RawEvent): TriageDecision => ({
  title: fallbackTitle(event),
  summary: event.message,
  severity: 3,
});

// ---------------------------------------------------------------------------
// summarizeProject — runs periodically (per ProjectDO alarm) over the rolled-
// up counters + a window of recent events to answer:
//   1. What resources is this project using? (what are they trying to build)
//   2. What errors are they running into?
// ---------------------------------------------------------------------------

const SUMMARIZE_SYSTEM_PROMPT = `You are an SRE assistant analyzing a single user's alchemy project from anonymized telemetry. Produce a short JSON object describing what the project is doing.

Rules:
- "resourcesSummary" is 2-4 sentences answering "what is this user trying to build?". Mention the cloud (Cloudflare/AWS), the most-used resource types (e.g. Worker, D1, R2, KV, Queue, Lambda, S3), and any notable patterns (multi-stage, websites, jobs, durable objects, etc.). Don't speculate beyond the data.
- "errorsSummary" is 2-4 sentences answering "what errors are they running into?". Group by error type, mention which resource types are affected, and call out any error that recurs more than once. If there are no errors, say so explicitly.
- Output ONLY the JSON object, no prose, no markdown. Both fields are strings.`;

interface ResourceTally {
  type: string;
  count: number;
}

interface ErrorTally {
  type: string;
  count: number;
  sample?: string;
}

interface SummarizeInput {
  meta: Pick<
    ProjectMeta,
    | "projectId"
    | "alchemyVersion"
    | "eventCount"
    | "errorCount"
    | "resourceOpCount"
    | "firstSeen"
    | "lastSeen"
  >;
  topResources: ReadonlyArray<ResourceTally>;
  topErrors: ReadonlyArray<ErrorTally>;
  /**
   * Up to ~25 recent events. Used as flavor text — the LLM should ground
   * its answer in `topResources` / `topErrors`, not in any single event.
   */
  recentEvents: ReadonlyArray<RawEvent>;
}

const buildSummarizePrompt = (input: SummarizeInput): string => {
  const lines: string[] = [];
  lines.push(`Project id: ${input.meta.projectId}`);
  if (input.meta.alchemyVersion) {
    lines.push(`Alchemy version: ${input.meta.alchemyVersion}`);
  }
  lines.push(
    `Activity window: ${new Date(input.meta.firstSeen).toISOString()} → ${new Date(input.meta.lastSeen).toISOString()}`,
  );
  lines.push(
    `Totals: ${input.meta.resourceOpCount} resource ops, ${input.meta.errorCount} errors, ${input.meta.eventCount} events.`,
  );
  lines.push("");
  lines.push("Top resource types (sum of ops, success+error):");
  if (input.topResources.length === 0) {
    lines.push("  (none recorded)");
  } else {
    for (const r of input.topResources.slice(0, 20)) {
      lines.push(`  - ${r.type}: ${r.count}`);
    }
  }
  lines.push("");
  lines.push("Top error types:");
  if (input.topErrors.length === 0) {
    lines.push("  (none observed)");
  } else {
    for (const e of input.topErrors.slice(0, 20)) {
      const sample = e.sample ? ` — example: ${truncate(e.sample, 160)}` : "";
      lines.push(`  - ${e.type}: ${e.count}${sample}`);
    }
  }
  if (input.recentEvents.length > 0) {
    lines.push("");
    lines.push("Recent events (most recent first, sample):");
    for (const ev of input.recentEvents.slice(0, 25)) {
      const head = [
        ev.errorType,
        ev.resourceType ? `${ev.resourceType}.${ev.resourceOp ?? "op"}` : null,
        ev.status,
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(`  - [${head || "event"}] ${truncate(ev.message, 200)}`);
    }
  }
  return lines.join("\n");
};

/**
 * Result of {@link summarizeProject}. Two free-form strings the AI produced
 * plus the inputs we passed in (so the caller can persist the rollups
 * alongside the prose).
 */
export interface ProjectSummaryDecision {
  resourcesSummary: string;
  errorsSummary: string;
}

/**
 * Ask Workers AI to produce per-project summaries from pre-computed
 * rollups. On failure we synthesize a deterministic summary from the
 * counters so a project always has _some_ summary.
 */
export const summarizeProject = (
  ai: AIClient,
  input: SummarizeInput,
  model: string = DEFAULT_MODEL,
): Effect.Effect<ProjectSummaryDecision, never, WorkerEnvironment> =>
  ai
    .run<AIChatResponse>(model, {
      messages: [
        { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
        { role: "user", content: buildSummarizePrompt(input) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 512,
    })
    .pipe(
      Effect.map((res) => {
        const raw = res.response ?? res.result?.response ?? "";
        return parseSummary(raw, input);
      }),
      Effect.catch(() => Effect.succeed(fallbackSummary(input))),
    );

const parseSummary = (
  raw: string,
  input: SummarizeInput,
): ProjectSummaryDecision => {
  const trimmed = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "");
  try {
    const parsed = JSON.parse(trimmed) as Partial<ProjectSummaryDecision>;
    return {
      resourcesSummary:
        (parsed.resourcesSummary ?? "").toString() ||
        fallbackSummary(input).resourcesSummary,
      errorsSummary:
        (parsed.errorsSummary ?? "").toString() ||
        fallbackSummary(input).errorsSummary,
    };
  } catch {
    return fallbackSummary(input);
  }
};

const fallbackSummary = (input: SummarizeInput): ProjectSummaryDecision => {
  const resourceLine =
    input.topResources.length === 0
      ? "No resource operations recorded yet for this project."
      : `Project has executed ${input.meta.resourceOpCount} resource operations across ${input.topResources.length} resource types. Most active: ${input.topResources
          .slice(0, 3)
          .map((r) => `${r.type} (${r.count})`)
          .join(", ")}.`;
  const errorLine =
    input.topErrors.length === 0
      ? "No errors observed for this project."
      : `Observed ${input.meta.errorCount} errors across ${input.topErrors.length} error types. Most frequent: ${input.topErrors
          .slice(0, 3)
          .map((e) => `${e.type} (${e.count})`)
          .join(", ")}.`;
  return { resourcesSummary: resourceLine, errorsSummary: errorLine };
};

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;
