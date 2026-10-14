// @vitest-environment happy-dom

// Owner asks (2026-10-06): Knowledge, Policies, Skills and Workers share one
// master-detail layout. The list is as narrow as the sidebar, resizable and
// remembered per page; the detail renders the document under a header card.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok } from "@hq/platform";
import BrainPage from "./BrainPage.svelte";
import { listWidthKey } from "./brain-layout.js";

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

const slug = "layout-co";
const policyPath = `companies/${slug}/policies/deploy-gate.md`;
const POLICY = "---\ntitle: Deploy gate\nenforcement: hard\nwhen: deploy, release\ntags: [security]\n---\n# Rule\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";

function filesFor(entries: Record<string, string>) {
  return {
    listDir: vi.fn(async (dir: string) =>
      ok(
        Object.keys(entries)
          .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
          .map((p) => ({ name: p.split("/").pop()!, path: p, isDir: false })),
      ),
    ),
    getFileContent: vi.fn(async (p: string) => ok(entries[p] ?? "")),
  };
}

async function mountPolicies() {
  component = mount(BrainPage, {
    target: document.body,
    props: { page: "policies", slug, files: filesFor({ [policyPath]: POLICY }) as never, library: null, shell: null, settings: null },
  });
  await vi.waitFor(() => {
    flushSync();
    expect(document.querySelectorAll("[data-testid='policy-row']").length).toBe(1);
  });
}

describe("Brain master-detail layout", () => {
  it("starts the list at the sidebar's width and saves a resize for this page only", async () => {
    localStorage.setItem("hq.sidebar.width", "280");
    await mountPolicies();
    const split = document.querySelector("[data-testid='brain-split']") as HTMLElement;
    expect(split.style.getPropertyValue("--brain-list-width")).toBe("280px");

    const handle = document.querySelector("[data-testid='brain-split-handle']") as HTMLElement;
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    flushSync();
    expect(split.style.getPropertyValue("--brain-list-width")).toBe("290px");
    expect(localStorage.getItem(listWidthKey("policies"))).toBe("290");
    expect(localStorage.getItem(listWidthKey("knowledge"))).toBeNull();
  });

  it("policy rows show enforcement and scope chips and when tags, not the file path", async () => {
    await mountPolicies();
    const row = document.querySelector("[data-testid='policy-row']") as HTMLElement;
    const chips = [...row.querySelectorAll("[data-testid='brain-chip']")];
    expect(chips.map((c) => c.textContent?.trim())).toEqual(["hard", "company", "deploy"]);
    expect(row.querySelector(".more")?.textContent).toBe("+1");
    expect(chips[0]!.getAttribute("data-tone")).toBe("hard");
    expect(chips[2]!.querySelector("svg")).toBeTruthy();
    expect(row.textContent).not.toContain(policyPath);
  });

  it("the detail is a header card plus rendered markdown, with no raw frontmatter", async () => {
    await mountPolicies();
    (document.querySelector("[data-testid='policy-row']") as HTMLButtonElement).click();
    flushSync();
    const header = document.querySelector("[data-testid='brain-doc-header']") as HTMLElement;
    expect(header.querySelector("h2")?.textContent).toBe("Deploy gate");
    expect(header.querySelector("[data-testid='brain-doc-path']")?.textContent).toBe(policyPath);
    const tags = [...header.querySelectorAll("[data-testid='brain-doc-tags'] [data-testid='brain-chip']")];
    expect(tags.map((t) => t.textContent?.trim())).toEqual(["deploy", "release", "security"]);
    const body = document.querySelector("[data-testid='brain-doc-body']") as HTMLElement;
    expect(body.querySelector("h1")?.textContent).toBe("Rule");
    expect(body.querySelectorAll("li")).toHaveLength(2);
    expect(body.querySelector("table")).toBeTruthy();
    expect(document.querySelector("[data-testid='brain-detail']")?.textContent).not.toContain("enforcement: hard");
    expect(document.querySelector("[data-testid='brain-detail']")?.textContent).not.toContain("---");
  });
});
