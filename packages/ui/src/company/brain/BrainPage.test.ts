// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok, unavailable } from "@hq/platform";
import BrainPage from "./BrainPage.svelte";

const openAgentWorkflow = vi.hoisted(() => vi.fn(async () => ({
  outcome: "opened" as const,
  ok: true,
  message: "Opened the standup-brief in Claude Code.",
})));

vi.mock("../agent-workflow.js", () => ({
  openAgentWorkflow,
}));

describe("US-028 BrainPage", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    openAgentWorkflow.mockClear();
  });

  it("opens Claude Code with the skill prefilled when Run is clicked", async () => {
    const library = {
      getCompany: vi.fn(async () => ok({
        workers: [],
        skills: [{
          name: "standup-brief",
          description: "Daily brief",
          scope: "company",
          company: "indigo",
          path: "companies/indigo/skills/standup-brief/SKILL.md",
          allowedTools: [],
        }],
      })),
    };
    const shell = {
      openClaudeCodeLink: vi.fn(async () => ok(undefined)),
      openInEditor: vi.fn(async () => ok(undefined)),
      openFileInClaude: vi.fn(async () => ok(undefined)),
    };
    const settings = { getConfig: vi.fn(async () => ok({ hqFolderPath: "/tmp/hq" })) };
    component = mount(BrainPage, {
      target: document.body,
      props: {
        page: "skills",
        slug: "indigo",
        files: null,
        library: library as never,
        shell: shell as never,
        settings: settings as never,
      },
    });
    await vi.waitFor(() => {
      expect(document.querySelector("[data-testid='skill-run']")).toBeTruthy();
    });
    flushSync();
    (document.querySelector("[data-testid='skill-run']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(openAgentWorkflow).toHaveBeenCalled();
    });
    const calls = openAgentWorkflow.mock.calls as unknown as unknown[][];
    expect(calls[0]?.[1]).toBe("/standup-brief");
  });

  it("paints a shimmer before the listing arrives", () => {
    const library = { getCompany: vi.fn(() => new Promise(() => undefined)) };
    component = mount(BrainPage, {
      target: document.body,
      props: {
        page: "skills",
        slug: "fresh-co",
        files: null,
        library: library as never,
        shell: null,
        settings: null,
      },
    });
    expect(document.querySelector("[data-testid='brain-shimmer']")).toBeTruthy();
  });

  it("QA-009: binds the company read scope before listing policies, and counts every real policy", async () => {
    // Mirrors the native gate: company paths are refused until the session's
    // active company is bound to that slug.
    let bound: string | null = null;
    const root = "companies/qa009-co/policies";
    const entry = (name: string, isDir = false) => ({ name, path: `${root}/${name}`, isDir, hasChildren: isDir });
    const tree: Record<string, ReturnType<typeof entry>[]> = {
      [root]: [
        entry("_archive", true),
        entry("_digest.md"),
        entry("a.md"),
        entry("b.md"),
        entry("c.md"),
        entry("c 2.md"),
        entry("c.conflict-2026-09-01T00-00-00Z-abc.md"),
      ],
    };
    const gated = (path: string) => bound !== null && path.startsWith(`companies/${bound}/`);
    const files = {
      listDir: vi.fn(async (path: string) => {
        if (!gated(path)) return unavailable("scope", "company scope not bound");
        return ok(tree[path] ?? []);
      }),
      getFileContent: vi.fn(async (path: string) => {
        if (!gated(path)) return unavailable("scope", "company scope not bound");
        const hard = path.endsWith("/a.md") || path.endsWith("/b.md");
        return ok(`---\ntitle: ${path}\nenforcement: ${hard ? "hard" : "soft"}\n---\nbody`);
      }),
    };
    const appShell = {
      setActiveCompany: vi.fn(async (slug: string) => {
        bound = slug;
        return ok(undefined);
      }),
    };
    component = mount(BrainPage, {
      target: document.body,
      props: {
        page: "policies",
        slug: "qa009-co",
        files: files as never,
        library: null,
        shell: null,
        settings: null,
        appShell,
      },
    });
    await vi.waitFor(() => {
      expect(document.querySelector("[data-testid='brain-page']")?.getAttribute("data-phase")).toBe("ready");
    });
    flushSync();
    expect(appShell.setActiveCompany).toHaveBeenCalledWith("qa009-co");
    expect(document.body.textContent).toContain("2 hard · 1 soft");
  });

  it("QA-010: the worker count, the collapsed list and the full list agree", async () => {
    const workers = Array.from({ length: 27 }, (_, i) => ({
      id: `w${i}`,
      name: `Worker ${i}`,
      type: "general",
      description: "",
      scope: "company" as const,
      company: "qa010-co",
      status: i === 3 ? "parked" : "ready",
      path: `workers/w${i}/worker.yaml`,
    }));
    const library = { getCompany: vi.fn(async () => ok({ workers, skills: [] })) };
    component = mount(BrainPage, {
      target: document.body,
      props: {
        page: "workers",
        slug: "qa010-co",
        files: null,
        library: library as never,
        shell: null,
        settings: null,
      },
    });
    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-testid='worker-row']").length).toBeGreaterThan(0);
    });
    flushSync();
    const chip = document.querySelector("[data-testid='brain-worker-count']")?.textContent ?? "";
    expect(chip).toBe("27 workers");
    expect(document.querySelectorAll("[data-testid='worker-row']").length).toBe(27);
  });
});
