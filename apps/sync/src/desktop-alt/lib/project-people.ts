import {
  normalizeProvenance,
  responsiblePerson,
  type WorkKind,
  type WorkProvenance,
} from './provenance';

/** Member fields exposed by `list_company_members`. */
export interface ProjectPersonMember {
  personUid: string;
  email: string | null;
  displayName: string | null;
}

export interface ResolvedProjectPerson {
  /** Stable filter identity. Member UIDs win; unresolved legacy labels remain stable. */
  key: string;
  /** Human-facing label. Raw `prs_…` identifiers are never displayed. */
  label: string;
}

interface ProjectPersonIdentity extends ProjectPersonMember {
  label: string;
}

export interface ProjectPersonDirectory {
  byUid: Map<string, ProjectPersonIdentity>;
  byEmail: Map<string, ProjectPersonIdentity | null>;
  byDisplayName: Map<string, ProjectPersonIdentity | null>;
  byRenderedLabel: Map<string, ProjectPersonIdentity | null>;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean ? clean : null;
}

function normalizedAlias(value: string): string {
  return value.trim().toLowerCase();
}

function rowsFromResponse(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (response === null || typeof response !== 'object') return [];
  const contacts = (response as Record<string, unknown>).contacts;
  return Array.isArray(contacts) ? contacts : [];
}

/**
 * Normalize both the current `{ contacts: [...] }` response and legacy direct
 * arrays at the Tauri boundary. Duplicate rows for one UID or exact email are
 * merged. The email merge joins the Cognito self record to the company member
 * record even though those systems use different internal IDs.
 */
export function normalizeProjectMembers(response: unknown): ProjectPersonMember[] {
  const members: ProjectPersonMember[] = [];
  const indexByUid = new Map<string, number>();
  const indexByEmail = new Map<string, number>();
  for (const raw of rowsFromResponse(response)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const personUid = cleanString(row.personUid);
    if (!personUid) continue;
    const email = cleanString(row.email);
    const emailKey = email ? normalizedAlias(email) : null;
    const existingIndex =
      indexByUid.get(personUid) ??
      (emailKey === null ? undefined : indexByEmail.get(emailKey));

    if (existingIndex === undefined) {
      const index = members.length;
      members.push({
        personUid,
        email,
        displayName: cleanString(row.displayName),
      });
      indexByUid.set(personUid, index);
      if (emailKey) indexByEmail.set(emailKey, index);
      continue;
    }

    const previous = members[existingIndex];
    const mergedEmail = email ?? previous.email;
    members[existingIndex] = {
      personUid: previous.personUid,
      email: mergedEmail,
      displayName: cleanString(row.displayName) ?? previous.displayName,
    };
    indexByUid.set(personUid, existingIndex);
    if (mergedEmail) {
      indexByEmail.set(normalizedAlias(mergedEmail), existingIndex);
    }
  }
  return members;
}

function addUniqueAlias(
  map: Map<string, ProjectPersonIdentity | null>,
  alias: string | null,
  member: ProjectPersonIdentity,
): void {
  if (!alias) return;
  const key = normalizedAlias(alias);
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, member);
  } else if (existing !== null && existing.personUid !== member.personUid) {
    map.set(key, null);
  }
}

/** Build canonical UID/email/name aliases without merging ambiguous names. */
export function buildProjectPersonDirectory(
  members: readonly ProjectPersonMember[],
): ProjectPersonDirectory {
  const uniqueMembers = normalizeProjectMembers(members);
  const baseLabelGroups = new Map<string, ProjectPersonMember[]>();
  for (const member of uniqueMembers) {
    const base = member.displayName ?? member.email ?? 'Team member';
    const key = normalizedAlias(base);
    baseLabelGroups.set(key, [...(baseLabelGroups.get(key) ?? []), member]);
  }

  const identities: ProjectPersonIdentity[] = [];
  for (const group of baseLabelGroups.values()) {
    const sorted = [...group].sort((a, b) =>
      (a.email ?? a.personUid).localeCompare(b.email ?? b.personUid),
    );
    sorted.forEach((member, index) => {
      const base = member.displayName ?? member.email ?? 'Team member';
      const label =
        sorted.length === 1
          ? base
          : member.displayName && member.email
            ? `${member.displayName} · ${member.email}`
            : `${base} · member ${index + 1}`;
      identities.push({ ...member, label });
    });
  }

  const directory: ProjectPersonDirectory = {
    byUid: new Map(),
    byEmail: new Map(),
    byDisplayName: new Map(),
    byRenderedLabel: new Map(),
  };
  for (const member of identities) {
    directory.byUid.set(member.personUid, member);
    addUniqueAlias(directory.byEmail, member.email, member);
    addUniqueAlias(directory.byDisplayName, member.displayName, member);
    addUniqueAlias(directory.byRenderedLabel, member.label, member);
  }
  return directory;
}

/** Resolve a legacy display name/email to one canonical person when possible. */
export function resolveProjectPerson(
  rawLabel: string | null | undefined,
  directory: ProjectPersonDirectory,
): ResolvedProjectPerson | null {
  const clean = cleanString(rawLabel);
  if (!clean) return null;
  const alias = normalizedAlias(clean);
  const member =
    directory.byUid.get(clean) ??
    directory.byEmail.get(alias) ??
    directory.byRenderedLabel.get(alias) ??
    directory.byDisplayName.get(alias) ??
    null;
  return member
    ? { key: `person:${member.personUid}`, label: member.label }
    : { key: `label:${alias}`, label: clean };
}

/** Replace known member aliases with their canonical human-facing label. */
export function canonicalizeProjectProvenance(
  value: WorkProvenance | null | undefined,
  directory: ProjectPersonDirectory,
): WorkProvenance {
  const provenance = normalizeProvenance(value);
  return {
    owner: resolveProjectPerson(provenance.owner, directory)?.label ?? null,
    assignee: resolveProjectPerson(provenance.assignee, directory)?.label ?? null,
    creator: resolveProjectPerson(provenance.creator, directory)?.label ?? null,
    origin: provenance.origin,
  };
}

/** Canonical person used by project/story person filters. */
export function responsibleProjectPerson(
  value: WorkProvenance | null | undefined,
  kind: WorkKind,
  directory: ProjectPersonDirectory,
): ResolvedProjectPerson | null {
  const person = responsiblePerson(value, kind);
  return person === 'Unassigned' ? null : resolveProjectPerson(person, directory);
}
