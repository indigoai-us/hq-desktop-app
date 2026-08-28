/**
 * Console skills-shelf → Library skills, scoped to the viewer.
 *
 * The hq-pro shelf (`GET /v1/skills/{companyUid}/shelf`) returns every skill
 * in the company plus ACL rows. `/me` returns the caller's personUid and
 * group memberships. We keep only skills the viewer owns, has a person/group
 * grant on, or can read via @all / the open floor — the same match the
 * console uses for "shared with me".
 */

export interface ShelfViewer {
  personUid: string | null;
  groupIds: string[];
  isActiveMember: boolean;
}

export interface LibrarySkillWire {
  name: string;
  description: string;
  scope: "company";
  company: string;
  path: string;
  allowedTools: string[];
  pack?: string;
}

export interface LibrarySkillDetailWire {
  name: string;
  description: string;
  allowedTools: string[];
  body: string;
}

interface SkillSummary {
  skillUid: string;
  name: string;
  description: string;
  ownerPersonUid: string;
  tags: string[];
  department: string | null;
}

interface AccessEntry {
  granteeType: string;
  granteeId: string;
}

interface AclSummary {
  skillUid: string;
  open: boolean;
  entries: AccessEntry[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseSummary(value: unknown): SkillSummary | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const skillUid = asString(rec.skillUid).trim();
  const name = asString(rec.name).trim();
  if (!skillUid || !name) return null;
  return {
    skillUid,
    name,
    description: asString(rec.description),
    ownerPersonUid: asString(rec.ownerPersonUid),
    tags: Array.isArray(rec.tags)
      ? rec.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    department:
      typeof rec.department === "string" && rec.department.trim()
        ? rec.department.trim()
        : null,
  };
}

function parseAcls(value: unknown): Map<string, AclSummary> {
  const map = new Map<string, AclSummary>();
  if (!Array.isArray(value)) return map;
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const skillUid = asString(rec.skillUid).trim();
    if (!skillUid) continue;
    const entries = Array.isArray(rec.entries)
      ? rec.entries
          .map((entry) => {
            const row = asRecord(entry);
            if (!row) return null;
            return {
              granteeType: asString(row.granteeType),
              granteeId: asString(row.granteeId),
            };
          })
          .filter((entry): entry is AccessEntry => entry !== null)
      : [];
    map.set(skillUid, {
      skillUid,
      open: rec.open === true,
      entries,
    });
  }
  return map;
}

export function parseShelfViewer(value: unknown): ShelfViewer {
  const rec = asRecord(value);
  const personUid = asString(rec?.personUid).trim();
  const groupIds = Array.isArray(rec?.groupIds)
    ? rec.groupIds.filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      )
    : [];
  return {
    personUid: personUid || null,
    groupIds,
    isActiveMember: rec?.isActiveMember !== false,
  };
}

/** Console "shared with me" match — owner, person/group/@all grant, or open. */
export function skillVisibleToViewer(
  skill: SkillSummary,
  acl: AclSummary | undefined,
  viewer: ShelfViewer,
): boolean {
  if (viewer.personUid && skill.ownerPersonUid === viewer.personUid)
    return true;
  if (acl?.open && viewer.isActiveMember) return true;
  const groups = new Set(viewer.groupIds);
  for (const entry of acl?.entries ?? []) {
    if (
      entry.granteeType === "person" &&
      viewer.personUid &&
      entry.granteeId === viewer.personUid
    ) {
      return true;
    }
    if (entry.granteeType === "group" && groups.has(entry.granteeId)) {
      return true;
    }
    if (entry.granteeType === "company-wide" && viewer.isActiveMember) {
      return true;
    }
  }
  return false;
}

function flattenSummaries(payload: unknown): SkillSummary[] {
  const rec = asRecord(payload);
  const grouped = asRecord(rec?.grouped) ?? rec;
  if (!grouped) return [];
  const out: SkillSummary[] = [];
  const push = (value: unknown) => {
    const summary = parseSummary(value);
    if (summary) out.push(summary);
  };
  if (Array.isArray(grouped.companyWide)) grouped.companyWide.forEach(push);
  if (Array.isArray(grouped.departments)) {
    for (const dept of grouped.departments) {
      const section = asRecord(dept);
      if (Array.isArray(section?.skills)) section.skills.forEach(push);
    }
  }
  return out;
}

export function scopedSkillsFromShelf(
  payload: unknown,
  viewer: ShelfViewer,
  company: { uid: string; slug: string; name: string },
): LibrarySkillWire[] {
  const acls = parseAcls(asRecord(payload)?.acls);
  const label = company.slug || company.name || company.uid;
  return flattenSummaries(payload)
    .filter((skill) =>
      skillVisibleToViewer(skill, acls.get(skill.skillUid), viewer),
    )
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      scope: "company" as const,
      company: label,
      path: `${company.uid}/${skill.skillUid}`,
      allowedTools: [],
      ...(skill.tags[0] ? { pack: skill.tags[0] } : {}),
    }));
}

export function skillDetailFromShelf(
  payload: unknown,
  skillUid: string,
): LibrarySkillDetailWire | null {
  const match = flattenSummaries(payload).find(
    (skill) => skill.skillUid === skillUid,
  );
  if (!match) return null;
  return {
    name: match.name,
    description: match.description,
    allowedTools: [],
    body: match.description,
  };
}

export function parseSkillPath(
  path: string,
): { companyUid: string; skillUid: string } | null {
  const [companyUid, skillUid] = path.split("/").filter(Boolean);
  if (!companyUid || !skillUid) return null;
  return { companyUid, skillUid };
}
