/**
 * Compute a stable fingerprint for an event so repeated occurrences map to
 * a single Issue inside a project's DO. FNV-1a 64-bit because we need to
 * run on every event in the worker hot path; cryptographic strength isn't
 * required.
 */
export const fingerprint = (parts: readonly string[]): string => {
  const input = parts
    .map((p) => normalize(p))
    .filter((p) => p.length > 0)
    .join("|");
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
};

/**
 * Normalize a token so trivial variations (memory addresses, request ids,
 * timestamps, bare numbers) don't fragment the same logical issue across
 * many fingerprints.
 */
const normalize = (s: string): string =>
  s
    .replace(/0x[0-9a-fA-F]+/g, "0xN")
    .replace(/\b[0-9a-fA-F]{8,}\b/g, "HEX")
    .replace(/\b\d{10,}\b/g, "TS")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Inside a ProjectDO we want `storage.list({ prefix: "event:", limit: N })`
 * to return *newest first*. KV is lex-ordered, so we encode the timestamp
 * as a 16-char zero-padded "reverse" number (`MAX_SAFE_INTEGER - ts`). All
 * timestamps fit in 16 digits since `MAX_SAFE_INTEGER` is 9007199254740991.
 */
export const eventKey = (timestamp: number, tieBreak: string): string =>
  `event:${reverseTs(timestamp)}:${tieBreak}`;

export const reverseTs = (timestamp: number): string =>
  (Number.MAX_SAFE_INTEGER - timestamp).toString().padStart(16, "0");

/**
 * Sortable key for the per-project issue index. Severity ascends in the
 * key (higher severity prefix is `0` for sev 5) so that a single
 * `list({ prefix: "issue_idx:" })` returns the most-critical issues first
 * with the most-recent ones inside each severity bucket also first.
 */
export const issueIndexKey = (
  severity: number,
  lastSeen: number,
  fingerprint: string,
): string => {
  const sevDesc = (5 - clampSeverity(severity)).toString();
  return `issue_idx:${sevDesc}:${reverseTs(lastSeen)}:${fingerprint}`;
};

const clampSeverity = (n: number): number =>
  Math.min(5, Math.max(1, Math.round(n)));
