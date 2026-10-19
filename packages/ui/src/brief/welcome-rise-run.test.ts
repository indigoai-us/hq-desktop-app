// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { generateBrief } from "./brief-generate.js";
import { riseFrame, riseRevealAt } from "./brief-rise.js";
import {
  WELCOME_RISE_CALENDAR_LINE,
  WELCOME_RISE_FINDING_CLAUDE,
  WELCOME_RISE_FIELDWORK_TITLE,
  WELCOME_RISE_FINDING_CODEX,
  WELCOME_RISE_SOURCES,
  WELCOME_RISE_STUDIO_TITLE,
  WELCOME_RISE_WORK_TITLE,
  WELCOME_RISE_TODAY,
  welcomeRiseBriefInput,
  welcomeRiseNow,
  welcomeRiseRunStats,
} from "./welcome-rise-run.js";

let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
  target = null;
});

describe("welcome rise handoff", () => {
  it("uses one run for the rise and the brief, with no sample greeting", () => {
    const now = welcomeRiseNow();
    const input = welcomeRiseBriefInput(now);
    const reveal = riseFrame(riseRevealAt(0), WELCOME_RISE_SOURCES);
    expect(input.today).toBe(WELCOME_RISE_TODAY);
    expect(input.userName).toBe("Alex");
    expect(input.calendarSample).toBe(false);
    expect(input.decisions.every((item) => item.sample !== true)).toBe(true);
    // The reveal ends on every source's sessions, and the brief carries that count.
    expect(input.sessions).toHaveLength(412);
    expect(input.companies).toEqual(["northstar", "fieldwork", "studio"]);
    expect(reveal.countText).toBe("168 sessions read");
    const last = riseFrame(riseRevealAt(WELCOME_RISE_SOURCES.length - 1), WELCOME_RISE_SOURCES);
    expect(last.countText).toBe("412 sessions read · 6 repos");
    expect(input.runStats).toBe(last.countText);
    expect(welcomeRiseRunStats()).toBe(last.countText);
    expect(reveal.cards[0]?.text).toBe(WELCOME_RISE_FINDING_CLAUDE);
    expect(reveal.cards[0]?.text).not.toContain("sessions");
    expect(generateBrief(input).sessions.count).toBe(412);
    expect(generateBrief(input).provenance.find((row) => row.label === "sessions")?.n).toBe(412);

    const label = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    expect(label).toContain("Saturday");
    expect(label).toContain("October");
    expect(label).toContain("17");

    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(DailyBrief, {
      target,
      props: {
        input,
        companies: [
          { uid: "northstar", slug: "northstar", label: "Northstar", iconUrl: null },
          { uid: "fieldwork", slug: "fieldwork", label: "Fieldwork", iconUrl: null },
          { uid: "studio", slug: "studio", label: "Studio", iconUrl: null },
        ],
      },
    });
    flushSync();
    const text = target.textContent ?? "";
    expect(text).toContain("Morning, Alex.");
    expect(text).toContain(WELCOME_RISE_FINDING_CLAUDE);
    expect(text).toContain(WELCOME_RISE_FINDING_CODEX);
    expect(text).toContain(WELCOME_RISE_WORK_TITLE);
    // The pick-up item is plain words, never a filename or repo path.
    expect(input.decisions.every((item) => !/\.svelte|\/src\//.test(`${item.title} ${item.summary}`))).toBe(true);
    // Gate review item 9: the calendar is a quiet source note, not a priority or a decision.
    expect(input.decisions.find((item) => item.title === WELCOME_RISE_CALENDAR_LINE)).toBeUndefined();
    const notes = [...target.querySelectorAll("[data-testid='brief-source-note']")].map((el) => el.textContent);
    expect(notes).toEqual([WELCOME_RISE_CALENDAR_LINE]);
    expect(text.match(/Calendar could not be read/g)).toHaveLength(1);
    const rows = [...target.querySelectorAll("[data-testid='brief-priority']")];
    expect(rows.some((row) => row.textContent?.includes(WELCOME_RISE_CALENDAR_LINE))).toBe(false);
    // No company initials badge on the person's own items; only the other projects' rows say whose they are.
    const badged = rows.filter((row) => row.querySelector("[data-testid='brief-priority-logo']"));
    expect(badged.map((row) => row.querySelector("b")?.textContent)).toEqual([WELCOME_RISE_FIELDWORK_TITLE, WELCOME_RISE_STUDIO_TITLE]);
    expect(rows.every((row) => !/\bNO\b/.test(row.textContent ?? ""))).toBe(true);
    // The time stays on one line.
    expect((target.querySelector("[data-testid='brief-date']") as HTMLElement).style.whiteSpace).toBe("nowrap");
    expect(text).toContain("412");
    expect(text).not.toMatch(/no sessions/i);
    expect(text).not.toContain("Corey");
    expect(text).not.toMatch(/SAMPLE|Sample/);
  });
});
