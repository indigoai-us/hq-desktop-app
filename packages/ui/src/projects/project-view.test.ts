import { describe, expect, it, beforeEach } from "vitest";
import type { Story } from "./projects-model.js";
import {
  clearProjectViewCache,
  identityAvatarSrc,
  mergeStories,
  overlayLiveAssignment,
  parseProjectViewStories,
  parseStoryIdentity,
} from "./project-view.js";

const person = {
  uid: "prs_ada",
  kind: "person" as const,
  displayName: "Ada Lovelace",
  avatarRef: { url: "https://cdn.example/ada.png" },
};

const agent = {
  uid: "agt_runner",
  kind: "agent" as const,
  displayName: "Runner",
  avatarRef: null,
};

function staticStory(id = "US-001"): Story {
  return {
    id,
    title: "Static title",
    description: "From the PRD",
    acceptanceCriteria: ["ships"],
    passes: false,
    labels: ["ui"],
    dependsOn: [],
    assigneeUid: "prs_forged",
    assignee: {
      uid: "prs_forged",
      kind: "person",
      displayName: "Forged",
      avatarRef: null,
    },
  };
}

const view = {
  companyUid: "cmp_indigo",
  projectId: "work-mesh",
  stories: [
    {
      id: "US-001",
      title: "Live title",
      assigneeUid: "prs_ada",
      assigneeSource: "explicit",
      assignedAt: "2026-09-21T00:00:00.000Z",
      assignedBy: "prs_ada",
      lastActorUid: "agt_runner",
      lastActorAt: "2026-09-21T01:00:00.000Z",
      changes: [
        {
          at: "2026-09-21T01:00:00.000Z",
          actorUid: "agt_runner",
          from: "queued",
          to: "in_progress",
        },
      ],
      assignee: person,
      lastActor: agent,
    },
    {
      id: "US-002",
      assigneeUid: null,
      assigneeSource: null,
      assignee: null,
      lastActor: null,
      changes: "nope",
    },
  ],
};

describe("ProjectView parser", () => {
  beforeEach(() => clearProjectViewCache());

  it("parses a person, an agent fallback, and an unassigned story", () => {
    const stories = parseProjectViewStories(view, "work-mesh");
    expect(stories?.[0]?.assignee).toEqual(person);
    expect(stories?.[0]?.lastActor?.kind).toBe("agent");
    expect(stories?.[1]?.assignee).toBeNull();
    expect(stories?.[1]?.changes).toEqual([]);
  });

  it("infers kind and drops a missing avatar", () => {
    expect(
      parseStoryIdentity({ uid: "agt_x", displayName: "Bot" })?.kind,
    ).toBe("agent");
    expect(
      parseStoryIdentity({
        uid: "prs_x",
        displayName: "Pat",
        avatarRef: { url: "" },
      })?.avatarRef,
    ).toBeNull();
  });

  it("does not let static PRD assignment overwrite the live assignee", () => {
    const live = parseProjectViewStories(view, "work-mesh");
    const merged = mergeStories([staticStory()], live);
    expect(merged[0]?.title).toBe("Static title");
    expect(merged[0]?.description).toBe("From the PRD");
    expect(merged[0]?.assignee?.displayName).toBe("Ada Lovelace");
    expect(merged[0]?.assigneeUid).toBe("prs_ada");
    expect(merged[0]?.lastActor?.uid).toBe("agt_runner");
  });

  it("blanks assignment when the server view is missing", () => {
    const merged = mergeStories([staticStory()], null);
    expect(merged[0]?.assignee).toBeNull();
    expect(merged[0]?.assigneeUid).toBeNull();
    expect(merged[0]?.title).toBe("Static title");
  });

  it("builds a data URL for base64 and keeps a presigned URL", () => {
    expect(identityAvatarSrc(person)).toBe("https://cdn.example/ada.png");
    expect(
      identityAvatarSrc({
        uid: "prs_ada",
        kind: "person",
        displayName: "Ada",
        avatarRef: { base64: "abc" },
      }),
    ).toBe("data:image/png;base64,abc");
    expect(identityAvatarSrc(agent)).toBeNull();
  });

  it("caches a successful view and reuses it after a later failure", async () => {
    const calls: string[] = [];
    let fail = false;
    const stories = await overlayLiveAssignment({
      projectId: "work-mesh",
      companyUid: "cmp_indigo",
      staticStories: [staticStory()],
      getProjectView: async (projectId) => {
        calls.push(projectId);
        if (fail) return { ok: false };
        return { ok: true, value: view };
      },
    });
    expect(stories[0]?.assignee?.uid).toBe("prs_ada");
    fail = true;
    const again = await overlayLiveAssignment({
      projectId: "work-mesh",
      companyUid: "cmp_indigo",
      staticStories: [staticStory()],
      getProjectView: async () => ({ ok: false }),
    });
    expect(again[0]?.assignee?.displayName).toBe("Ada Lovelace");
    expect(calls).toEqual(["work-mesh"]);
  });
});
