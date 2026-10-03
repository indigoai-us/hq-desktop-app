// @vitest-environment happy-dom
// OWNER-R35 (with R27, R29, R30, R31): My Telemetry is one page with no side
// nav. Fixtures use the real /v1/telemetry/me and list_local_sessions shapes
// with placeholder ids.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import TelemetryView from "./TelemetryView.svelte";
import { createTelemetryCache } from "./telemetry-cache.js";
import { snapshotFromMe } from "./telemetry-me.js";
import { localSessionsFromNative, type LocalSessionsReader } from "./telemetry-local-sessions.js";
import { sectionForOldPage } from "./telemetry-page.js";
import { NATIVE_PAGE } from "./telemetry-local-sessions.test.js";

const t = (n: number) => ({ inputTokens: n, outputTokens: n, cacheCreationTokens: 0, cacheReadTokens: 0 });
const skills = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`/skill-${i}`, 100 - i]));
const ME = {
  from: "2026-09-04",
  to: "2026-10-03",
  daily: [
    { date: "2026-10-02", tokensByModel: { "claude-opus-5-5": t(500) }, tokens: t(500) },
    { date: "2026-10-03", tokensByModel: { "gpt-5.5-codex": t(300), "grok-4.7": t(100) }, tokens: t(400) },
  ],
  totals: {
    distinctSessions: 5946,
    skills,
    tokensByModel: {
      "claude-opus-5-5": t(400),
      "claude-opus-4-5-20251101": t(100),
      "gpt-5.5-codex": t(200),
      "gpt-5.6-sol": t(100),
      "grok-4.7": t(100),
    },
    tokens: t(900),
    outcomes: { "story-completed": 345, "deploy-succeeded": 731 },
  },
};

