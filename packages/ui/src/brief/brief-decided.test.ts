// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import BriefDecided from "./BriefDecided.svelte";
import BriefCardHarness from "./fixtures/BriefCardHarness.svelte";
import { BriefState } from "./brief-context.svelte.js";
import {
  AWAY_MS,
  DAY_MS,
  DECIDED_MIN,
  LINE_MAX,
  decidedRows,
  followUpPrompt,
  meetingsInWindow,
  morePeek,
  namesOwner,
  rowPeek,
  settledTitle,
  truncateLine,
  whenLabel,
} from "./brief-decided.js";
import { clockLabel } from "./brief-time.js";
import type { BriefMeeting } from "./brief-types.js";

/** Sunday 2026-10-11, the real run's clock. The window starts 24 hours earlier. */
const NOW = "2026-10-11T14:54:00.000Z";
const FROM = Date.parse(NOW) - DAY_MS;
const INDIGO = "cmp_indigo";

const LONG =
  "Move every customer onboarding call to the new Tuesday and Thursday slots so the sales team keeps Monday mornings free for pipeline review";

const meeting = (over: Partial<BriefMeeting> & Pick<BriefMeeting, "id" | "title" | "startTime">): BriefMeeting => ({
  companyUid: INDIGO,
  decisions: over.decided?.length ?? 0,
  actions: 0,
  risks: 0,
  questions: 0,
  ...over,
});

/** Six decided lines across two in-window meetings, plus one outside the window and one not attended. */
const DAY: BriefMeeting[] = [
  meeting({
    id: "m1",
    title: "Call with Jordan",
    startTime: "2026-10-10T21:00:00.000Z",
    with: "Jordan",
    decided: ["Ship the desktop beta to five customers on Monday", "Jordan owns the pricing page copy", LONG],
  }),
  meeting({
    id: "m2",
    title: "HQ Dev Standup",
    startTime: "2026-10-11T00:00:00.000Z",
    decided: ["Drop the old onboarding flow", "Glossaries become one file per company", "Interviews ask one question at a time"],
    todo: [{ text: "Write the FAQ", mine: true }],
  }),
  meeting({ id: "m3", title: "Investor call", startTime: "2026-10-09T19:00:00.000Z", decided: ["Raise the SAFE cap"] }),
  meeting({ id: "m4", title: "Board prep", startTime: "2026-10-11T02:00:00.000Z", attended: false, decided: ["Skipped meeting line"] }),
];

const withoutMine = (): BriefMeeting[] => DAY.map((m) => ({ ...m, todo: undefined }));

describe("decided rows", () => {
  it("keeps only meetings you attended inside the window, in start order, one row per line", () => {
    expect(meetingsInWindow(DAY, FROM).map((m) => m.id)).toEqual(["m1", "m2"]);
    const rows = decidedRows(DAY, FROM);
    expect(rows.map((r) => r.id)).toEqual(["m1:d0", "m1:d1", "m1:d2", "m2:d0", "m2:d1", "m2:d2"]);
    const texts = rows.map((r) => r.text);
    expect(texts).not.toContain("Raise the SAFE cap");
    expect(texts).not.toContain("Skipped meeting line");
    expect(rows[0]!.meeting.title).toBe("Call with Jordan");
  });

  it("the picker's gate is three lines", () => {
    expect(DECIDED_MIN).toBe(3);
    expect(decidedRows(DAY.slice(0, 1), FROM)).toHaveLength(3);
    expect(decidedRows([{ ...DAY[0]!, decided: ["One", "  ", "Two"] }], FROM)).toHaveLength(2);
  });

  it("truncates a long line on a word boundary within 90 characters", () => {
    expect(LINE_MAX).toBe(90);
    const line = truncateLine(LONG);
    expect(line.length).toBeLessThanOrEqual(LINE_MAX);
    expect(line.endsWith("…")).toBe(true);
    const kept = line.slice(0, -1);
    expect(LONG.startsWith(kept)).toBe(true);
    expect(LONG.charAt(kept.length)).toBe(" ");
    expect(truncateLine("Ship Friday")).toBe("Ship Friday");
    expect(truncateLine("x".repeat(90))).toBe("x".repeat(90));
    const word = truncateLine("y".repeat(120));
    expect(word.length).toBeLessThanOrEqual(LINE_MAX);
    expect(word.endsWith("…")).toBe(true);
    expect(truncateLine("  spaced   out  ")).toBe("spaced out");
  });

  it("a line is yours when the meeting left you a to-do or the line names you", () => {
    expect(decidedRows(DAY, FROM).filter((r) => r.mine).map((r) => r.id)).toEqual(["m2:d0", "m2:d1", "m2:d2"]);
    expect(decidedRows(withoutMine(), FROM).some((r) => r.mine)).toBe(false);
    expect(namesOwner("Corey Epstein decided to keep the rule", "Corey Epstein")).toBe(true);
    expect(namesOwner("corey takes the pricing page", "Corey")).toBe(true);
    expect(namesOwner("Coreys idea is parked", "Corey")).toBe(false);
    expect(namesOwner("Nobody named", null)).toBe(false);
    expect(namesOwner("A line", "C")).toBe(false);
    const named = decidedRows([{ ...DAY[0]!, decided: ["Corey decides the merge rule by Friday", "Other"] }], FROM, "Corey Epstein");
    expect(named.map((r) => r.mine)).toEqual([true, false]);
  });
});

