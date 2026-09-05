// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import TeamTab from "./TeamTab.svelte";
import CompanyTabs from "../CompanyTabs.svelte";
import { parseCompanyTab, type CompanyTabModel } from "./tab-model.js";
import type { CompanyChannelTabId } from "./tab-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function ownerTab(): CompanyTabModel {
  const parsed = parseCompanyTab({
    tab: "team",
    companyUid: "cmp_acme",
    viewer: { canAct: true, role: "owner" },
    sections: [
      {
        id: "humans",
        title: "Humans · 2",
        rows: [
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "team:human:prs_owner",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            fields: [
              { id: "name", label: "Name", control: "readonly", value: "Corey Epstein" },
              { id: "role", label: "Role", control: "readonly", value: "Owner" },
            ],
            actions: [],
            viewer: { canAct: true },
          },
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "team:human:prs_member",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            fields: [
              { id: "name", label: "Name", control: "readonly", value: "Jacob Posel" },
              {
                id: "role",
                label: "Role",
                control: "select",
                value: "member",
                options: [
                  { id: "owner", label: "Owner" },
                  { id: "member", label: "Member" },
                ],
              },
            ],
            actions: [{ id: "set_role", label: "Save", style: "secondary" }],
            viewer: { canAct: true },
          },
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "team:invite",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            fields: [
              { id: "email", label: "Invite by email", control: "text", value: "" },
              {
                id: "role",
                label: "Role",
                control: "select",
                value: "member",
                options: [{ id: "member", label: "Member" }],
              },
            ],
            actions: [{ id: "invite", label: "Invite", style: "primary" }],
            viewer: { canAct: true },
          },
        ],
      },
      {
        id: "agents",
        title: "Agents · 1",
        rows: [
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "team:agent:agt_polar",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            fields: [
              { id: "name", label: "Name", control: "readonly", value: "Polar" },
              { id: "size", label: "Size", control: "select", value: "basic" },
              { id: "provider", label: "Provider", control: "readonly", value: "Codex" },
              { id: "price", label: "Price", control: "readonly", value: "$100 / mo" },
            ],
            actions: [
              { id: "resize", label: "Resize", style: "secondary" },
              { id: "remove", label: "Remove", style: "secondary" },
            ],
            viewer: { canAct: true },
          },
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "team:spend",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            fields: [
              { id: "total", label: "Agent spend", control: "readonly", value: "$100 / mo" },
            ],
            actions: [{ id: "add_agent", label: "Add agent", style: "secondary" }],
            viewer: { canAct: true },
          },
        ],
      },
      {
        id: "permissions",
        title: "Permissions",
        rows: [
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "team:perm:createAgents",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            fields: [
              {
                id: "audience",
                label: "Who can create agents",
                control: "select",
                value: "owner_only",
                options: [
                  { id: "owner_only", label: "Owner only" },
                  { id: "everyone", label: "Everyone" },
                ],
              },
            ],
            actions: [{ id: "set_permission", label: "Save", style: "secondary" }],
            viewer: { canAct: true },
          },
        ],
      },
    ],
  });
  if (!parsed) throw new Error("fixture");
  return parsed;
}

function memberTab(): CompanyTabModel {
  const parsed = parseCompanyTab({
    tab: "team",
    companyUid: "cmp_acme",
    viewer: { canAct: false, role: "member" },
    sections: [
      {
        id: "humans",
        title: "Humans · 2",
        rows: [
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "team:human:prs_member",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            fields: [
              { id: "name", label: "Name", control: "readonly", value: "Jacob Posel" },
              { id: "role", label: "Role", control: "readonly", value: "Member" },
            ],
            actions: [],
            viewer: { canAct: false },
          },
        ],
      },
      {
        id: "agents",
        title: "Agents · 1",
        rows: [
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "team:agent:agt_polar",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            fields: [
              { id: "name", label: "Name", control: "readonly", value: "Polar" },
              { id: "size", label: "Size", control: "readonly", value: "small" },
            ],
            // The server may still describe the actions; a viewer who cannot
            // act must not see them rendered.
            actions: [
              { id: "remove", label: "Remove", style: "secondary" },
              { id: "save", label: "Save", style: "primary" },
            ],
            viewer: { canAct: false },
          },
        ],
      },
    ],
  });
  if (!parsed) throw new Error("fixture");
  return parsed;
}

describe("CompanyTabs", () => {
  it("switches Chat · Atlas · Team · Integrations · Settings", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    let active: CompanyChannelTabId = "chat";
    component = mount(CompanyTabs, {
      target: host,
      props: {
        active,
        onselect: (id: CompanyChannelTabId) => {
          active = id;
        },
      },
    });
    const labels = [...host.querySelectorAll(".company-tab")].map(
      (el) => el.textContent?.trim(),
    );
    expect(labels).toEqual([
      "Chat",
      "Atlas",
      "Team",
      "Integrations",
      "Settings",
    ]);
    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="company-tab-team"]')?.click(),
    );
    expect(active).toBe("team");
  });
});

describe("TeamTab sections", () => {
  it("renders humans, agents, and permissions for an owner", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(TeamTab, { target: host, props: { data: ownerTab() } });
    expect(host.querySelector('[data-testid="team-section-humans"]')?.textContent).toContain(
      "Humans · 2",
    );
    expect(host.querySelector('[data-testid="team-section-agents"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="team-section-permissions"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="team-field-team:invite-email"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-testid="team-field-team:human:prs_member-role"]'),
    ).not.toBeNull();
  });

  it("hides role selects and the invite row from a member", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(TeamTab, { target: host, props: { data: memberTab() } });
    expect(host.querySelector('[data-testid="team-row-team:invite"]')).toBeNull();
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector('[data-testid="team-action-team:invite-invite"]')).toBeNull();
  });

  it("renders no row action buttons when the viewer cannot act", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(TeamTab, { target: host, props: { data: memberTab() } });
    const rows = [...host.querySelectorAll('[data-testid^="team-row-"]')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.getAttribute("data-can-act")).toBe("false");
      expect([...row.querySelectorAll('button, [role="button"]')]).toEqual([]);
    }
    // Values stay visible even though the actions are gone.
    expect(
      host.querySelector('[data-testid="team-row-team:agent:agt_polar"]')?.textContent,
    ).toContain("Polar");
    expect(
      host.querySelector('[data-testid="team-action-team:agent:agt_polar-remove"]'),
    ).toBeNull();
  });

  it("requires a second click to remove an agent", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const seen: string[] = [];
    component = mount(TeamTab, {
      target: host,
      props: {
        data: ownerTab(),
        onaction: (event) => seen.push(event.actionId),
      },
    });
    const btn = host.querySelector<HTMLButtonElement>(
      '[data-testid="team-action-team:agent:agt_polar-remove"]',
    );
    flushSync(() => btn?.click());
    expect(seen).toEqual([]);
    expect(btn?.textContent).toContain("Confirm remove");
    flushSync(() => btn?.click());
    expect(seen).toEqual(["remove"]);
  });
});
