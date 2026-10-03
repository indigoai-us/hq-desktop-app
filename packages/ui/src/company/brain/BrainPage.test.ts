// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok, unavailable } from "@hq/platform";
import BrainPage from "./BrainPage.svelte";
import { emptyBrainCache, knowledgeFromFile, writeBrainCache } from "./brain-model.js";

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

  it("QA-056: knowledge list rows show wiki-link aliases, not raw link syntax", async () => {
    const root = "companies/qa056-co/knowledge";
    const files = {
      listDir: vi.fn(async (path: string) =>
        ok(path === root ? [{ name: "agi.md", path: `${root}/agi.md`, isDir: false, hasChildren: false }] : []),
      ),
      getFileContent: vi.fn(async () =>
        ok(
          "---\ntitle: Build Your Own AGI — Print [[ontology/entities/project/content-production-workflow|Production Pipeline]]\n---\nbody",
        ),
      ),
    };
    component = mount(BrainPage, {
      target: document.body,
      props: {
        page: "knowledge",
        slug: "qa056-co",
        files: files as never,
        library: null,
        shell: null,
        settings: null,
      },
    });
    await vi.waitFor(() => {
      expect(document.querySelector("[data-testid='brain-page'] .item .name")).toBeTruthy();
    });
    flushSync();
    const name = document.querySelector("[data-testid='brain-page'] .item .name")?.textContent;
    expect(name).toBe("Build Your Own AGI — Print Production Pipeline");
    expect(document.body.textContent).not.toContain("[[");
  });

  it("QA-058: a knowledge search with no hits says no matches, keeps the total, and clears", async () => {
    const root = "companies/qa058-co/knowledge";
    const names = ["alpha.md", "beta.md", "gamma.md"];
    const files = {
      listDir: vi.fn(async (path: string) =>
        ok(path === root ? names.map((name) => ({ name, path: `${root}/${name}`, isDir: false, hasChildren: false })) : []),
      ),
      getFileContent: vi.fn(async () => ok("body")),
    };
    component = mount(BrainPage, {
      target: document.body,
      props: { page: "knowledge", slug: "qa058-co", files: files as never, library: null, shell: null, settings: null },
    });
    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-testid='brain-list'] .item").length).toBe(3);
    });
    const search = document.querySelector("[data-testid='brain-page'] input.search") as HTMLInputElement;
    search.value = "zzz-no-such-file";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    const empty = document.querySelector("[data-testid='brain-empty']") as HTMLElement;
    expect(empty.dataset.kind).toBe("no-matches");
    expect(empty.textContent).toContain("No matches for 'zzz-no-such-file'");
    expect(empty.textContent).toContain("3 files");
    expect(document.body.textContent).not.toContain("listing yet");
    (document.querySelector("[data-testid='brain-empty-clear']") as HTMLButtonElement).click();
    flushSync();
    expect(document.querySelectorAll("[data-testid='brain-list'] .item").length).toBe(3);
    expect(document.querySelector("[data-testid='brain-empty']")).toBeNull();
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
  it("QA-034: Escape in the worker skill picker returns to New worker", async () => {
    const library = { getCompany: vi.fn(async () => ok({ workers: [], skills: [] })) };
    component = mount(BrainPage, {
      target: document.body,
      props: { page: "workers", slug: "qa034-co", files: null, library: library as never, shell: null, settings: null },
    });
    await vi.waitFor(() => {
      expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.includes("New worker"))).toBe(true);
    });
    const click = (label: string) => {
      const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes(label));
      expect(button, label).toBeTruthy();
      button!.click();
      flushSync();
    };
    const escape = () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      flushSync();
    };
    const sheetLabel = () => document.querySelector("[data-testid='brain-sheet']")?.getAttribute("aria-label") ?? null;
    click("New worker");
    expect(sheetLabel()).toBe("New worker");
    click("Pick skills");
    expect(sheetLabel()).toBe("Skill picker");
    escape();
    expect(sheetLabel()).toBe("New worker");
    escape();
    expect(sheetLabel()).toBeNull();
  });

  describe("QA-100 knowledge load states", () => {
    const root = (slug: string) => `companies/${slug}/knowledge`;
    const mountKnowledge = (slug: string, files: unknown) => {
      component = mount(BrainPage, {
        target: document.body,
        props: { page: "knowledge", slug, files: files as never, library: null, shell: null, settings: null },
      });
      flushSync();
    };
    const count = () => document.querySelector("[data-testid='brain-knowledge-count']")?.textContent ?? null;
    const pending = { listDir: vi.fn(() => new Promise(() => undefined)), getFileContent: vi.fn(() => new Promise(() => undefined)) };

    it("loading with no cache shows a skeleton with a reading line and no count", () => {
      mountKnowledge("qa100-cold", pending);
      expect(document.querySelector("[data-testid='brain-shimmer']")).toBeTruthy();
      expect(document.body.textContent).toContain("Reading files…");
      expect(count()).toBeNull();
      expect(document.body.textContent).not.toContain("0 files");
    });

    it("loading with a cache shows the cached rows and cached count", () => {
      const cached = emptyBrainCache();
      cached.knowledge = [knowledgeFromFile(`${root("qa100-warm")}/a.md`, "# Alpha"), knowledgeFromFile(`${root("qa100-warm")}/b.md`, "# Beta")];
      writeBrainCache("qa100-warm", cached);
      mountKnowledge("qa100-warm", pending);
      expect(document.querySelector("[data-testid='brain-shimmer']")).toBeNull();
      expect(count()).toBe("2 files");
      expect(document.querySelectorAll("[data-testid='brain-list'] .item")).toHaveLength(2);
    });

    it("loaded and empty shows the empty state with a zero count", async () => {
      mountKnowledge("qa100-empty", { listDir: vi.fn(async () => ok([])), getFileContent: vi.fn(async () => ok("")) });
      await vi.waitFor(() => expect(count()).toBe("0 files"));
      expect(document.body.textContent).toContain("No knowledge files yet.");
      expect(document.querySelector("[data-testid='brain-shimmer']")).toBeNull();
    });

    it("loaded shows the rows", async () => {
      const dir = root("qa100-full");
      mountKnowledge("qa100-full", {
        listDir: vi.fn(async (path: string) => ok(path === dir ? [{ name: "a.md", path: `${dir}/a.md`, isDir: false, hasChildren: false }] : [])),
        getFileContent: vi.fn(async () => ok("# Alpha")),
      });
      await vi.waitFor(() => expect(count()).toBe("1 file"));
      expect(document.querySelectorAll("[data-testid='brain-list'] .item")).toHaveLength(1);
    });
  });
});