describe("decided copy", () => {
  it("titles the card with the count, and 'without you' only when none is yours", () => {
    expect(settledTitle(6, { mine: false, away: false })).toBe("6 decisions made yesterday without you");
    expect(settledTitle(6, { mine: true, away: false })).toBe("6 decisions made yesterday");
    expect(settledTitle(1, { mine: true, away: false })).toBe("1 decision made yesterday");
    expect(settledTitle(4, { mine: false, away: true })).toBe("4 decisions made while you were away without you");
    expect(AWAY_MS).toBe(36 * 3_600_000);
  });

  it("the follow-up prompt names the meeting and the decision, drafts, and sends nothing", () => {
    const p = followUpPrompt("Call with Jordan", "Jordan owns the pricing page copy", "Oct 10, 2 PM");
    expect(p).toContain("Call with Jordan (Oct 10, 2 PM)");
    expect(p).toContain("Jordan owns the pricing page copy.");
    expect(p).toMatch(/draft the follow-up/);
    expect(p).toMatch(/show it to me/);
    expect(p).toMatch(/Do not send anything\.$/);
    expect(followUpPrompt("Standup", "Ship Friday?", "")).toContain("from Standup: Ship Friday?");
  });

  it("a row's peek is compact: full text, meeting and time, company chip, and a Follow up prompt", () => {
    const row = decidedRows(DAY, FROM)[2]!;
    const peek = rowPeek(row, "Oct 10, 2 PM");
    expect(peek.compact).toBe(true);
    expect(peek.title).toBe(LONG);
    expect(peek.status).toBe("Call with Jordan · Oct 10, 2 PM · with Jordan");
    expect(peek.origin).toEqual({ companyUid: INDIGO, label: "Call with Jordan" });
    expect(peek.prompt).toMatchObject({ id: "m1:d2", verb: "Follow up" });
    expect(peek.prompt!.text).toContain(LONG);
    expect(peek.prompt!.text).toMatch(/Do not send/);
    expect(rowPeek({ ...row, meeting: { ...row.meeting, companyUid: null, with: undefined } }, "2 PM").origin).toBeUndefined();
  });

  it("the +N more peek lists every remaining line with its meeting's time", () => {
    const rows = decidedRows(DAY, FROM);
    const peek = morePeek(rows.slice(5), (iso) => `t:${iso.slice(11, 16)}`);
    expect(peek.title).toBe("1 more decision");
    expect(peek.sections[0]!.lines).toEqual([{ label: "Interviews ask one question at a time", state: "t:00:00", tone: "decision" }]);
    expect(morePeek(rows.slice(3), () => "").title).toBe("3 more decisions");
  });

  it("formats when in local time without toLocale", () => {
    const iso = DAY[0]!.startTime;
    const d = new Date(iso);
    const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
    expect(whenLabel(iso)).toBe(`${MON} ${d.getDate()}, ${clockLabel(iso)}`);
    expect(whenLabel("nope")).toBe("");
  });
});

