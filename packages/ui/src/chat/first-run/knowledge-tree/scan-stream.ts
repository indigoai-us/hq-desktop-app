/**
 * The scan stream: `hq import scan --json --stream` prints one JSON object per
 * line, each with `"v": 1` and a `"type"`. The desktop host validates each
 * line's shape and forwards it as an event; this module validates again on
 * this side of the bridge and turns the object into a typed event, dropping
 * anything it does not understand (a newer CLI may add types).
 *
 * Every string that reaches the screen is cleaned here: control characters
 * removed, whitespace collapsed, length capped. Nothing in here logs.
 */

export const SCAN_STREAM_VERSION = 1;

export interface ScanSource {
  id: string;
  label: string;
}

export type ScanSourceStatus = "scanning" | "done" | "skipped" | "error";
export type CompanyBasis = "hq-company" | "repo-org" | "folder";
export type ProjectBasis = "repo" | "claude-code-cwd" | "codex-cwd";

export type ScanEvent =
  | { type: "start"; sources: ScanSource[] }
  | { type: "source"; id: string; status: ScanSourceStatus; counts: Record<string, number> | null; message: string | null }
  | { type: "count"; source: string; key: string; value: number }
  | { type: "company"; id: string; name: string; basis: CompanyBasis | null }
  | { type: "project"; id: string; name: string; company: string | null; basis: ProjectBasis | null }
  | { type: "error"; source: string | null; message: string }
  | { type: "done"; report: string | null; summary: Record<string, number> };

/** Bounds that keep a hostile or broken stream from flooding the screen. */
export const SCAN_LIMITS = {
  idLength: 120,
  labelLength: 48,
  nameLength: 60,
  messageLength: 140,
  keyLength: 32,
  reportLength: 400,
  sources: 12,
  countKeys: 8,
  maxCount: 1e9,
} as const;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const KEY_RE = /^[a-z][a-z0-9_-]*$/;

/** Collapse whitespace, drop control characters, cap the length. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : flat;
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > SCAN_LIMITS.idLength || !ID_RE.test(id)) return null;
  return id;
}

function cleanCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(SCAN_LIMITS.maxCount, Math.floor(value));
}

function cleanKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return key && key.length <= SCAN_LIMITS.keyLength && KEY_RE.test(key) ? key : null;
}

function cleanCounts(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (n >= SCAN_LIMITS.countKeys) break;
    const key = cleanKey(k);
    const count = cleanCount(v);
    if (key === null || count === null) continue;
    out[key] = count;
    n += 1;
  }
  return out;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * One stream object (already JSON-parsed) to a typed event, or null when it
 * is not one this version understands.
 */
export function parseScanEvent(raw: unknown): ScanEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== SCAN_STREAM_VERSION) return null;
  switch (o.type) {
    case "start": {
      if (!Array.isArray(o.sources)) return null;
      const seen = new Set<string>();
      const sources: ScanSource[] = [];
      for (const s of o.sources) {
        if (sources.length >= SCAN_LIMITS.sources) break;
        if (!s || typeof s !== "object") continue;
        const id = cleanId((s as Record<string, unknown>).id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        sources.push({ id, label: cleanText((s as Record<string, unknown>).label, SCAN_LIMITS.labelLength) ?? prettySourceId(id) });
      }
      return { type: "start", sources };
    }
    case "source": {
      const id = cleanId(o.id);
      const status = oneOf(o.status, ["scanning", "done", "skipped", "error"] as const);
      if (!id || !status) return null;
      return {
        type: "source",
        id,
        status,
        counts: cleanCounts(o.counts),
        message: cleanText(o.message, SCAN_LIMITS.messageLength),
      };
    }
    case "count": {
      const source = cleanId(o.source);
      const key = cleanKey(o.key);
      const value = cleanCount(o.value);
      if (!source || key === null || value === null) return null;
      return { type: "count", source, key, value };
    }
    case "company": {
      const id = cleanId(o.id);
      const name = cleanText(o.name, SCAN_LIMITS.nameLength);
      if (!id || !name) return null;
      return { type: "company", id, name, basis: oneOf(o.basis, ["hq-company", "repo-org", "folder"] as const) };
    }
    case "project": {
      const id = cleanId(o.id);
      const name = cleanText(o.name, SCAN_LIMITS.nameLength);
      if (!id || !name) return null;
      const company = o.company === null || o.company === undefined ? null : cleanId(o.company);
      return {
        type: "project",
        id,
        name,
        company,
        basis: oneOf(o.basis, ["repo", "claude-code-cwd", "codex-cwd"] as const),
      };
    }
    case "error": {
      const message = cleanText(o.message, SCAN_LIMITS.messageLength);
      if (!message) return null;
      const source = o.source === null || o.source === undefined ? null : cleanId(o.source);
      return { type: "error", source, message };
    }
    case "done": {
      const report = typeof o.report === "string" && o.report.length <= SCAN_LIMITS.reportLength ? cleanText(o.report, SCAN_LIMITS.reportLength) : null;
      return { type: "done", report, summary: cleanCounts(o.summary) ?? {} };
    }
    default:
      return null;
  }
}

/** One raw line of the stream (the host forwards objects; tests and fixtures may pass text). */
export function parseScanLine(line: unknown): ScanEvent | null {
  if (typeof line === "string") {
    const text = line.trim();
    if (!text || text.length > 65536 || text[0] !== "{") return null;
    try {
      return parseScanEvent(JSON.parse(text));
    } catch {
      return null;
    }
  }
  return parseScanEvent(line);
}

/**
 * The source id hq-cli uses for its own failures ("the scanner is not
 * installed", "HQ folder not found"). Not a row: the scan as a whole failed.
 */
export const SCANNER_SOURCE = "scanner";

/** A "done" line that says the scan never ran: no report and nothing counted. */
export function isScanNotRun(event: { report: string | null; summary: Record<string, number> }): boolean {
  return event.report === null && Object.values(event.summary).every((v) => v === 0);
}

/** "claude-code" → "Claude code", for a source the start line did not name. */
export function prettySourceId(id: string): string {
  const words = id.replace(/[._:/@+-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}
