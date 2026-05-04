/**
 * Shared types for the triage worker.
 *
 * Everything that needs to cross the wire (Axiom webhook payloads, RPC
 * boundaries between the worker and its DOs, JSON responses) lives here.
 * No Cloudflare or Effect imports — pure data shapes only.
 */

export type IssueStatus =
  | "open"
  | "triaging"
  | "reproduced"
  | "fixing"
  | "closed";

/**
 * A normalized event coming in from Axiom (logs or traces). The handler
 * coerces every supported webhook shape into this before dispatch.
 *
 * `projectId` and `userId` are extracted from the OTLP `resource.attributes`
 * (`alchemy.git.root_commit`, `alchemy.user.id`) emitted by the alchemy CLI
 * — see `packages/alchemy/src/Telemetry/Attributes.ts`. When the caller
 * isn't in a git repo we fall back to `alchemy.git.origin_hash`.
 */
export interface RawEvent {
  /** ms since epoch. */
  timestamp: number;
  /** Free-form message. */
  message: string;
  /** Optional error type (e.g. `TypeError`, `RetryableHttpError`). */
  errorType?: string;
  /** Optional service name (`alchemy-cli`, …). */
  service?: string;
  /** Optional file:line where the error originated. */
  location?: string;
  /** Optional resource type (e.g. `Cloudflare.Worker`) for resource-op events. */
  resourceType?: string;
  /** Optional resource lifecycle op (`create`/`update`/`delete`/`read`). */
  resourceOp?: string;
  /** "success" | "error" — whether the operation succeeded. */
  status?: "success" | "error" | string;
  /** Project id — derived from telemetry resource attributes. */
  projectId?: string;
  /** User id — derived from `alchemy.user.id`. */
  userId?: string;
  /** Hashed git origin url. */
  gitOriginHash?: string;
  /** Hashed git branch name. */
  gitBranchHash?: string;
  /** alchemy CLI version that emitted the event. */
  alchemyVersion?: string;
  /** Optional extra attributes — included in the AI prompt. */
  attributes?: Record<string, unknown>;
  /** APL query that surfaced this event, for breadcrumb display. */
  axiomQuery?: string;
}

/**
 * Triage decision for a single error event.
 */
export interface TriageDecision {
  title: string;
  summary: string;
  /** 1 (low) .. 5 (critical). */
  severity: number;
}

/**
 * Per-project issue. Keyed by `fingerprint` inside the owning ProjectDO.
 */
export interface Issue {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  severity: number;
  status: IssueStatus;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
  axiomQuery: string | null;
  sampleEvent: unknown;
  prUrl: string | null;
  discordMessageId: string | null;
}

/**
 * Per-project metadata. Mirrors the OTLP resource attributes the alchemy
 * CLI sends with every signal. Stored at `meta` in the ProjectDO.
 */
export interface ProjectMeta {
  projectId: string;
  userId: string | null;
  gitOriginHash: string | null;
  gitBranchHash: string | null;
  alchemyVersion: string | null;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  errorCount: number;
  resourceOpCount: number;
  /** Last time we ran the AI summarizer for this project. */
  lastAnalyzed: number | null;
  /** True when new events have arrived since the last analyze. */
  dirty: boolean;
}

/**
 * AI-generated summary of what a project is doing. Stored at
 * `summary:current` and `summary:<ts>` (history).
 */
export interface ProjectSummary {
  projectId: string;
  /** "What are they trying to build?" */
  resourcesSummary: string;
  /** "What errors are they running into?" */
  errorsSummary: string;
  /** Top resource types touched, ordered by count desc. */
  topResources: ReadonlyArray<{ type: string; count: number }>;
  /** Top error types observed, ordered by count desc. */
  topErrors: ReadonlyArray<{
    type: string;
    count: number;
    sample?: string;
  }>;
  /** Roll-up totals captured at the time the summary was generated. */
  resourceOpCount: number;
  errorCount: number;
  eventCount: number;
  /** Workers AI model used. */
  model: string;
  generatedAt: number;
}

/**
 * Compact view of a project for the cross-project listing endpoint.
 */
export interface ProjectListEntry {
  projectId: string;
  userId: string | null;
  gitOriginHash: string | null;
  alchemyVersion: string | null;
  eventCount: number;
  errorCount: number;
  lastSeen: number;
  hasSummary: boolean;
}
