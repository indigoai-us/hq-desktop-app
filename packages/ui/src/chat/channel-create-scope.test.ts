import { describe, expect, it } from "vitest";

import type { Workspace } from "./workspaces.js";
import {
  availableCompanyUids,
  channelCreateValidationMessage,
  channelExistsWithName,
  companiesForChannelCreate,
  defaultChannelCompanyUid,
  directoryRowsFromFeed,
  formatChannelCreateFailure,
  isPersonalWorkspace,
  pickChannelCompanyUid,
  personalScopeAllowed,
  companyUidsByPerson,
  unavailableChannelScopes,
  unconfirmedCreateMessage,
  type ChannelCreateMember,
} from "./channel-create-scope.js";

function workspace(partial: Partial<Workspace>): Workspace {
  return {
    slug: "acme",
    displayName: "Acme",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_acme",
    bucketName: null,
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: "active",
    role: "member",
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...partial,
  };
}

const indigo = { companyUid: "cmp_indigo", label: "Indigo" };
const liveRecover = { companyUid: "cmp_lr", label: "LiveRecover" };
const companies = [indigo, liveRecover];

const stefan: ChannelCreateMember = {
  personUid: "prs_stefan",
  label: "Stefan Johnson",
  companyUids: ["cmp_indigo"],
};
const yousuf: ChannelCreateMember = {
  personUid: "prs_yousuf",
  label: "Yousuf Kalim",
  companyUids: ["cmp_indigo"],
};
const shawon: ChannelCreateMember = {
  personUid: "prs_shawon",
  label: "Shawon Majid",
  companyUids: ["cmp_indigo"],
};
const caitlin: ChannelCreateMember = {
  personUid: "prs_caitlin",
  label: "Caitlin",
  companyUids: ["cmp_lr"],
};
const agent: ChannelCreateMember = {
  personUid: "agt_desktop",
  label: "Desktop Agent",
  companyUids: [],
};

describe("isPersonalWorkspace", () => {
  it("treats kind/slug/state personal as personal", () => {
    expect(isPersonalWorkspace(workspace({ kind: "personal" }))).toBe(true);
    expect(isPersonalWorkspace(workspace({ slug: "personal", kind: "company" }))).toBe(
      true,
    );
    expect(isPersonalWorkspace(workspace({ state: "personal", kind: "company" }))).toBe(
      true,
    );
  });

  it("treats a membership named after the owner as the personal company", () => {
    expect(
      isPersonalWorkspace(
        workspace({
          slug: "corey-epstein",
          displayName: "Corey Epstein",
          kind: "company",
          cloudUid: "cmp_personal",
        }),
        "Corey Epstein",
      ),
    ).toBe(true);
    expect(
      isPersonalWorkspace(
        workspace({ displayName: "Indigo", kind: "company" }),
        "Corey Epstein",
      ),
    ).toBe(false);
  });
});

describe("companiesForChannelCreate", () => {
  it("drops personal workspaces and pending memberships", () => {
    expect(
      companiesForChannelCreate(
        [
          workspace({
            slug: "personal",
            displayName: "Corey Epstein",
            kind: "personal",
            cloudUid: "cmp_personal",
          }),
          workspace({
            slug: "corey-epstein",
            displayName: "Corey Epstein",
            kind: "company",
            cloudUid: "cmp_named_personal",
          }),
          workspace({
            slug: "indigo",
            displayName: "Indigo",
            cloudUid: "cmp_indigo",
            kind: "company",
          }),
          workspace({
            slug: "pending",
            displayName: "Pending Co",
            cloudUid: "cmp_pending",
            membershipStatus: "pending",
          }),
        ],
        "Corey Epstein",
      ),
    ).toEqual([{ companyUid: "cmp_indigo", label: "Indigo" }]);
  });
});

describe("defaultChannelCompanyUid", () => {
  it("defaults to the active company", () => {
    expect(
      defaultChannelCompanyUid({
        activeScope: "cmp_indigo",
        companies,
        members: [],
      }),
    ).toBe("cmp_indigo");
  });

  it("does not default All to personal when real companies exist", () => {
    expect(
      defaultChannelCompanyUid({
        activeScope: "all",
        companies,
        members: [],
      }),
    ).toBe("cmp_indigo");
  });

  it("when All, picks the single company every selected member shares", () => {
    expect(
      defaultChannelCompanyUid({
        activeScope: "all",
        companies,
        members: [stefan, yousuf, shawon],
      }),
    ).toBe("cmp_indigo");
  });

  it("keeps the active company when it is still valid for the members", () => {
    expect(
      defaultChannelCompanyUid({
        activeScope: "cmp_indigo",
        companies,
        members: [stefan, yousuf],
      }),
    ).toBe("cmp_indigo");
  });

  it("falls back to the shared company when the active scope is personal", () => {
    expect(
      defaultChannelCompanyUid({
        activeScope: "personal",
        companies,
        members: [stefan, yousuf, shawon],
      }),
    ).toBe("cmp_indigo");
  });
});

