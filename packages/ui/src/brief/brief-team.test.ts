// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { octoberEightBrief } from "./brief-fixture.js";
import { generateBrief } from "./brief-generate.js";
import { isGenericStatus, plainStatus, teamFooter, teamLimit, teamStatus, thanksPrompt, toneTag } from "./brief-team.js";
import type { BriefInput, BriefTeammate } from "./brief-types.js";

const mate = (over: Partial<BriefTeammate> & { id: string; name: string }): BriefTeammate => ({ doing: "Messaged you", tone: "ok", ...over });

describe("team rows", () => {
  it("shows 5 rows in a two-row or three-column slot and 3 in a W", () => {
    expect(teamLimit(2, 2)).toBe(5);
    expect(teamLimit(1, 3)).toBe(5);
    expect(teamLimit(1, 2)).toBe(3);
    expect(teamLimit(1, 1)).toBe(3);
  });

  it("knows the adapter's generic lines from the writer's words", () => {
    expect(isGenericStatus("Agent")).toBe(true);
    expect(isGenericStatus("Messaged you")).toBe(true);
    expect(isGenericStatus("You are waiting on a reply.")).toBe(true);
    expect(isGenericStatus("Finance dashboard live; waiting on your signed-in check.")).toBe(false);
  });

  it("strips PR numbers and commit prefixes from a status", () => {
    expect(plainStatus("PR 1201 in review")).toBe("A change in review");
    expect(plainStatus("Review of PR #1201, self-improving handoff")).toBe("Review of a change, self-improving handoff");
    expect(plainStatus("hq-core #1217: feat(conduct): on by default in v16")).toBe("On by default in v16");
    expect(plainStatus("Shipped the traction deck")).toBe("Shipped the traction deck");
    expect(plainStatus("Landed #88 and #89 on staging")).toBe("Landed changes on staging");
    expect(plainStatus("Merged PRs 12, 13 and 14")).toBe("Merged changes");
    expect(plainStatus("#44 - Fix the login loop")).toBe("Fix the login loop");
    expect(plainStatus("3 calls booked for Friday")).toBe("3 calls booked for Friday");
  });

  it("prefers the writer's status, then the latest DM, then the generic line", () => {
    const writer = mate({ id: "prs_g", name: "Geoff", doing: "Finance dashboard live; waiting on your signed-in check." });
    expect(teamStatus(writer, "Can you check the dashboard?")).toEqual({ text: "Finance dashboard live; waiting on your signed-in check.", fromDm: false });
    const generic = mate({ id: "prs_h", name: "Hassaan", doing: "Messaged you" });
    expect(teamStatus(generic, "Can you reply to the X mention? It has been a day")).toEqual({ text: "Can you reply to the X mention? It has been a day", fromDm: true });
    expect(teamStatus(generic, "x".repeat(80)).text.length).toBe(56);
    expect(teamStatus(generic, null)).toEqual({ text: "Messaged you", fromDm: false });
    expect(teamStatus(mate({ id: "agt_i", name: "Izzy", doing: "Agent", isAgent: true }), null)).toEqual({ text: "Agent", fromDm: false });
  });

  it("tags the tones for the +N more peek", () => {
    expect(toneTag("decision")).toBe("NEEDS YOU");
    expect(toneTag("warn")).toBe("YOU WAIT");
    expect(toneTag("ok")).toBe("");
  });

  it("writes the footer with real plurals and no agents segment when there are none", () => {
    expect(
      teamFooter([
        mate({ id: "a", name: "A", tone: "decision" }),
        mate({ id: "b", name: "B", tone: "decision" }),
        mate({ id: "c", name: "C" }),
        mate({ id: "d", name: "D", isAgent: true, tone: "neutral" }),
      ]),
    ).toBe("3 people · 1 agent · 2 need you");
    expect(teamFooter([mate({ id: "a", name: "A", tone: "decision" })])).toBe("1 person · 1 needs you");
    expect(teamFooter([mate({ id: "a", name: "A" }), mate({ id: "b", name: "B", isAgent: true }), mate({ id: "c", name: "C", isAgent: true })])).toBe("1 person · 2 agents · 0 need you");
  });

  it("the thank-you prompt names the person and the win and waits for confirmation before sending", () => {
    const p = thanksPrompt(mate({ id: "prs_j", name: "Jacob", thanks: "Shipped the traction deck." }));
    expect(p).toContain("thank-you DM to Jacob");
    expect(p).toContain("Shipped the traction deck");
    expect(p).toMatch(/wait for my confirmation/);
    expect(p).toMatch(/Do not send anything before that/);
    expect(thanksPrompt(mate({ id: "agt_i", name: "Izzy", isAgent: true }))).toContain("Izzy (an AI agent)");
  });
});