describe("My Telemetry unified view (OWNER-R35)", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
    localStorage.clear();
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      flushSync();
    }
  }

  async function mountView(props: Record<string, unknown> = {}) {
    const snapshot = { ...snapshotFromMe(ME, "30d"), endDate: undefined };
    const fetcher = vi.fn(async () => snapshot);
    const cache = createTelemetryCache({ fallback: snapshot, fetcher });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(TelemetryView, { target, props: { cache, ...props } });
    await settle();
    return { target, fetcher };
  }

  const reader = (): LocalSessionsReader & ReturnType<typeof vi.fn> =>
    vi.fn(async () => localSessionsFromNative(NATIVE_PAGE)) as never;

  it("has no side nav; header holds Range, the privacy line and Export CSV", async () => {
    const { target } = await mountView();
    expect(target.querySelector("aside")).toBeNull();
    expect(target.querySelector(".pane")).toBeNull();
    const header = target.querySelector(".toolbar")!;
    expect(header.querySelector("h1")?.textContent).toBe("My Telemetry");
    expect(header.querySelector("[data-testid='telemetry-range']")?.textContent).toBe("7d30d90d");
    expect(header.textContent).toContain("Only you can see this");
    expect(header.textContent).toContain("Export CSV");
    // One scope today, so no Scope control.
    expect(target.textContent).not.toContain("All my work");
  });

  it("shows every section in order with fixtures; Outcomes is absent", async () => {
    const { target } = await mountView({ localSessions: reader() });
    const sections = [...target.querySelectorAll("[data-section]")].map((el) => el.getAttribute("data-section"));
    expect(sections).toEqual(["totals", "tokens-per-day", "models", "skills", "sessions"]);
    expect(target.textContent).not.toContain("Outcomes");
    expect(target.textContent).not.toContain("Blocked");
    const totals = target.querySelector("[data-section='totals']")!.textContent!;
    expect(totals).toContain("5.95K");
    expect(totals).toContain("stories shipped");
    expect(totals).toContain("345");
    expect(totals).toContain("731");
    expect(totals).toContain("median gap between sessions on this Mac");
  });

  it("Sessions lists this Mac's records, opens the record in Files, and has no Outcome or Tokens column", async () => {
    const onopenthread = vi.fn();
    const { target } = await mountView({ localSessions: reader(), onopenthread });
    const section = target.querySelector("[data-testid='telemetry-sessions']")!;
    expect(section.textContent).toContain("Sessions on this Mac");
    expect(section.textContent).toContain("Sessions recorded on this Mac. Totals above include your other machines and bots.");
    const head = section.querySelector(".srow.hd")!.textContent;
    expect(head).toBe("WhenCompanyProjectTitleLength");
    const rows = section.querySelectorAll("button.srow");
    expect(rows).toHaveLength(3);
    (rows[0] as HTMLButtonElement).click();
    expect(onopenthread).toHaveBeenCalledWith("workspace/threads/T-20261003-112000-a.json");
    expect((rows[1] as HTMLButtonElement).disabled).toBe(true);
    expect(section.textContent).not.toContain("not available yet");
  });

  it("Sessions is absent without a local source or with no sessions (OWNER-R31)", async () => {
    const none = await mountView();
    expect(none.target.querySelector("[data-section='sessions']")).toBeNull();
    expect(none.target.textContent).not.toContain("median");
    await unmount(component!);
    component = null;
    const empty = vi.fn(async () => localSessionsFromNative({ total: 0, rows: [], medianGapMinutes: null }));
    const { target } = await mountView({ localSessions: empty });
    expect(target.querySelector("[data-section='sessions']")).toBeNull();
  });

  it("Models: families expand to exact models with ids; By model is a flat list; cost cell empty without a price", async () => {
    const { target } = await mountView();
    const fams = [...target.querySelectorAll("[data-section='models'] button.fam")].map((b) => b.getAttribute("data-family"));
    expect(fams).toEqual(["Opus", "OpenAI Codex", "Grok", "OpenAI GPT"]);
    expect(target.querySelector("[data-model='claude-opus-4-5-20251101']")).toBeNull();
    (target.querySelector("[data-family='Opus']") as HTMLButtonElement).click();
    flushSync();
    const opus = target.querySelector("[data-model='claude-opus-4-5-20251101']")!;
    expect(opus.textContent).toContain("Opus 4.5");
    expect(opus.querySelector(".mono")?.textContent).toBe("claude-opus-4-5-20251101");
    expect(JSON.parse(localStorage.getItem("hq.telemetry.openFamilies")!)).toEqual(["Opus"]);
    const grokCost = target.querySelector("[data-family='Grok'] .n:last-child")!;
    expect(grokCost.textContent).toBe("");
    const byModel = [...target.querySelectorAll("[role='tab']")].find((b) => b.textContent === "By model") as HTMLButtonElement;
    byModel.click();
    flushSync();
    const ids = [...target.querySelectorAll("[data-section='models'] [data-model]")].map((r) => r.getAttribute("data-model"));
    expect(ids).toEqual(["claude-opus-5-5", "gpt-5.5-codex", "claude-opus-4-5-20251101", "gpt-5.6-sol", "grok-4.7"]);
    expect(target.querySelector("[data-model='grok-4.7']")?.textContent).toContain("xAI");
  });

  it("Skills shows the top 10 and Show all expands in place", async () => {
    const { target } = await mountView();
    const section = target.querySelector("[data-section='skills']")!;
    expect(section.querySelectorAll(".sk")).toHaveLength(10);
    const all = [...section.querySelectorAll("button")].find((b) => b.textContent === "Show all 14") as HTMLButtonElement;
    all.click();
    flushSync();
    expect(section.querySelectorAll(".sk")).toHaveLength(14);
  });

  it("the range control drives the totals fetch and the session list", async () => {
    const sessions = reader();
    const { target, fetcher } = await mountView({ localSessions: sessions });
    const seven = [...target.querySelectorAll("[data-testid='telemetry-range'] button")].find((b) => b.textContent === "7d") as HTMLButtonElement;
    seven.click();
    await settle();
    expect(fetcher).toHaveBeenLastCalledWith("7d");
    expect(sessions).toHaveBeenLastCalledWith("7d", { offset: 0, limit: 10 });
    expect(seven.getAttribute("aria-selected")).toBe("true");
  });

  it("old sub-page links land on the matching section", async () => {
    expect(sectionForOldPage("sessions")).toBe("sessions");
    expect(sectionForOldPage("tokens")).toBe("models");
    expect(sectionForOldPage("outcomes")).toBe("totals");
    expect(sectionForOldPage("overview")).toBe("totals");
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    const { target } = await mountView({ section: "tokens" });
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement).toBe(target.querySelector("[data-section='models']"));
  });
});
