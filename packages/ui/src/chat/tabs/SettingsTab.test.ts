// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import SettingsTab from "./SettingsTab.svelte";
import CompanyHero from "../CompanyHero.svelte";
import { parseCompanyTab } from "./tab-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function ownerSettings() {
  const parsed = parseCompanyTab({
    tab: "settings",
    companyUid: "cmp_acme",
    viewer: { canAct: true, role: "owner" },
    appearance: { name: "Ramen Bae", wallpaper: "easel" },
    sections: [
      {
        id: "general",
        title: "General",
        rows: [
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "set:name",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            fields: [
              { id: "name", label: "Name", control: "text", value: "Ramen Bae" },
            ],
            actions: [{ id: "save", label: "Edit", style: "secondary" }],
            viewer: { canAct: true },
          },
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "set:wallpaper",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            fields: [
              {
                id: "wallpaper",
                label: "Wallpaper",
                control: "select",
                value: "easel",
                options: [
                  { id: "aurora", label: "Aurora" },
                  { id: "easel", label: "Artist's easel" },
                ],
              },
            ],
            actions: [{ id: "save", label: "Change", style: "secondary" }],
            viewer: { canAct: true },
          },
        ],
      },
      {
        id: "danger",
        title: "Danger zone",
        rows: [
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "set:delete",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            fields: [
              {
                id: "confirm",
                label: "Type Ramen Bae to delete",
                control: "text",
                value: "",
              },
            ],
            actions: [{ id: "delete", label: "Delete…", style: "secondary" }],
            viewer: { canAct: true },
          },
        ],
      },
    ],
  });
  if (!parsed) throw new Error("fixture");
  return parsed;
}

function memberSettings() {
  const parsed = parseCompanyTab({
    tab: "settings",
    companyUid: "cmp_acme",
    viewer: { canAct: false, role: "member" },
    sections: [
      {
        id: "general",
        title: "General",
        rows: [
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "set:name",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            fields: [
              { id: "name", label: "Name", control: "readonly", value: "Ramen Bae" },
            ],
            actions: [],
            viewer: { canAct: false },
          },
        ],
      },
    ],
  });
  if (!parsed) throw new Error("fixture");
  return parsed;
}

describe("SettingsTab", () => {
  it("shows general and danger zone for an owner", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SettingsTab, { target: host, props: { data: ownerSettings() } });
    expect(host.querySelector('[data-testid="company-tab-settings"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="team-section-general"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="team-section-danger"]')).not.toBeNull();
    expect(host.querySelector("select")).not.toBeNull();
  });

  it("hides danger zone and edits from a member", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SettingsTab, { target: host, props: { data: memberSettings() } });
    expect(host.querySelector('[data-testid="team-section-danger"]')).toBeNull();
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector("input")).toBeNull();
  });

  it("requires a second click to delete", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const seen: string[] = [];
    component = mount(SettingsTab, {
      target: host,
      props: {
        data: ownerSettings(),
        onaction: (event) => seen.push(event.actionId),
      },
    });
    const btn = host.querySelector<HTMLButtonElement>(
      '[data-testid="team-action-set:delete-delete"]',
    );
    flushSync(() => btn?.click());
    expect(seen).toEqual([]);
    flushSync(() => btn?.click());
    expect(seen).toEqual(["delete"]);
  });
});

describe("CompanyHero", () => {
  it("stamps the wallpaper id on the company channel hero", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(CompanyHero, {
      target: host,
      props: { title: "Ramen Bae", wallpaper: "easel" },
    });
    const hero = host.querySelector('[data-testid="company-hero"]');
    expect(hero?.getAttribute("data-wallpaper")).toBe("easel");
    expect(hero?.textContent).toContain("Ramen Bae");
    expect(hero?.textContent).toContain("Artist's easel");
  });
});
