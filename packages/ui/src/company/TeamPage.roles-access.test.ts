// @vitest-environment happy-dom
// OWNER-R9: Team shows real roles, join dates and the Self-serve badge from
// GET /membership/company/{uid}; the member pane shows Joined, Role, Groups and
// the files and secrets a teammate can reach (level and reason) from
// GET /files/{uid}/members/{personUid}/access; owners change roles with an
// explicit confirm, optimistic with rollback; members see no controls.
// Fixtures follow the hq-pro response shapes; every write is mocked.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import TeamPage from "./TeamPage.svelte";

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const CONTACTS = [
  { personUid: "prs_owner", displayName: "Olive Owner", email: "olive@example.com" },
  { personUid: "prs_ada", displayName: "Ada Lovelace", email: "ada@example.com" },
  { personUid: "prs_sam", displayName: "Sam Selfserve", email: "sam@example.com" },
];
const MEMBERSHIPS = {
  members: [
    { membershipKey: "mk_owner", personUid: "prs_owner", companyUid: "cmp_acme", role: "owner", status: "active", acceptedAt: "2026-01-15T10:00:00Z" },
    { membershipKey: "mk_ada", personUid: "prs_ada", companyUid: "cmp_acme", role: "admin", status: "active", acceptedAt: "2026-03-02T10:00:00Z" },
    { membershipKey: "mk_sam", personUid: "prs_sam", companyUid: "cmp_acme", role: "member", status: "active", acceptedAt: "2026-09-20T10:00:00Z", origin: "self-serve" },
  ],
};
const PENDING = { pending: [{ membershipKey: "email:new@example.com#cmp_acme", companyUid: "cmp_acme", role: "member", status: "pending", invitedAt: "2026-10-01T00:00:00Z", inviteeEmail: "new@example.com" }] };
const ACCESS = {
  companyUid: "cmp_acme",
  personUid: "prs_sam",
  targetRole: "member",
  identity: { primaryEmail: "sam@example.com", secondaryEmails: [], groups: [{ groupId: "grp_1", name: "Finance" }], isActiveMember: true },
  files: {
    roleBypass: false,
    grants: [
      { path: "knowledge/", permission: "read", sources: [{ via: "company-wide", permission: "read" }] },
      { path: "projects/agt_01KQZZZZZZZZZZZZZZZZZZZZZZ/notes/", permission: "write", sources: [{ via: "group", groupId: "grp_1", groupName: "Finance", permission: "write" }] },
    ],
  },
  secrets: { roleBypass: false, uncoveredOpenToMembers: true, grants: [] },
};

function mountTeam(opts: { self: string; setMemberRole?: () => Promise<unknown> }) {
  const company = {
    getTeamTelemetry: vi.fn(async () => ({ ok: false, reason: "network", message: "x" })),
    listMembers: vi.fn(async () => ({ ok: true, value: [] })),
    listCompanyMemberships: vi.fn(async () => ({ ok: true, value: MEMBERSHIPS })),
    listPendingMemberships: vi.fn(async () => ({ ok: true, value: PENDING })),
    getMemberAccess: vi.fn(async () => ({ ok: true, value: ACCESS })),
    setMemberRole: vi.fn(opts.setMemberRole ?? (async () => ({ ok: true, value: {} }))),
    revokeMembership: vi.fn(async () => ({ ok: true, value: {} })),
  };
  const messaging = { listContacts: vi.fn(async () => ({ ok: true, value: CONTACTS })) };
  component = mount(TeamPage, {
    target: document.body,
    props: { slug: `acme-${Math.random()}`, companyUid: "cmp_acme", company, messaging, selfUid: opts.self } as never,
  });
  return company;
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-member-id="${id}"]`)!;

describe("Team roles, joined and access (OWNER-R9)", () => {
  it("shows real roles and join dates, the Self-serve badge, and pending invites", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mountTeam({ self: "prs_owner" });
    await vi.waitFor(() => expect(row("prs_sam")?.textContent).toContain("Member"));
    expect(row("prs_owner").textContent).toContain("Owner");
    expect(row("prs_owner").textContent).toContain("Jan 2026");
    expect(row("prs_ada").textContent).toContain("Admin");
    expect(row("prs_sam").textContent).toContain("Self-serve");
    expect(document.querySelector('[data-testid="pending-invites"]')?.textContent).toContain("new@example.com");
  });

  it("the member pane lists groups and access with level and reason, bot ids as names", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mountTeam({ self: "prs_owner" });
    await vi.waitFor(() => expect(row("prs_sam")).toBeTruthy());
    document.querySelector<HTMLButtonElement>('[data-testid="team-open-prs_sam"]')!.click();
    flushSync();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="member-access-files"]')).not.toBeNull());
    const pane = document.querySelector('[data-testid="member-access"]')!.textContent ?? "";
    expect(pane).toContain("Sep 2026");
    expect(pane).toContain("Finance");
    expect(pane).toContain("knowledge/");
    expect(pane).toContain("shared company-wide");
    expect(pane).toContain("read + write");
    expect(pane).toContain("via Finance");
    expect(pane).not.toMatch(/agt_[A-Z0-9]{6,}/);
  });

  it("an owner changes a role only after confirming; a failed write rolls back with plain copy", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const company = mountTeam({ self: "prs_owner", setMemberRole: async () => ({ ok: false, reason: "http", message: "403" }) });
    await vi.waitFor(() => expect(row("prs_sam")?.textContent).toContain("Member"));
    document.querySelector<HTMLButtonElement>('[data-testid="team-menu-prs_sam"]')!.click();
    flushSync();
    document.querySelector<HTMLButtonElement>('[data-testid="team-role-admin"]')!.click();
    flushSync();
    expect(company.setMemberRole).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="team-role-confirm"]')?.textContent).toContain("Make Sam Selfserve an Admin?");
    document.querySelector<HTMLButtonElement>('[data-testid="team-role-confirm-yes"]')!.click();
    flushSync();
    expect(company.setMemberRole).toHaveBeenCalledWith("cmp_acme", "mk_sam", "admin");
    await vi.waitFor(() => expect(document.querySelector('[data-testid="team-action-note"]')?.textContent).toContain("Couldn't change Sam Selfserve's role"));
    expect(row("prs_sam").textContent).toContain("Member");
    expect(document.body.textContent).not.toMatch(/403/);
  });

  it("a member sees roles read-only with no row controls", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mountTeam({ self: "prs_sam" });
    await vi.waitFor(() => expect(row("prs_ada")?.textContent).toContain("Admin"));
    expect(document.querySelector('[data-testid^="team-menu-"]')).toBeNull();
    expect(document.querySelector('[data-testid^="revoke-"]')).toBeNull();
  });
});
