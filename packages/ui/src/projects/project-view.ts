/**
 * Single fetch, parse, and cache boundary for a live ProjectView.
 *
 * Static PRD stories supply title, description, and acceptance criteria.
 * They never supply assignment. A missing or failed ProjectView leaves
 * every story unassigned rather than inventing an owner from the PRD.
 */

import type { Story, StoryAssigneeSource, StoryChange, StoryIdentity } from "./projects-model.js";

export interface LiveStoryAssignment {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  passes: boolean | null;
  assigneeUid: string | null;
  assigneeSource: StoryAssigneeSource;
  assignedAt: string | null;
  assignedBy: string | null;
  lastActorUid: string | null;
  lastActorAt: string | null;
  changes: StoryChange[];
  assignee: StoryIdentity | null;
  lastActor: StoryIdentity | null;
}

type ProjectViewGetter = (
  projectId: string,
  companyUid?: string,
) => Promise<{ ok: boolean; value?: unknown }>;

const cache = new Map<string, LiveStoryAssignment[]>();

function cacheKey(companyUid: string, projectId: string): string {
  return `${companyUid}\n${projectId}`;
}

export function clearProjectViewCache(): void {
  cache.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function kindFromUid(uid: string): "person" | "agent" {
  return uid.startsWith("agt_") ? "agent" : "person";
}

/** Parse one hydrated identity. Malformed rows become null, not a throw. */
export function parseStoryIdentity(raw: unknown): StoryIdentity | null {
  if (!isRecord(raw)) return null;
  const uid = str(raw.uid);
  if (!uid) return null;
  const kind = raw.kind === "agent" || raw.kind === "person" ? raw.kind : kindFromUid(uid);
  const displayName = str(raw.displayName) ?? (kind === "agent" ? "Unknown agent" : "Unknown person");
  let avatarRef: StoryIdentity["avatarRef"] = null;
  if (isRecord(raw.avatarRef)) {
    const url = str(raw.avatarRef.url) ?? undefined;
    const base64 = str(raw.avatarRef.base64) ?? undefined;
    if (url || base64) avatarRef = { ...(url ? { url } : {}), ...(base64 ? { base64 } : {}) };
    if ("key" in raw.avatarRef || "avatarKey" in raw.avatarRef) {
      // Storage keys are not a paint source. Drop the ref rather than render them.
      avatarRef = url || base64 ? avatarRef : null;
    }
  }
  return { uid, kind, displayName, avatarRef };
}

function parseChanges(raw: unknown): StoryChange[] {
  if (!Array.isArray(raw)) return [];
  const out: StoryChange[] = [];
  for (const row of raw) {
    if (!isRecord(row)) continue;
    const at = str(row.at);
    const actorUid = str(row.actorUid);
    const from = str(row.from);
    const to = str(row.to);
    if (!at || !actorUid || !from || !to) continue;
    out.push({ at, actorUid, from, to });
  }
  return out.slice(-32);
}

function parseSource(raw: unknown): StoryAssigneeSource {
  return raw === "actor" || raw === "explicit" ? raw : null;
}

function parseLiveStory(raw: unknown): LiveStoryAssignment | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const criteria = Array.isArray(raw.acceptanceCriteria)
    ? raw.acceptanceCriteria.filter((item): item is string => typeof item === "string")
    : [];
  return {
    id,
    title: str(raw.title) ?? "",
    description: str(raw.description) ?? "",
    acceptanceCriteria: criteria,
    passes: typeof raw.passes === "boolean" ? raw.passes : null,
    assigneeUid: str(raw.assigneeUid),
    assigneeSource: parseSource(raw.assigneeSource),
    assignedAt: str(raw.assignedAt),
    assignedBy: str(raw.assignedBy),
    lastActorUid: str(raw.lastActorUid),
    lastActorAt: str(raw.lastActorAt),
    changes: parseChanges(raw.changes),
    assignee: parseStoryIdentity(raw.assignee),
    lastActor: parseStoryIdentity(raw.lastActor),
  };
}

/**
 * Parse a GET ProjectView body into live stories.
 * Returns null when the payload is not a project view for `projectId`.
 */
