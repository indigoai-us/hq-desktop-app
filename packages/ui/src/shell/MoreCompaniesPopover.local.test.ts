// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import MoreCompaniesPopover from "./MoreCompaniesPopover.svelte";
import { localCompanyKey, moreCompaniesSections, type MoreCompany } from "./more-companies.js";
import { localOnlyCompaniesFromRows } from "../company/company-display-map.js";

// `list_syncable_workspaces` rows: the host unions the local manifest and
// company folders with cloud memberships.
const rows = [
  { kind: "personal", state: "personal", slug: "personal", displayName: "Me", cloudUid: "prs_me" },
  { kind: "company", state: "synced", slug: "indigo", displayName: "Indigo", cloudUid: "cmp_in" },
  { kind: "company", state: "local-only", slug: "lyons-sauna", displayName: "Lyons Sauna", cloudUid: null },
  { kind: "company", state: "local-only", slug: "lyons-sauna", displayName: "Lyons Sauna", cloudUid: null },
  { kind: "company", state: "local-only", slug: "_template", displayName: "_template", cloudUid: null },
  { kind: "company", state: "local-only", slug: "old-co", displayName: "Old", cloudUid: null, archived: true },
  { kind: "company", state: "local-only", slug: "indigo", displayName: "Indigo", cloudUid: null },
];

function switcherList(): MoreCompany[] {
  const cloud: MoreCompany[] = [
    { uid: "cmp_in", name: "Indigo", slug: "indigo", liveCount: 0 },
    { uid: "cmp_ac", name: "Acme", slug: "acme", liveCount: 0 },
  ];
  const cloudSlugs = new Set(cloud.map((c) => c.slug));
  const local = localOnlyCompaniesFromRows(rows)
    .filter((c) => !cloudSlugs.has(c.slug))
    .map((c) => ({
      uid: localCompanyKey(c.slug),
      name: c.name,
      slug: c.slug,
      liveCount: 0,
      localOnly: true,
    }));
  return [...cloud, ...local];
}

describe("local-only companies in the company switcher", () => {
  it("reads each local-only company once and skips _template and archived", () => {
    const local = localOnlyCompaniesFromRows(rows);
    expect(local.map((c) => c.slug)).toEqual(["lyons-sauna", "indigo"]);
    expect(local.some((c) => c.slug === "_template")).toBe(false);
    expect(local.some((c) => c.slug === "old-co")).toBe(false);
  });

  it("coerces a non-array payload to no companies", () => {
    expect(localOnlyCompaniesFromRows(null)).toEqual([]);
    expect(localOnlyCompaniesFromRows({ workspaces: "nope" })).toEqual([]);
  });

  it("lists a company in both places once, without the tag", () => {
    const list = switcherList();
    expect(list.filter((c) => c.slug === "indigo")).toHaveLength(1);
    expect(list.find((c) => c.slug === "indigo")?.localOnly).toBeUndefined();
    expect(list.filter((c) => c.slug === "lyons-sauna")).toHaveLength(1);
  });

  it("sorts local-only companies in by name and search finds them", () => {
    const all = moreCompaniesSections(switcherList(), [], []).all;
    expect(all.map((c) => c.name)).toEqual(["Acme", "Indigo", "Lyons Sauna"]);
    const hit = moreCompaniesSections(switcherList(), [], [], "lyons");
    expect(hit.all.map((c) => c.slug)).toEqual(["lyons-sauna"]);
    expect(hit.matchCount).toBe(1);
  });

  it("the shell merges local companies by cloud slug, never as a tenant id", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/shell/DesktopApp.svelte"), "utf8");
    const at = shell.indexOf("const moreCompanyList = $derived.by(");
    const block = shell.slice(at, at + 1400);
    expect(block).toContain("localCompanies");
    expect(block).toContain("!cloudSlugs.has(c.slug.toLowerCase())");
    expect(block).toContain("uid: localCompanyKey(c.slug)");
  });
});

describe("MoreCompaniesPopover local row", () => {
  let host: HTMLDivElement;
  let component: ReturnType<typeof mount> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    host?.remove();
  });

  it("shows the local-only company once with a muted tag and no switch", async () => {
    const opened: string[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MoreCompaniesPopover, {
      target: host,
      props: {
        companies: switcherList(),
        pinnedIds: [],
        recentIds: [],
        onopen: (c: MoreCompany) => opened.push(c.uid),
      },
    });
    await tick();
    const localRows = host.querySelectorAll('[data-testid="more-local-company"]');
    expect(localRows).toHaveLength(1);
    const row = localRows[0] as HTMLElement;
    expect(row.textContent).toContain("Lyons Sauna");
    expect(row.querySelector(".local-tag")?.textContent).toBe("Local, not synced");
    expect(row.querySelector("button")).toBeNull();
    (row.querySelector(".row") as HTMLElement).click();
    expect(opened).toEqual([]);
    // The synced company has no tag.
    const tags = host.querySelectorAll(".local-tag");
    expect(tags).toHaveLength(1);
    expect(host.textContent).not.toContain("_template");
  });

  it("search finds the local-only company", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MoreCompaniesPopover, {
      target: host,
      props: { companies: switcherList(), pinnedIds: [], recentIds: [] },
    });
    await tick();
    const input = host.querySelector("input.search") as HTMLInputElement;
    input.value = "sauna";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    const list = host.querySelector('[data-testid="more-companies-list"]') as HTMLElement;
    expect(list.querySelectorAll('[data-testid="more-local-company"]')).toHaveLength(1);
    expect(list.textContent).not.toContain("Acme");
  });
});
