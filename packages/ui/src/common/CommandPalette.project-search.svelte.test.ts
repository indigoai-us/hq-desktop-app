// @vitest-environment happy-dom

// QA-079: a project listed on the Projects page is found in Cmd+K by display
// name and by id, in the company scope and in All companies, and the
// "Create project" offer only appears when nothing matches.
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import CommandPalette from "./CommandPalette.svelte";
import { paletteProjectItems } from "../shell/palette-rows.js";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

const companies = [
  { slug: "acme", companyUid: "cmp_acme", label: "Acme" },
  { slug: "globex", companyUid: "cmp_globex", label: "Globex" },
];

const projects = [
  {
    id: "acme-band-site",
    name: "Band Website",
    company: "acme",
    prdPath: "projects/acme-band-folder/prd.json",
  },
];

function commands() {
  return paletteProjectItems(projects, companies).map((item) => ({
    id: item.id,
    label: item.label,
    detail: item.detail,
    keywords: item.keywords,
    section: item.section,
    companyUid: item.companyUid,
    personal: item.personal,
    action: () => {},
  }));
}

function render(companyUid: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CommandPalette, {
    target: host,
    props: {
      commands: commands(),
      onclose: () => {},
      companyName: "Acme",
      companyUid,
    },
  });
  flushSync();
  return host;
}

function type(host: HTMLElement, text: string) {
  const input = host.querySelector("input") as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function chooseScope(host: HTMLElement, label: string) {
  const chip = Array.from(
    host.querySelectorAll<HTMLButtonElement>(".scope-chips button"),
  ).find((b) => b.textContent?.trim() === label);
  expect(chip).toBeDefined();
  chip?.click();
  flushSync();
}

function optionText(host: HTMLElement): string {
  return Array.from(host.querySelectorAll('button[role="option"]'))
    .map((b) => b.textContent ?? "")
    .join("\n");
}

describe("CommandPalette project search (QA-079)", () => {
  for (const query of ["Band Website", "acme-band-site", "acme-band-folder"]) {
    it(`finds the project by "${query}" in the company scope`, () => {
      const host = render("cmp_acme");
      type(host, query);
      expect(optionText(host)).toContain("Band Website");
      expect(optionText(host)).not.toContain("Project “");
    });

    it(`finds the project by "${query}" in All companies`, () => {
      const host = render("cmp_globex");
      chooseScope(host, "All companies");
      type(host, query);
      expect(optionText(host)).toContain("Band Website");
      expect(optionText(host)).not.toContain("Project “");
    });
  }

  it("keeps another company's project out of the company scope", () => {
    const host = render("cmp_globex");
    type(host, "Band Website");
    expect(optionText(host)).not.toContain("Acme · project");
  });

  it("offers Create project only when no project matches", () => {
    const host = render("cmp_acme");
    type(host, "zzqqxx nothing");
    expect(optionText(host)).toContain("Project “zzqqxx nothing”");
  });

  it("skips projects from companies the user is not a member of", () => {
    const items = paletteProjectItems(
      [{ id: "x", name: "Hidden", company: "stranger", prdPath: "" }],
      companies,
    );
    expect(items).toEqual([]);
  });
});