describe("member-driven scope filtering", () => {
  it("restricts In to companies every selected member belongs to", () => {
    expect(
      availableCompanyUids(companies, [stefan, yousuf, shawon]),
    ).toEqual(["cmp_indigo"]);
    expect(availableCompanyUids(companies, [stefan, caitlin])).toEqual([]);
    expect(
      unavailableChannelScopes(companies, [stefan, yousuf, shawon]).map(
        (row) => row.reason,
      ),
    ).toEqual(["Stefan Johnson isn't a member of LiveRecover"]);
  });

  it("keeps personal only for the owner and their agents", () => {
    const owner: ChannelCreateMember = {
      personUid: "prs_corey",
      label: "Corey",
      companyUids: [],
    };
    expect(personalScopeAllowed([agent], "prs_corey")).toBe(true);
    expect(personalScopeAllowed([owner], "prs_corey")).toBe(true);
    expect(personalScopeAllowed([stefan, yousuf, shawon], "prs_corey")).toBe(
      false,
    );
  });

  it("does not treat unknown memberships as a restriction", () => {
    expect(
      availableCompanyUids(companies, [
        { personUid: "prs_bob", label: "Bob", companyUids: [] },
      ]),
    ).toEqual(["cmp_indigo", "cmp_lr"]);
  });

  it("auto-selects away from a now-unavailable current scope", () => {
    expect(
      pickChannelCompanyUid({
        activeScope: "all",
        companies,
        members: [stefan, yousuf],
        currentUid: "",
      }),
    ).toBe("cmp_indigo");
  });
});

describe("channelCreateValidationMessage", () => {
  it("tells the owner to pick the shared company instead of personal", () => {
    expect(
      channelCreateValidationMessage({
        activeScope: "all",
        companies,
        members: [stefan, yousuf, shawon],
        companyUid: "",
      }),
    ).toBe("Stefan Johnson isn't a member of Personal — pick Indigo");
  });

  it("names the selected company the invitee is missing from", () => {
    expect(
      channelCreateValidationMessage({
        activeScope: "all",
        companies,
        members: [stefan],
        companyUid: "cmp_lr",
      }),
    ).toBe("Stefan Johnson isn't a member of LiveRecover — pick Indigo");
  });

  it("is silent when the selected company is valid", () => {
    expect(
      channelCreateValidationMessage({
        activeScope: "cmp_indigo",
        companies,
        members: [stefan, yousuf, shawon],
        companyUid: "cmp_indigo",
      }),
    ).toBeNull();
  });
});

describe("companyUidsByPerson", () => {
  it("unions DM rows and contacts", () => {
    const map = companyUidsByPerson(
      [
        {
          kind: "dm",
          personUid: "prs_stefan",
          companyUid: "cmp_indigo",
        },
      ],
      [{ personUid: "prs_stefan", companyUid: "cmp_lr" }],
    );
    expect(map.get("prs_stefan")?.sort()).toEqual(["cmp_indigo", "cmp_lr"]);
  });
});

describe("create failure lookup", () => {
  it("strips the invoke prefix from server errors", () => {
    expect(
      formatChannelCreateFailure(
        new Error("[invoke] You are not an active member of this company."),
      ),
    ).toBe("You are not an active member of this company.");
  });

  it("treats a matching directory/list name as created", () => {
    expect(
      channelExistsWithName("HQ Desktop Bugs", [
        { name: "#HQ Desktop Bugs" },
      ]),
    ).toBe(true);
    expect(channelExistsWithName("HQ Desktop Bugs", [{ name: "general" }])).toBe(
      false,
    );
    expect(
      channelExistsWithName(
        "HQ Desktop Bugs",
        directoryRowsFromFeed({
          snapshot: true,
          cursor: "c",
          cursorExpiresAt: "2099-01-01T00:00:00Z",
          rows: [{ channelId: "chn_x", name: "HQ Desktop Bugs", scope: "company", lastActivityAt: null }],
        }),
      ),
    ).toBe(true);
  });

  it("allows retry when nothing with that name exists", () => {
    expect(
      unconfirmedCreateMessage({
        detail: "You are not an active member of this company.",
        name: "HQ Desktop Bugs",
        exists: false,
      }),
    ).toContain("you can try again");
  });

  it("keeps retry disabled when a channel with that name now exists", () => {
    expect(
      unconfirmedCreateMessage({
        detail: "You are not an active member of this company.",
        name: "HQ Desktop Bugs",
        exists: true,
      }),
    ).toContain("retry is disabled");
  });
});
