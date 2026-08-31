import { describe, expect, it } from "vitest";

import { metaFromProjectView, parseChannelMembers } from "./live-project.js";

describe("parseChannelMembers", () => {
  it("maps notify members into status roster rows", () => {
    const members = parseChannelMembers({
      members: [
        {
          personUid: "prs_me",
          displayName: "Stefan Johnson",
          email: "stefan@getindigo.ai",
          role: "owner",
        },
        {
          personUid: "agt_bot",
          displayName: "Mesh Bot",
          role: "member",
        },
      ],
    });
    expect(members).toEqual([
      expect.objectContaining({ personUid: "prs_me", isAgent: false }),
      expect.objectContaining({ personUid: "agt_bot", isAgent: true }),
    ]);
  });
});

describe("metaFromProjectView", () => {
  it("builds board columns and keeps repos on status, not Files", () => {
    const meta = metaFromProjectView(
      {
        companyUid: "cmp_1",
        projectId: "work-mesh-testing",
        name: "work-mesh-testing",
        description: "Live board for HQ Work mesh.",
        stories: [
          { id: "US-001", title: "Directory", status: "done", passes: true },
          { id: "US-002", title: "Board", status: "in_progress" },
        ],
        repos: [{ path: "repos/private/hq-pro", branch: "feature/x" }],
        files: [
          {
            path: "projects/work-mesh-testing/prd.json",
            name: "prd.json",
          },
        ],
      },
      [
        {
          personUid: "prs_me",
          displayName: "Stefan",
          role: "owner",
        },
      ],
      [],
      "Indigo",
    );
    expect(Object.keys(meta.board?.stories ?? {})).toEqual([
      "US-001",
      "US-002",
    ]);
    expect(meta.files.map((file) => file.name)).toEqual(["prd.json"]);
    expect(meta.status?.members[0]?.displayName).toBe("Stefan");
    expect(meta.status?.project.repos[0]?.path).toContain("hq-pro");
    expect(meta.status?.companyLabel).toBe("Indigo");
    expect(meta.status?.project.description).toBe(
      "Live board for HQ Work mesh.",
    );
  });
});
