import { describe, expect, it } from "vitest";
import { parseWelcomeFields, primaryAction, type WelcomeAction } from "./brief-welcome-contract.js";
import { plainWelcomeText } from "./brief-welcome-edition.js";
import fixture from "./fixtures/welcome-38-projects.json";
import core from "./fixtures/core-1432-welcome.json";

const act = (id: string, primary = false): WelcomeAction => ({ id, kind: "open_tree", label: id, reason: "", launch_prompt: "", primary });

describe("brief.json welcome contract (US-019)", () => {
  it("reads every contract field from the seeded fixture", () => {
    const f = parseWelcomeFields(fixture.welcome as Record<string, unknown>);
    expect(f.headline).toBe("HQ found 214 past sessions across 38 projects on this Mac, most of them in Claude Code.");
    expect(f.top_projects).toHaveLength(5);
    expect(f.top_projects?.[0]).toEqual({ name: "Harbor checkout", path: "~/code/harbor-checkout", sessions: 46, last_active_at: "2026-10-07T21:10:00Z", harness: "claude-code" });
    expect(f.top_repos?.map((r) => r.name)).toEqual(["harbor-checkout", "field-notes", "pricing-site"]);
    expect(f.recent_work?.map((w) => w.project)).toEqual(["Harbor checkout", "Field notes", "Pricing site"]);
    expect(f.harness).toMatchObject({ primary: "claude-code", counts: { claude_code: 198, codex: 16, cursor: 0 }, action: { id: "open-hq-in-harness", kind: "open_harness", harness: "claude-code", label: "Open HQ in Claude Code" } });
    expect(f.actions?.map((a) => [a.kind, a.label])).toEqual([
      ["open_harness", "Open HQ in Claude Code"],
      ["connect_ai_apps", "Connect your AI apps"],
      ["import_history", "Bring in your past work"],
      ["connect_company", "Create or join a company"],
      ["open_tree", "Look around your HQ"],
    ]);
    expect(f.actions?.[0]?.harness).toBe("claude-code");
    expect(f.tree).toEqual({ companies: 0, projects: 38, knowledge_files: 212 });
    expect(f.sessions).toEqual({ total: 214, claude: 198, codex: 16, days_seen: 41, local: 214, imported: 0 });
    expect(f.note).toBeUndefined();
  });

  it("reads Core's real output (PR 1432), with either harness id spelling", () => {
    const f = parseWelcomeFields(core.claude_person as Record<string, unknown>);
    expect(f.harness).toMatchObject({ primary: "claude-code", counts: { claude_code: 23, codex: 2, cursor: 0 }, action: { harness: "claude-code", label: "Open HQ in Claude Code" } });
    expect(f.top_projects?.map((p) => p.harness)).toEqual(["claude-code", "claude-code"]);
    expect(f.recent_work?.map((w) => w.harness)).toEqual(["claude-code", "claude-code"]);
    expect(f.actions?.find((a) => a.kind === "open_harness")?.harness).toBe("claude-code");
    // Core's earlier head wrote claude_code everywhere; it reads the same.
    expect(core.claude_person_underscore.harness.primary).toBe("claude_code");
    expect(parseWelcomeFields(core.claude_person_underscore as Record<string, unknown>)).toEqual(f);
  });

  it("reads Core's labels for a company brief", () => {
    const f = parseWelcomeFields(core.showcase_company as Record<string, unknown>);
    expect(f.actions?.map((a) => [a.kind, a.label])).toEqual([
      ["open_harness", "Open HQ in Claude Code"],
      ["connect_ai_apps", "Connect your AI apps"],
      ["import_history", "Bring in your past work"],
      ["connect_integration", "Connect GitHub"],
      ["open_tree", "Look around your HQ"],
    ]);
    expect(f.actions?.find((a) => a.kind === "connect_integration")?.reason).toBe("Connected apps add pull requests, meetings and messages to the brief.");
  });

  it("reads a Cursor-primary person from Core", () => {
    const f = parseWelcomeFields(core.cursor_person as Record<string, unknown>);
    expect(f.harness).toMatchObject({ primary: "cursor", counts: { claude_code: 4, codex: 0, cursor: 14 }, action: { harness: "cursor", label: "Open HQ in Cursor" } });
    expect(f.actions?.find((a) => a.kind === "open_harness")).toMatchObject({ harness: "cursor", label: "Open HQ in Cursor" });
    expect(f.recent_work?.map((w) => [w.title, w.harness])).toEqual([
      ["Fix the signup form on mobile", "cursor"],
      ["Retry failed invoice webhooks", "cursor"],
    ]);
    expect(primaryAction(f.actions)?.label).toBe("Bring in your past work");
  });

  it("accepts either spelling for the Claude Code count key", () => {
    expect(parseWelcomeFields({ harness: { primary: "claude_code", counts: { "claude-code": 5, codex: 1 } } }).harness?.counts).toEqual({ claude_code: 5, codex: 1, cursor: 0 });
  });

  it("sorts recent work before it caps it", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ title: `W${i}`, at: `2026-10-0${i + 1}T00:00:00Z` }));
    expect(parseWelcomeFields({ recent_work: rows }).recent_work?.map((w) => w.title)).toEqual(["W6", "W5", "W4", "W3", "W2"]);
  });

  it("keeps only the first primary action", () => {
    const f = parseWelcomeFields({ actions: [{ id: "a", kind: "open_tree", label: "A" }, { id: "b", kind: "open_tree", label: "B", primary: true }, { id: "c", kind: "open_tree", label: "C", primary: true }] });
    expect(f.actions?.map((a) => a.primary)).toEqual([false, true, false]);
  });

  it("counts Cursor sessions in the 16.0.30 shape", () => {
    expect(parseWelcomeFields({ sessions: { total: 9, claude: 2, codex: 1, cursor: 6 } }).harness).toMatchObject({ primary: "cursor", counts: { claude_code: 2, codex: 1, cursor: 6 } });
  });

  it("caps lists at five, sorts recent work newest first and drops rows missing required keys", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ name: `P${i}`, sessions: i }));
    const f = parseWelcomeFields({
      top_projects: [...rows, { sessions: 3 }],
      recent_work: [
        { title: "Older", at: "2026-10-01T00:00:00Z" },
        { title: "Newer", at: "2026-10-05T00:00:00Z" },
        { title: "No time" },
        { title: "Bad time", at: "yesterday-ish" },
      ],
      actions: [{ id: "x", kind: "launch_rocket", label: "Nope" }, { id: "y", kind: "open_tree" }, { id: "z", kind: "open_tree", label: "Your HQ", integration: { slug: "linear" } }],
    });
    expect(f.top_projects).toHaveLength(5);
    expect(f.recent_work?.map((w) => w.title)).toEqual(["Newer", "Older"]);
    expect(f.actions).toEqual([{ id: "z", kind: "open_tree", label: "Your HQ", reason: "", launch_prompt: "", primary: false }]);
  });

  it("leaves out absent and empty fields so their components stay hidden", () => {
    expect(parseWelcomeFields({})).toEqual({});
    expect(parseWelcomeFields({ top_projects: [], top_repos: "bad", recent_work: [null], actions: [], harness: { primary: "vim" }, headline: "   " })).toEqual({});
  });

  it("still reads the 16.0.30 shape: next_steps become actions and session counts become the harness", () => {
    const f = parseWelcomeFields({
      first_run: true,
      sessions: { total: 9, claude: 2, codex: 7, days_seen: 3 },
      next_steps: [{ id: "company", kind: "connect_company", reason: "Join your team." }, { kind: "import" }, { kind: "mystery" }],
    });
    expect(f.actions).toEqual([
      { id: "company", kind: "connect_company", label: "Create or join a company", reason: "Join your team.", launch_prompt: "", primary: false },
      { id: "import-history", kind: "import_history", label: "Bring in your past work", reason: "", launch_prompt: "", primary: false },
    ]);
    expect(f.harness).toMatchObject({ primary: "codex", counts: { claude_code: 2, codex: 7, cursor: 0 }, action: { label: "Open HQ in Codex", harness: "codex" } });
    expect(f.sessions).toEqual({ total: 9, claude: 2, codex: 7, days_seen: 3 });
  });

  it("an explicit actions list wins over next_steps, even when every entry is invalid", () => {
    expect(parseWelcomeFields({ actions: [{ kind: "bad" }], next_steps: [{ kind: "connect_company" }] }).actions).toBeUndefined();
  });

  it("picks the primary action, else the first", () => {
    expect(primaryAction([act("a"), act("b", true)])?.id).toBe("b");
    expect(primaryAction([act("a"), act("b")])?.id).toBe("a");
    expect(primaryAction([])).toBeNull();
    expect(primaryAction(undefined)).toBeNull();
  });

  it("keeps plain words and refuses raw text", () => {
    expect(plainWelcomeText("Fixed the coupon rounding at checkout")).toBe("Fixed the coupon rounding at checkout");
    expect(plainWelcomeText("  Every   project counts ")).toBe("Every project counts");
    for (const raw of [
      "/Users/sam/code/harbor-checkout",
      "~/code/x",
      "Traceback (most recent call last)",
      "TypeError: undefined is not a function",
      "ENOENT while reading",
      "gh auth login",
      "see https://example.com",
      "first_run failed",
      "run `hq sync`",
      "",
      null,
      undefined,
    ])
      expect(plainWelcomeText(raw)).toBeNull();
  });
});