describe("Team card", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  const NOW = new Date(2026, 9, 8, 7, 42);
  const TEAM: BriefTeammate[] = [
    mate({ id: "prs_geoff", name: "Geoff", doing: "Finance dashboard live; waiting on your signed-in check.", tone: "decision", load: "heavy", owes: ["Pricing page numbers"] }),
    mate({ id: "prs_jacob", name: "Jacob", doing: "Traction deck is live", tone: "ok", thanks: "Shipped the traction deck" }),
    mate({ id: "prs_hassaan", name: "Hassaan", doing: "PR 1201 in review", tone: "warn", load: "storm" }),
    mate({ id: "prs_jonathan", name: "Jonathan", doing: "Sent a ranked list of signup and invite fixes.", tone: "decision" }),
    mate({ id: "prs_stefan", name: "Stefan", doing: "Took over liveops", tone: "ok", load: "steady" }),
    mate({ id: "prs_shawon", name: "Shawon", doing: "Mobile build running", tone: "ok", load: "clear" }),
    mate({ id: "agt_izzy", name: "Izzy", doing: "Agent", tone: "neutral", isAgent: true }),
  ];
  // Nobody on the Oct 8 fixture needs a call, so pinning the card keeps it on the page for these tests.
  const day = (): BriefInput => ({
    ...octoberEightBrief(NOW),
    today: "2026-10-08",
    team: TEAM.map((t) => ({ ...t })),
    prefs: { density: "auto", pinned: ["team"], hidden: [], weights: {} },
  });

  function render(input: BriefInput, props: Record<string, unknown> = {}) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(DailyBrief, { target, props: { input, ...props } });
    flushSync();
  }
  const q = (sel: string) => target.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
  async function hover(el: Element): Promise<void> {
    el.dispatchEvent(new MouseEvent("mouseenter"));
    await new Promise((r) => setTimeout(r, 260));
    flushSync();
  }
  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });

  it("caps the rows at the slot, folds the rest into +N more, and its peek lists them with their tone", async () => {
    const input = day();
    const slot = generateBrief(input).widgets.find((w) => w.kind === "team")!;
    expect(slot).toBeDefined();
    render(input);
    await settle();
    const rows = qa('[data-testid="brief-team-row"]');
    // DailyBrief does not pass cols yet, so the card uses its default; once wired it follows the slot.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.length).toBeLessThanOrEqual(5);
    const more = q('[data-testid="brief-team-more"]')!;
    expect(more.textContent?.trim()).toBe(`+${TEAM.length - rows.length} more`);
    await hover(more);
    const peek = q('[data-testid="brief-peek"]')!;
    const lines = [...peek.querySelectorAll('[data-testid="brief-peek-line"]')].map((l) => l.textContent ?? "");
    expect(lines).toHaveLength(TEAM.length - rows.length);
    expect(lines.join(" ")).toContain("Izzy");
    expect(lines.join(" ")).not.toMatch(/PR \d+/);
    const foot = q('[data-testid="brief-team-foot"]');
    if (slot.rows > 1) expect(foot?.textContent).toBe("6 people · 1 agent · 2 need you");
    else expect(foot).toBeNull();
  });

  it("status lines are the writer's words with no PR numbers; load tags only for heavy and storm; a green tick marks a thank-you", async () => {
    render(day());
    await settle();
    const card = q('[data-testid="brief-team"]')!;
    expect(card.textContent).toContain("Finance dashboard live; waiting on your signed-in check.");
    expect(card.textContent).toContain("A change in review");
    expect(card.textContent).not.toContain("PR 1201");
    const loads = qa('[data-testid="brief-team-load"]').map((el) => el.getAttribute("data-load"));
    expect(loads).toEqual(["heavy", "storm"]);
    expect(qa('[data-testid="brief-team-thanks"]')).toHaveLength(1);
    expect(q('[aria-label="Jacob"] [data-testid="brief-team-thanks"]')).not.toBeNull();
    expect(q('[aria-label="Geoff"] [data-testid="brief-team-say-thanks"]')).toBeNull();
  });

  it("Say thanks starts a session that drafts the note and waits for a yes; the peek carries the same prompt", async () => {
    const onlaunch = vi.fn(async () => null);
    render(day(), { onlaunch });
    await settle();
    const row = q('[aria-label="Jacob"]')!;
    await hover(row);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Worth a thank-you");
    expect(peek.textContent).toContain("Shipped the traction deck");
    row.querySelector<HTMLButtonElement>('[data-testid="brief-team-say-thanks"]')!.click();
    await settle();
    expect(onlaunch).toHaveBeenCalledTimes(1);
    const [engine, prompt] = onlaunch.mock.calls[0] as unknown as [string, string];
    expect(engine).toBe("claude");
    expect(prompt).toContain("thank-you DM to Jacob");
    expect(prompt).toContain("Shipped the traction deck");
    expect(prompt).toMatch(/wait for my confirmation/);
    expect(row.textContent).toContain("Started in Claude.");
  });

  it("a teammate's peek lists what they owe you and what is between you", async () => {
    render(day());
    await settle();
    await hover(q('[aria-label="Geoff"]')!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("Owes you");
    expect(peek.textContent).toContain("Pricing page numbers");
    expect(peek.textContent).toContain("Finance dashboard live; waiting on your signed-in check.");
  });
});
