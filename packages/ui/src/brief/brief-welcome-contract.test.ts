import { describe, expect, it } from "vitest";
import { parseWelcomeFields, primaryAction, type WelcomeAction } from "./brief-welcome-contract.js";
import { plainWelcomeText } from "./brief-welcome-edition.js";
import fixture from "./fixtures/welcome-38-projects.json";

const act = (id: string, primary = false): WelcomeAction => ({ id, kind: "open_tree", label: id, reason: "", launch_prompt: "", primary });

describe("brief.json welcome contract (US-019)", () => {
  it("reads every contract field from the seeded fixture", () => {
    const f = parseWelcomeFields(fixture.welcome as Record<string, unknown>);
    expect(f.headline).toBe("38 projects, most of them in Claude Code.");
    expect(f.top_projects).toHaveLength(5);
    expect(f.top_projects?.[0]).toEqual({ name: "Harbor checkout", path: "/Users/sam/code/harbor-checkout", sessions: 46, last_active_at: "2026-10-07T21:10:00Z", harness: "claude-code" });
    expect(f.top_repos?.map((r) => r.name)).toEqual(["harbor-checkout", "field-notes", "pricing-site"]);
    expect(f.recent_work?.map((w) => w.project)).toEqual(["Harbor checkout", "Field notes", "Pricing site"]);
    expect(f.harness).toMatchObject({ primary: "claude-code", counts: { claude_code: 198, codex: 16, cursor: 0 }, action: { id: "open-hq-in-harness", kind: "open_harness", harness: "claude-code", label: "Open HQ in Claude Code" } });
    expect(f.actions?.map((a) => a.kind)).toEqual(["connect_ai_apps", "open_harness", "connect_company", "import_history"]);
    expect(f.tree).toEqual({ companies: 0, projects: 38, knowledge_files: 212 });
    expect(f.sessions).toEqual({ total: 214, claude: 198, codex: 16, days_seen: 41, local: 214, imported: 0 });
    expect(f.note).toBeUndefined();
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
      { id: "company", kind: "connect_company", label: "Start or join a company", reason: "Join your team.", launch_prompt: "", primary: false },
      { id: "import-history", kind: "import_history", label: "Import your past work", reason: "", launch_prompt: "", primary: false },
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