export function parseProjectViewStories(
  raw: unknown,
  projectId: string,
): LiveStoryAssignment[] | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.projectId);
  if (id && id !== projectId) return null;
  const source = Array.isArray(raw.stories)
    ? raw.stories
    : Array.isArray(raw.userStories)
      ? raw.userStories
      : null;
  if (!source) return null;
  return source
    .map(parseLiveStory)
    .filter((story): story is LiveStoryAssignment => story !== null);
}

function blankAssignment(story: Story): Story {
  return {
    ...story,
    assigneeUid: null,
    assigneeSource: null,
    assignedAt: null,
    assignedBy: null,
    lastActorUid: null,
    lastActorAt: null,
    changes: [],
    assignee: null,
    lastActor: null,
  };
}

function applyLive(story: Story, live: LiveStoryAssignment): Story {
  return {
    ...story,
    title: story.title || live.title,
    description: story.description || live.description,
    acceptanceCriteria:
      story.acceptanceCriteria.length > 0 ? story.acceptanceCriteria : live.acceptanceCriteria,
    passes: live.passes ?? story.passes,
    assigneeUid: live.assigneeUid,
    assigneeSource: live.assigneeSource,
    assignedAt: live.assignedAt,
    assignedBy: live.assignedBy,
    lastActorUid: live.lastActorUid,
    lastActorAt: live.lastActorAt,
    changes: live.changes,
    assignee: live.assignee,
    lastActor: live.lastActor,
  };
}

/**
 * Overlay live assignment onto static PRD stories.
 * Static fields never replace assignee, last actor, or history.
 * Pass `live === null` when there is no server ProjectView.
 */
export function mergeStories(
  staticStories: Story[],
  live: LiveStoryAssignment[] | null,
): Story[] {
  if (!live) return staticStories.map(blankAssignment);
  const byId = new Map(live.map((story) => [story.id, story]));
  const seen = new Set<string>();
  const merged = staticStories.map((story) => {
    seen.add(story.id);
    const row = byId.get(story.id);
    return row ? applyLive(story, row) : blankAssignment(story);
  });
  for (const row of live) {
    if (seen.has(row.id)) continue;
    merged.push(
      applyLive(
        {
          id: row.id,
          title: row.title,
          description: row.description,
          acceptanceCriteria: row.acceptanceCriteria,
          passes: row.passes ?? false,
          labels: [],
          dependsOn: [],
        },
        row,
      ),
    );
  }
  return merged;
}

/** Image src for IdentityMark. Presigned URLs pass through; base64 becomes a data URL. */
export function identityAvatarSrc(identity: StoryIdentity | null | undefined): string | null {
  const ref = identity?.avatarRef;
  if (!ref) return null;
  if (ref.url) return ref.url;
  if (!ref.base64) return null;
  if (ref.base64.startsWith("data:image/")) return ref.base64;
  return `data:image/png;base64,${ref.base64}`;
}

/**
 * Load static stories, then overlay the canonical ProjectView when the
 * company has a cloud uid. Network failure reuses the last good parse.
 */
export async function overlayLiveAssignment(input: {
  projectId: string;
  companyUid?: string | null;
  staticStories: Story[];
  getProjectView?: ProjectViewGetter | null;
}): Promise<Story[]> {
  const companyUid = input.companyUid?.trim() ?? "";
  const projectId = input.projectId.trim();
  if (!companyUid || !projectId || !input.getProjectView) {
    return mergeStories(input.staticStories, null);
  }
  const key = cacheKey(companyUid, projectId);
  try {
    const result = await input.getProjectView(projectId, companyUid);
    if (!result?.ok) {
      const cached = cache.get(key);
      return mergeStories(input.staticStories, cached ?? null);
    }
    const live = parseProjectViewStories(result.value, projectId);
    if (!live) return mergeStories(input.staticStories, cache.get(key) ?? null);
    cache.set(key, live);
    return mergeStories(input.staticStories, live);
  } catch {
    return mergeStories(input.staticStories, cache.get(key) ?? null);
  }
}
