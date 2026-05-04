import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { issueIndexKey, reverseTs } from "./Fingerprint.ts";
import type { ProjectListEntry } from "./Types.ts";

/**
 * A single Durable Object that holds **cross-project** lookups so we don't
 * have to fan out to every ProjectDO on every list call. There is exactly
 * one instance, addressed by the well-known name {@link INDEX_DO_NAME}.
 *
 * Storage layout:
 *
 * ```text
 * project:<projectId>                                → ProjectListEntry
 * project_idx:<reverseLastSeen>:<projectId>         → ""                (sort)
 *
 * issue:<projectId>:<fingerprint>                    → IssueIndexEntry
 * issue_idx:<sevDesc>:<reverseLastSeen>:<projectId>:<fingerprint> → ""
 * ```
 *
 * Reads here are eventually consistent with the per-project state — they
 * exist to power the Discord slash command and the `GET /projects` /
 * `GET /issues` listing endpoints. The source of truth always remains
 * the owning ProjectDO.
 */
export const INDEX_DO_NAME = "global";

export interface IssueIndexEntry {
  projectId: string;
  fingerprint: string;
  title: string;
  severity: number;
  status: string;
  occurrences: number;
  lastSeen: number;
}

const PROJECT_LIST_LIMIT = 200;
const ISSUE_LIST_LIMIT = 100;

export default class IndexDO extends Cloudflare.DurableObjectNamespace<IndexDO>()(
  "IndexDO",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const storage = state.storage;

      const upsertProject = (entry: ProjectListEntry) =>
        Effect.gen(function* () {
          const existing = yield* storage.get<ProjectListEntry>(
            `project:${entry.projectId}`,
          );
          if (existing) {
            yield* storage.delete(
              `project_idx:${reverseTs(existing.lastSeen)}:${entry.projectId}`,
            );
          }
          yield* storage.put({
            [`project:${entry.projectId}`]: entry,
            [`project_idx:${reverseTs(entry.lastSeen)}:${entry.projectId}`]: "",
          } as Record<string, unknown>);
        });

      const upsertIssue = (entry: IssueIndexEntry) =>
        Effect.gen(function* () {
          const issueKey = `issue:${entry.projectId}:${entry.fingerprint}`;
          const existing = yield* storage.get<IssueIndexEntry>(issueKey);
          if (existing) {
            yield* storage.delete(
              issueIndexKey(
                existing.severity,
                existing.lastSeen,
                `${entry.projectId}:${entry.fingerprint}`,
              ),
            );
          }
          yield* storage.put({
            [issueKey]: entry,
            [issueIndexKey(
              entry.severity,
              entry.lastSeen,
              `${entry.projectId}:${entry.fingerprint}`,
            )]: "",
          } as Record<string, unknown>);
        });

      return {
        recordProject: (entry: ProjectListEntry) => upsertProject(entry),
        recordIssue: (entry: IssueIndexEntry) => upsertIssue(entry),

        listProjects: (limit = 50) =>
          Effect.gen(function* () {
            const entries = yield* storage.list<string>({
              prefix: "project_idx:",
              limit: Math.min(limit, PROJECT_LIST_LIMIT),
            });
            const projects: ProjectListEntry[] = [];
            for (const key of entries.keys()) {
              const projectId = key.split(":").pop();
              if (!projectId) continue;
              const entry = yield* storage.get<ProjectListEntry>(
                `project:${projectId}`,
              );
              if (entry) projects.push(entry);
            }
            return projects;
          }),

        listIssues: (limit = 50) =>
          Effect.gen(function* () {
            const entries = yield* storage.list<string>({
              prefix: "issue_idx:",
              limit: Math.min(limit, ISSUE_LIST_LIMIT),
            });
            const issues: IssueIndexEntry[] = [];
            for (const key of entries.keys()) {
              // issue_idx:<sev>:<reverseTs>:<projectId>:<fingerprint>
              const parts = key.split(":");
              const fingerprint = parts.at(-1);
              const projectId = parts.at(-2);
              if (!projectId || !fingerprint) continue;
              const entry = yield* storage.get<IssueIndexEntry>(
                `issue:${projectId}:${fingerprint}`,
              );
              if (entry) issues.push(entry);
            }
            return issues;
          }),

        getProject: (projectId: string) =>
          Effect.gen(function* () {
            return yield* storage.get<ProjectListEntry>(`project:${projectId}`);
          }),
      };
    });
  }),
) {}
