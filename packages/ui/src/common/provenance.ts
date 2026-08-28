/**
 * Canonical, backward-compatible attribution carried by project and story
 * surfaces. Every value is nullable because older board/prd files do not
 * declare provenance.
 */
export interface WorkProvenance {
  owner: string | null;
  assignee: string | null;
  creator: string | null;
  origin: string | null;
}

export type WorkKind = "project" | "story";

export interface ProvenancePerson {
  role: "Owner" | "Assignee" | "Created by";
  label: string;
}

export interface ProvenanceView {
  people: ProvenancePerson[];
  origin: string;
  ariaLabel: string;
}

type UnknownRecord = Record<string, unknown>;

const OWNER_KEYS = ["owner", "ownerName", "owner_name"] as const;
const ASSIGNEE_KEYS = [
  "assignee",
  "assigneeName",
  "assignee_name",
  "assignedTo",
  "assigned_to",
] as const;
const CREATOR_KEYS = [
  "creator",
  "creatorName",
  "creator_name",
  "createdByName",
  "created_by_name",
  "createdBy",
  "created_by",
] as const;
const ORIGIN_KEYS = ["origin", "source", "sourceName", "source_name"] as const;
const PERSON_LABEL_KEYS = [
  "displayName",
  "display_name",
  "name",
  "email",
  "handle",
  "label",
] as const;
const ORIGIN_LABEL_KEYS = [
  "label",
  "name",
  "type",
  "provider",
  "source",
] as const;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean.length > 0 ? clean : null;
}

function labelledValue(value: unknown, keys: readonly string[]): string | null {
  const direct = cleanString(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  for (const key of keys) {
    const label = cleanString(record[key]);
    if (label) return label;
  }
  return null;
}

/**
 * A source may use the canonical nested `provenance` object or legacy direct
 * fields. Canonical nested fields win within that source.
 */
function recordsForSource(source: unknown): UnknownRecord[] {
  const record = asRecord(source);
  if (!record) return [];
  const nested = asRecord(record.provenance);
  return nested ? [nested, record] : [record];
}

function firstField(
  sources: readonly unknown[],
  keys: readonly string[],
  labelKeys: readonly string[],
): string | null {
  for (const source of sources) {
    for (const record of recordsForSource(source)) {
      for (const key of keys) {
        const label = labelledValue(record[key], labelKeys);
        if (label) return label;
      }
    }
  }
  return null;
}

/**
 * Normalize current and legacy wire shapes. Sources are ordered from most to
 * least authoritative; missing fields fall through independently.
 */
export function normalizeProvenance(...sources: unknown[]): WorkProvenance {
  return {
    owner: firstField(sources, OWNER_KEYS, PERSON_LABEL_KEYS),
    assignee: firstField(sources, ASSIGNEE_KEYS, PERSON_LABEL_KEYS),
    creator: firstField(sources, CREATOR_KEYS, PERSON_LABEL_KEYS),
    origin: firstField(sources, ORIGIN_KEYS, ORIGIN_LABEL_KEYS),
  };
}

/** Merge a primary record with a lower-priority fallback record. */
export function mergeProvenance(
  primary: WorkProvenance | null | undefined,
  fallback: WorkProvenance | null | undefined,
): WorkProvenance {
  return normalizeProvenance(primary, fallback);
}

/** True when at least one real attribution field is present. */
export function hasProvenance(
  value: WorkProvenance | null | undefined,
): boolean {
  const normalized = normalizeProvenance(value);
  return Boolean(
    normalized.owner ||
    normalized.assignee ||
    normalized.creator ||
    normalized.origin,
  );
}

/**
 * Resolve a compact display model without inventing a person or source.
 * Missing people stay visually quiet; missing origins remain explicit.
 */
export function provenanceView(
  value: WorkProvenance | null | undefined,
  kind: WorkKind,
  attributionUnavailable = false,
): ProvenanceView {
  const normalized = normalizeProvenance(value);
  const people: ProvenancePerson[] = [];
  if (kind === "story" && normalized.assignee) {
    people.push({ role: "Assignee", label: normalized.assignee });
  }
  if (normalized.owner) {
    people.push({ role: "Owner", label: normalized.owner });
  }
  if (kind === "project" && normalized.assignee) {
    people.push({ role: "Assignee", label: normalized.assignee });
  }
  if (normalized.creator) {
    people.push({ role: "Created by", label: normalized.creator });
  }
  const origin = normalized.origin
    ? `Source ${normalized.origin}`
    : attributionUnavailable
      ? "Attribution unavailable"
      : "Unknown source";
  const personLabels = people.map((person) => `${person.role} ${person.label}`);
  return {
    people,
    origin,
    ariaLabel: [...personLabels, origin].filter(Boolean).join(" · "),
  };
}

/** Person used for owner/assignee filtering, with creator as the final fallback. */
export function responsiblePerson(
  value: WorkProvenance | null | undefined,
  kind: WorkKind,
): string {
  const normalized = normalizeProvenance(value);
  if (kind === "story" && normalized.assignee) return normalized.assignee;
  return (
    normalized.owner ??
    normalized.assignee ??
    normalized.creator ??
    "Unassigned"
  );
}
