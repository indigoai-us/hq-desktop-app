import { describe, expect, it } from "vitest";

import {
  parseShelfViewer,
  parseSkillPath,
  scopedSkillsFromShelf,
  skillDetailFromShelf,
  skillVisibleToViewer,
} from "./library-shelf.js";

const viewer = {
  personUid: "prs_me",
  groupIds: ["grp_cs"],
  isActiveMember: true,
};

const company = { uid: "cmp_acme", slug: "acme", name: "Acme" };

function shelf(skills: unknown[], acls: unknown[] = []) {
  return {
    grouped: { companyWide: skills, departments: [] },
    acls,
  };
}

describe("skillVisibleToViewer", () => {
  it("keeps skills the viewer owns", () => {
    expect(
      skillVisibleToViewer(
        {
          skillUid: "skl_1",
          name: "Mine",
          description: "",
          ownerPersonUid: "prs_me",
          tags: [],
          department: null,
        },
        undefined,
        viewer,
      ),
    ).toBe(true);
  });

  it("keeps person, group, and company-wide grants plus the open floor", () => {
    const base = {
      skillUid: "skl_x",
      name: "X",
      description: "",
      ownerPersonUid: "prs_other",
      tags: [],
      department: null,
    };
    expect(
      skillVisibleToViewer(
        base,
        {
          skillUid: "skl_x",
          open: false,
          entries: [{ granteeType: "person", granteeId: "prs_me" }],
        },
        viewer,
      ),
    ).toBe(true);
    expect(
      skillVisibleToViewer(
        base,
        {
          skillUid: "skl_x",
          open: false,
          entries: [{ granteeType: "group", granteeId: "grp_cs" }],
        },
        viewer,
      ),
    ).toBe(true);
    expect(
      skillVisibleToViewer(
        base,
        {
          skillUid: "skl_x",
          open: false,
          entries: [{ granteeType: "company-wide", granteeId: "" }],
        },
        viewer,
      ),
    ).toBe(true);
    expect(
      skillVisibleToViewer(
        base,
        { skillUid: "skl_x", open: true, entries: [] },
        viewer,
      ),
    ).toBe(true);
  });

  it("drops skills with no grant for the viewer", () => {
    expect(
      skillVisibleToViewer(
        {
          skillUid: "skl_secret",
          name: "Secret",
          description: "",
          ownerPersonUid: "prs_other",
          tags: [],
          department: null,
        },
        {
          skillUid: "skl_secret",
          open: false,
          entries: [{ granteeType: "person", granteeId: "prs_else" }],
        },
        viewer,
      ),
    ).toBe(false);
  });
});

describe("scopedSkillsFromShelf", () => {
  it("returns only viewer-scoped skills with a stable path", () => {
    const rows = scopedSkillsFromShelf(
      shelf(
        [
          {
            skillUid: "skl_mine",
            name: "Review",
            description: "PR review",
            ownerPersonUid: "prs_me",
            tags: ["eng"],
          },
          {
            skillUid: "skl_hidden",
            name: "Hidden",
            description: "nope",
            ownerPersonUid: "prs_other",
            tags: [],
          },
        ],
        [],
      ),
      viewer,
      company,
    );
    expect(rows).toEqual([
      {
        name: "Review",
        description: "PR review",
        scope: "company",
        company: "acme",
        path: "cmp_acme/skl_mine",
        allowedTools: [],
        pack: "eng",
      },
    ]);
  });
});

describe("skillDetailFromShelf / parseSkillPath", () => {
  it("finds a skill and splits companyUid/skillUid paths", () => {
    expect(parseSkillPath("cmp_acme/skl_mine")).toEqual({
      companyUid: "cmp_acme",
      skillUid: "skl_mine",
    });
    const detail = skillDetailFromShelf(
      shelf([
        {
          skillUid: "skl_mine",
          name: "Review",
          description: "PR review",
          ownerPersonUid: "prs_me",
        },
      ]),
      "skl_mine",
    );
    expect(detail).toMatchObject({ name: "Review", body: "PR review" });
  });
});

describe("parseShelfViewer", () => {
  it("reads person + groups from /me", () => {
    expect(
      parseShelfViewer({
        personUid: "prs_me",
        groupIds: ["grp_cs", ""],
        isActiveMember: true,
      }),
    ).toEqual({
      personUid: "prs_me",
      groupIds: ["grp_cs"],
      isActiveMember: true,
    });
  });
});
