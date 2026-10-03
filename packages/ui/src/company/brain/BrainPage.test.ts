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

  it("paints the loader before the listing arrives", () => {
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
    expect(document.querySelector("[data-testid='brain-loading']")).toBeTruthy();
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
      expect(document.querySelector("[data-testid='brain-knowledge-count']")).toBeTruthy();
    });
    flushSync();
    (Array.from(document.querySelectorAll("[data-testid='brain-page'] .tab")).find((b) => b.textContent === "What's fresh") as HTMLButtonElement).click();
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
      expect(document.querySelector("[data-testid='brain-knowledge-count']")?.textContent).toBe("3 files");
    });
    flushSync();
    (Array.from(document.querySelectorAll("[data-testid='brain-page'] .tab")).find((b) => b.textContent === "What's fresh") as HTMLButtonElement).click();
    flushSync();
    expect(document.querySelectorAll("[data-testid='brain-list'] .item").length).toBe(3);
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

  it("QA-102: a skill search with no matches clears the old skill's inspector and its actions", async () => {
    const skill = (name: string) => ({
      name,
      description: `${name} skill`,
      scope: "company",
      company: "qa102-co",
      path: `companies/qa102-co/skills/${name}/SKILL.md`,
      allowedTools: [],
    });
    const library = {
      getCompany: vi.fn(async () => ok({ workers: [], skills: [skill("memo-draft"), skill("daily-brief")] })),
    };
    component = mount(BrainPage, {
      target: document.body,
      props: { page: "skills", slug: "qa102-co", files: null, library: library as never, shell: null, settings: null },
    });
    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-testid='skill-row']").length).toBe(2);
    });
    const rows = [...document.querySelectorAll<HTMLButtonElement>("[data-testid='skill-row']")];
    rows.find((row) => row.textContent?.includes("memo-draft"))!.click();
    flushSync();
    const detail = () => document.querySelector("[data-testid='brain-detail']") as HTMLElement;
    expect(detail().textContent).toContain("memo-draft");
    expect(document.querySelector("[data-testid='skill-run']")).toBeTruthy();

    const search = document.querySelector("[data-testid='brain-page'] input.search") as HTMLInputElement;
    search.value = "qa-no-match";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(detail().textContent).not.toContain("memo-draft");
    expect(document.querySelector("[data-testid='skill-run']")).toBeNull();
    const empty = document.querySelector("[data-testid='brain-detail-empty']") as HTMLElement;
    expect(empty.textContent).toContain("No skills match “qa-no-match”");
    (empty.querySelector("button") as HTMLButtonElement).click();
    flushSync();
    expect(search.value).toBe("");
    expect(document.querySelectorAll("[data-testid='skill-row']").length).toBe(2);
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

    it("loading with no cache shows the loader with a reading line and no count", () => {
      mountKnowledge("qa100-cold", pending);
      expect(document.querySelector("[data-testid='brain-loading']")).toBeTruthy();
      expect(document.body.textContent).toContain("Reading files…");
      expect(count()).toBeNull();
      expect(document.body.textContent).not.toContain("0 files");
    });

    it("loading with a cache shows the cached rows and cached count", async () => {
      const cached = emptyBrainCache();
      cached.knowledge = [knowledgeFromFile(`${root("qa100-warm")}/a.md`, "# Alpha"), knowledgeFromFile(`${root("qa100-warm")}/b.md`, "# Beta")];
      writeBrainCache("qa100-warm", cached);
      mountKnowledge("qa100-warm", pending);
      expect(document.querySelector("[data-testid='brain-loading']")).toBeNull();
      expect(count()).toBe("2 files");
      await vi.waitFor(() => expect(document.querySelectorAll("[data-testid='vault-tree-row']")).toHaveLength(2));
    });

    it("loaded and empty shows the empty state with a zero count", async () => {
      mountKnowledge("qa100-empty", { listDir: vi.fn(async () => ok([])), getFileContent: vi.fn(async () => ok("")) });
      await vi.waitFor(() => expect(count()).toBe("0 files"));
      expect(document.body.textContent).toContain("No knowledge files yet.");
      expect(document.querySelector("[data-testid='brain-loading']")).toBeNull();
    });

    it("loaded shows the rows", async () => {
      const dir = root("qa100-full");
      mountKnowledge("qa100-full", {
        listDir: vi.fn(async (path: string) => ok(path === dir ? [{ name: "a.md", path: `${dir}/a.md`, isDir: false, hasChildren: false }] : [])),
        getFileContent: vi.fn(async () => ok("# Alpha")),
      });
      await vi.waitFor(() => expect(count()).toBe("1 file"));
      await vi.waitFor(() => expect(document.querySelectorAll("[data-testid='vault-tree-row']")).toHaveLength(1));
    });
  });

  it("AUDIT-3: a failed file read offers Try again and clears once the read works", async () => {
    let fail = true;
    const files = {
      listDir: vi.fn(async () => (fail ? unavailable("io") : ok([]))),
      getFileContent: vi.fn(async () => ok("")),
    };
    component = mount(BrainPage, {
      target: document.body,
      props: { page: "knowledge", slug: "acme-retry", files: files as never, library: null, shell: null, settings: null },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector("[data-testid='brain-read-error']")?.textContent).toContain("Some company files could not be read.");
    });
    fail = false;
    (document.querySelector("[data-testid='brain-retry']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector("[data-testid='brain-read-error']")).toBeNull();
    });
  });

  it.each([["policies", "No policies yet."], ["skills", "No skills yet."], ["workers", "No workers yet."]] as const)(
    "AUDIT-3: an empty %s page says so plainly",
    async (page, copy) => {
      component = mount(BrainPage, {
        target: document.body,
        props: { page, slug: `empty-${page}`, files: null, library: null, shell: null, settings: null },
      });
      await vi.waitFor(() => {
        flushSync();
        expect(document.querySelector("[data-testid='brain-empty']")?.textContent).toContain(copy);
      });
      expect(document.body.textContent).not.toContain("listing");
    },
  );

  /**
   * OWNER-R10: Browse tree rendered the same flat title-and-path list as
   * What's fresh (the tree lens fell through to the generic list). Paths
   * below are the real shapes from the Indigo knowledge folder with names
   * replaced.
   */
  describe("OWNER-R10 Browse tree", () => {
    const slug = "r10-co";
    const root = ["companies", slug, "knowledge"].join("/");
    const paths = [
      `${root}/_archive/2026-09-23-garden/old-note.md`,
      `${root}/_archive/2026-09-23-garden/old-note.conflict-2026-09-23T10-00-00Z-abc123.md`,
      `${root}/gtm/pricing.md`,
      `${root}/gtm/accounts/acme.md`,
      `${root}/readme.md`,
    ];
    const bodies: Record<string, string> = {
      [`${root}/readme.md`]: "---\ntitle: Readme\nupdated: 2026-09-01\n---\nhello",
      [`${root}/gtm/pricing.md`]: "---\ntitle: Pricing\nupdated: 2026-10-02\n---\nprice list",
      [`${root}/gtm/accounts/acme.md`]: "---\ntitle: Acme\ndate: 2026-09-15\n---\naccount",
      [`${root}/_archive/2026-09-23-garden/old-note.md`]: "---\ntitle: Old note\n---\narchived",
      [`${root}/_archive/2026-09-23-garden/old-note.conflict-2026-09-23T10-00-00Z-abc123.md`]: "---\ntitle: Old note\n---\narchived copy",
    };
    const files = {
      listDir: vi.fn(async (dir: string) => {
        const prefix = `${dir}/`;
        const seen = new Map<string, boolean>();
        for (const p of paths) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          const head = rest.split("/")[0]!;
          seen.set(head, rest.includes("/"));
        }
        return ok([...seen.entries()].map(([name, isDir]) => ({ name, path: `${prefix}${name}`, isDir, hasChildren: isDir })));
      }),
      getFileContent: vi.fn(async (p: string) => ok(bodies[p] ?? "")),
    };
    const rowNames = () => Array.from(document.querySelectorAll("[data-testid='vault-tree-row'] .vt-name")).map((n) => n.textContent);
    const tab = (label: string) => {
      (Array.from(document.querySelectorAll("[data-testid='brain-page'] .tab")).find((b) => b.textContent === label) as HTMLButtonElement).click();
      flushSync();
    };
    const mountIt = async () => {
      component = mount(BrainPage, {
        target: document.body,
        props: { page: "knowledge", slug, files: files as never, library: null, shell: null, settings: null },
      });
      await vi.waitFor(() => expect(document.querySelector("[data-testid='brain-knowledge-count']")?.textContent).toBe("5 files"));
      await vi.waitFor(() => expect(rowNames().length).toBeGreaterThan(0));
      flushSync();
    };

    it("shows a folder tree rooted at the knowledge folder, folders first, without the path prefix", async () => {
      await mountIt();
      expect(rowNames()).toEqual(["_archive", "gtm", "readme"]);
      expect(document.querySelector("[data-testid='brain-knowledge-tree']")?.textContent).not.toContain(root);
      expect(document.querySelectorAll("[data-testid='brain-list'] .item")).toHaveLength(0);
    });

    it("What's fresh is a different structure: a flat list, most recently changed first, with dates", async () => {
      await mountIt();
      tab("What's fresh");
      expect(document.querySelector("[data-testid='brain-knowledge-tree']")?.hasAttribute("hidden")).toBe(true);
      const titles = Array.from(document.querySelectorAll("[data-testid='brain-fresh-row'] .name")).map((n) => n.textContent);
      expect(titles.slice(0, 3)).toEqual(["Pricing", "Acme", "Readme"]);
      expect(document.querySelector("[data-testid='brain-fresh-changed']")?.textContent).toBe("2026-10-02");
    });

    it("expands folders, opens a file in the detail pane with the row highlighted, and keeps folders open across tabs", async () => {
      await mountIt();
      const row = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testid='vault-tree-row']")).find((r) => r.querySelector(".vt-name")?.textContent === name)!;
      row("gtm").click();
      await vi.waitFor(() => expect(rowNames()).toContain("pricing"));
      row("pricing").click();
      flushSync();
      expect(row("pricing").getAttribute("aria-selected")).toBe("true");
      expect(document.body.textContent).toContain("price list");
      tab("What's fresh");
      tab("Browse tree");
      expect(rowNames()).toContain("pricing");
    });

    it("search shows matching files with their folders open; a conflict copy is marked", async () => {
      await mountIt();
      const search = document.querySelector("[data-testid='brain-page'] input.search") as HTMLInputElement;
      search.value = "archived";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      await vi.waitFor(() => expect(rowNames()).toContain("old-note"));
      expect(rowNames()).not.toContain("gtm");
      const conflict = Array.from(document.querySelectorAll("[data-testid='vault-tree-row']")).find((r) => r.textContent?.includes(".conflict-"));
      expect(conflict?.querySelector(".vt-note-inline")?.textContent).toBe("conflict copy");
    });
  });
});