describe("BriefDecided", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  let state: BriefState;

  function render(props: Record<string, unknown>) {
    target = document.createElement("div");
    document.body.appendChild(target);
    state = new BriefState(async () => null, () => []);
    app = mount(BriefCardHarness, { target, props: { state, card: BriefDecided, props: { meetings: DAY, now: NOW, rows: 2, ...props } } });
    flushSync();
  }
  const q = (sel: string) => target.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
  async function hover(el: Element): Promise<void> {
    el.dispatchEvent(new MouseEvent("mouseenter"));
    await new Promise((r) => setTimeout(r, 260));
    flushSync();
  }

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });

  it("six lines across two meetings in a two-row slot: five rows, then +1 more, with the full count in the title", () => {
    render({});
    expect(q('[data-testid="brief-decided"]')).not.toBeNull();
    expect(q(".eyebrow")!.textContent!.trim()).toBe("What got settled");
    expect(q('[data-testid="brief-decided-title"]')!.textContent).toBe("6 decisions made yesterday");
    expect(qa('[data-testid="brief-decided-row"]')).toHaveLength(5);
    expect(q('[data-testid="brief-decided-more"]')!.textContent!.trim()).toBe("+1 more");
    expect(target.textContent).not.toContain("Interviews ask one question at a time");
    expect(target.textContent).not.toContain("Raise the SAFE cap");
    expect(target.textContent).not.toContain("Skipped meeting line");
    expect(q(".foot")!.textContent).toContain("6 settled");
    expect(q(".foot")!.textContent).toContain("2 meetings");
  });

  it("a one-row slot shows three rows and +3 more, with no footer", () => {
    render({ rows: 1 });
    expect(qa('[data-testid="brief-decided-row"]')).toHaveLength(3);
    expect(q('[data-testid="brief-decided-more"]')!.textContent!.trim()).toBe("+3 more");
    expect(q(".foot")).toBeNull();
  });

  it("the face line is cut on a word within 90 characters; the row keeps the full text for the peek", () => {
    render({});
    const row = qa('[data-testid="brief-decided-row"]')[2]!;
    const line = row.querySelector('[data-testid="brief-decided-line"]')!.textContent!;
    expect(line.length).toBeLessThanOrEqual(90);
    expect(line.endsWith("…")).toBe(true);
    expect(LONG.startsWith(line.slice(0, -1))).toBe(true);
    expect(row.getAttribute("aria-label")).toBe(LONG);
  });

  it("the source line is the meeting's plain title, its local time, and the company's logo", () => {
    render({});
    const first = qa('[data-testid="brief-decided-row"]')[0]!;
    expect(first.querySelector('[data-testid="brief-decided-src-text"]')!.textContent).toBe(`Call with Jordan · ${clockLabel("2026-10-10T21:00:00.000Z")}`);
    expect(first.querySelector('[data-testid="brief-logo"]')).not.toBeNull();
    const fourth = qa('[data-testid="brief-decided-row"]')[3]!;
    expect(fourth.querySelector('[data-testid="brief-decided-src-text"]')!.textContent).toBe(`HQ Dev Standup · ${clockLabel("2026-10-11T00:00:00.000Z")}`);
  });

  it("says 'without you' when no line is yours, and drops it when a line names you", () => {
    render({ meetings: withoutMine() });
    expect(q('[data-testid="brief-decided-title"]')!.textContent).toBe("6 decisions made yesterday without you");
    unmount(app!);
    app = null;
    render({ meetings: withoutMine().map((m) => (m.id === "m1" ? { ...m, decided: ["Corey keeps the no-self-merge rule", ...m.decided!.slice(1)] } : m)), userName: "Corey Epstein" });
    expect(q('[data-testid="brief-decided-title"]')!.textContent).toBe("6 decisions made yesterday");
  });

  it("hides itself below three lines, and when every meeting is outside the window", () => {
    render({ meetings: [{ ...DAY[0]!, decided: ["One", "Two"] }] });
    expect(q('[data-testid="brief-decided"]')).toBeNull();
    unmount(app!);
    app = null;
    render({ meetings: DAY, now: "2026-10-13T09:00:00.000Z" });
    expect(q('[data-testid="brief-decided"]')).toBeNull();
  });

  it("follows the picker's window when given one, and says 'while you were away' on a catch-up window", () => {
    render({ now: "2026-10-13T09:00:00.000Z", windowFrom: Date.parse("2026-10-09T12:00:00.000Z") });
    expect(q('[data-testid="brief-decided"]')).not.toBeNull();
    // The investor call (Oct 9, 19:00Z) is inside this window; the skipped board prep still is not.
    expect(qa('[data-testid="brief-decided-row"]')).toHaveLength(5);
    expect(q('[data-testid="brief-decided-more"]')!.textContent!.trim()).toBe("+2 more");
    expect(q('[data-testid="brief-decided-title"]')!.textContent).toBe("7 decisions made while you were away");
    expect(target.textContent).not.toContain("Skipped meeting line");
  });

  it("hovering a row peeks the full decision with a Follow up prompt that sends nothing; +N more peeks the rest", async () => {
    render({});
    await hover(qa('[data-testid="brief-decided-row"]')[2]!);
    const peek = state.peek!.content;
    expect(peek.compact).toBe(true);
    expect(peek.title).toBe(LONG);
    expect(peek.status).toContain("Call with Jordan");
    expect(peek.status).toContain(clockLabel("2026-10-10T21:00:00.000Z"));
    expect(peek.origin?.companyUid).toBe(INDIGO);
    expect(peek.prompt?.verb).toBe("Follow up");
    expect(peek.prompt?.text).toMatch(/Do not send anything\.$/);
    await hover(q('[data-testid="brief-decided-more"]')!);
    const more = state.peek!.content;
    expect(more.title).toBe("1 more decision");
    expect(more.sections[0]!.lines!.map((l) => l.label)).toEqual(["Interviews ask one question at a time"]);
  });
});
