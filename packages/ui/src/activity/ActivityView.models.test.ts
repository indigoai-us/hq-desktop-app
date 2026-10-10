// @vitest-environment happy-dom
// Activity shows which models each person used: a short line under the name
// in the team list and a Models section in the person panel. Both hide when
// the read sends no per-model data.
import { ok } from "@hq/platform";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import ActivityView from "./ActivityView.svelte";
import { activityFromCompanyTelemetry, activityToCsv, memberModels, modelLabel, modelSummary } from "./activity-model";

const counts = (input: number) => ({ input, output: 0, cacheCreation: 0, cacheRead: 0 });

// Production flat shape: a `{ [model]: counts }` map per member.
const TELEMETRY = {
  members: [
    {
      personUid: "prs_a",
      label: "Ada",
      tokensByModel: { "claude-opus-5-5": counts(750), "gpt-5.6-sol": counts(250) },
      sessionsByModel: { "claude-opus-5-5": 4, "gpt-5.6-sol": 6 },
      distinctSessions: 10,
      events: 20,
    },
    {
      personUid: "prs_b",
      label: "Bea",
      tokensByModel: { "claude-sonnet-5-5": counts(100) },
      distinctSessions: 1,
      events: 1,
    },
    { personUid: "prs_c", label: "Cy", tokensByModel: {}, distinctSessions: 2, events: 3 },
  ],
};

describe("modelLabel", () => {
  it("maps known ids to short names", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelLabel("claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("claude-opus-4-8[1m]")).toBe("Opus 4.8");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("us.anthropic.claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(modelLabel("gpt-5.6-sol-pro")).toBe("GPT-5.6 Sol Pro");
    expect(modelLabel("gpt-5-codex")).toBe("GPT-5 Codex");
    expect(modelLabel("codex-mini")).toBe("Codex Mini");
    expect(modelLabel("grok-4.5")).toBe("Grok 4.5");
  });

  it("shows unknown ids raw, shortened", () => {
    expect(modelLabel("claude")).toBe("claude");
    expect(modelLabel("some-very-long-provider-model-id")).toBe("some-very-long-prov…");
    expect(modelLabel("  ")).toBe("Unknown");
  });
});

describe("memberModels", () => {
  it("sorts by sessions, then tokens, with token share", () => {
    const ada = activityFromCompanyTelemetry(TELEMETRY).members.find((m) => m.id === "prs_a")!;
    expect(memberModels(ada)).toEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", tokens: 250, share: 25, sessions: 6 },
      { id: "claude-opus-5-5", label: "Opus 5.5", tokens: 750, share: 75, sessions: 4 },
    ]);
    expect(modelSummary(memberModels(ada))).toBe("GPT-5.6 Sol +1");
  });

  it("falls back to tokens and merges ids with the same name", () => {
    const models = memberModels({
      tokensByModel: [
        { model: "claude-opus-5-5", total: 10 },
        { model: "claude-sonnet-5-5", total: 30 },
        { model: "anthropic/claude-opus-5-5", total: 30 },
      ],
    });
    expect(models.map((m) => [m.label, m.tokens, m.sessions])).toEqual([
      ["Opus 5.5", 40, null],
      ["Sonnet 5.5", 30, null],
    ]);
    expect(modelSummary(models)).toBe("Opus 5.5 +1");
  });

  it("is empty with no model data", () => {
    expect(memberModels({})).toEqual([]);
    expect(modelSummary([])).toBe("");
  });

  it("exports models in the CSV", () => {
    const csv = activityToCsv(activityFromCompanyTelemetry(TELEMETRY), "30d");
    expect(csv.split("\n")[0]).toContain("models");
    expect(csv).toContain("GPT-5.6 Sol; Opus 5.5");
  });
});

describe("Activity view models", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
    localStorage.clear();
  });

  const settle = async () => {
    flushSync();
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    flushSync();
  };

  it("shows models under the name and in the person panel, hidden with no data", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(ActivityView, {
      target,
      props: {
        slug: "acme",
        companyLabel: "Acme",
        adapter: { company: { getTeamTelemetry: async () => ok(TELEMETRY) } } as never,
      },
    });
    await settle();
    const rows = [...target.querySelectorAll<HTMLElement>('[data-testid="activity-member-row"]')];
    const row = (name: string) => rows.find((r) => r.textContent?.includes(name))!;
    const line = (name: string) => row(name).querySelector('[data-testid="activity-member-models"]')?.textContent ?? null;
    expect(line("Ada")).toBe("GPT-5.6 Sol +1");
    expect(line("Bea")).toBe("Sonnet 5.5");
    expect(line("Cy")).toBeNull();

    row("Ada").click();
    await settle();
    const panel = target.querySelector('[data-testid="activity-member-pane"]')!;
    expect(
      [...panel.querySelectorAll('[data-testid="activity-member-model"]')].map((r) => r.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(["GPT-5.6 Sol 6 sessions · 25% of tokens", "Opus 5.5 4 sessions · 75% of tokens"]);

    row("Cy").click();
    await settle();
    const cyPanel = target.querySelector('[data-testid="activity-member-pane"]')!;
    expect(cyPanel.querySelectorAll('[data-testid="activity-member-model"]').length).toBe(0);
    expect([...cyPanel.querySelectorAll(".sech")].map((h) => h.textContent?.trim())).not.toContain("Models");
  });
});
