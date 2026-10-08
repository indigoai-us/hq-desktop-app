// @vitest-environment happy-dom
/**
 * OWNER-R25: meeting recap text renders as Markdown through the shared
 * renderer. Fixture follows the Sep 18 standup recap shape the owner saw:
 * one flattened line with inline bold labels and " - " items, and decision
 * rows carrying "Decision:", "**Decided by:**" and "**Reasoning:**" inline.
 * Names and text are placeholders.
 */
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MeetingsStatesBody from "./MeetingsStatesBody.svelte";
import type { MeetingEvent } from "./meetings-model";
import { decisionParts, normalizeRecapMarkdown } from "./recap-markdown";
import { recapModel } from "./meeting-states-model";

const TITLE = "Team Dev Standup";
const FLAT_SUMMARY =
  "Team Dev Standup - Sep 18 **Participants:** Person A, Person B, Person C **Purpose:** Daily sync on the desktop release. " +
  "**Major Outcomes:** - Release candidate is cut - Sign-in fix is verified - Windows build is green " +
  "**Next Steps:** - Person A ships the beta - Person B writes the notes";

const DECISION =
  "Decision: Ship the beta on Friday **Decided by:** Person A **Reasoning:** The sign-in fix is verified and the long-term plan is on track.";

describe("normalizeRecapMarkdown", () => {
  it("turns inline bold labels into paragraphs and their items into lists", () => {
    expect(normalizeRecapMarkdown(FLAT_SUMMARY, TITLE)).toBe(
      [
        "**Participants:** Person A, Person B, Person C",
        "**Purpose:** Daily sync on the desktop release.",
        "**Major Outcomes:**\n\n- Release candidate is cut\n- Sign-in fix is verified\n- Windows build is green",
        "**Next Steps:**\n\n- Person A ships the beta\n- Person B writes the notes",
      ].join("\n\n"),
    );
  });

  it("keeps a sentence with a hyphen as a sentence", () => {
    const text = "**Purpose:** Review the long-term plan - and the short one.";
    expect(normalizeRecapMarkdown(text)).toBe(text);
  });

  it("leaves already structured text alone", () => {
    const text = "## Summary\n\n- one\n- two";
    expect(normalizeRecapMarkdown(text, TITLE)).toBe(text);
  });
});

describe("decisionParts", () => {
  it("drops the repeated prefix and splits the labeled lines", () => {
    expect(decisionParts(DECISION)).toEqual({
      title: "Ship the beta on Friday",
      decidedBy: "Person A",
      reasoning: "The sign-in fix is verified and the long-term plan is on track.",
    });
    expect(decisionParts("**Decision:** Keep the old flow")).toEqual({ title: "Keep the old flow", decidedBy: "", reasoning: "" });
  });
});

describe("recap renders Markdown", () => {
  const mounted: ReturnType<typeof mount>[] = [];
  afterEach(() => {
    while (mounted.length) unmount(mounted.pop()!);
    document.body.innerHTML = "";
  });

  function render(signals: Record<string, unknown>, notes?: MeetingEvent["notes"]): HTMLElement {
    const event = {
      id: "recorded:standup",
      summary: TITLE,
      status: "confirmed",
      start: { dateTime: "2026-09-18T15:00:00.000Z" },
      end: { dateTime: "2026-09-18T15:30:00.000Z" },
      recorded: { meetingId: "standup", durationLabel: "30m", hasSignals: true },
      signals,
      notes,
    } as MeetingEvent;
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(MeetingsStatesBody, { target, props: { mode: "recap", event, now: new Date("2026-10-03T16:00:00Z") } as never }));
    flushSync();
    return target;
  }

  it("summary: labeled paragraphs, bold, lists; no literal asterisks", () => {
    const el = render({ summary: FLAT_SUMMARY, decisions: [{ title: DECISION }], actions: [], questions: [] });
    const summary = el.querySelector('[data-testid="recap-summary"]')!;
    expect(summary.querySelectorAll("strong").length).toBe(4);
    expect(summary.querySelectorAll("ul").length).toBe(2);
    expect(summary.querySelectorAll("li").length).toBe(5);
    expect(summary.textContent).not.toContain("**");
    expect(summary.textContent).not.toContain("Sep 18");
  });

  it("decision: title without the prefix, labeled lines, and no placeholder dashes", () => {
    const el = render({ summary: "", decisions: [{ title: DECISION }], actions: [], questions: [] });
    const row = el.querySelector('[data-testid="recap-decision"]')!;
    expect(row.querySelector('[data-testid="decision-title"]')?.textContent).toBe("Ship the beta on Friday");
    expect(row.querySelector('[data-testid="decision-by"]')?.textContent).toBe("Decided by Person A");
    expect(row.querySelector('[data-testid="decision-reasoning"]')?.textContent).toContain("Reasoning The sign-in fix");
    expect(row.textContent).not.toContain("**");
    expect(row.textContent).not.toContain("—");
    expect(row.querySelector(".own")).toBeNull();
    expect(recapModel({ signals: { decisions: [{ title: "x" }] } } as MeetingEvent).decisions[0]!.owner).toBe("");
  });

  it("raw HTML and scripts in the source are not rendered", () => {
    const el = render({ summary: 'Hello <script>window.__pwned = 1</script><img src="https://x.example/a.png" onerror="alert(1)">', decisions: [], actions: [], questions: [] });
    const summary = el.querySelector('[data-testid="recap-summary"]')!;
    expect(summary.querySelector("script")).toBeNull();
    expect(summary.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("links open through the host opener, not inside the webview", () => {
    const el = render({ summary: "See [the plan](https://example.com/plan).", decisions: [], actions: [], questions: [] });
    const link = el.querySelector('[data-testid="recap-summary"] a') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("notes render Markdown too", () => {
    const el = render({ summary: "s", decisions: [], actions: [], questions: [] }, [{ id: "n1", author: "Person A", text: "**Bold** and *soft*" }] as never);
    const tab = Array.from(el.querySelectorAll("button.tab")).find((b) => b.textContent === "Notes") as HTMLButtonElement;
    expect(tab).toBeTruthy();
    tab.click();
    flushSync();
    const note = el.querySelector('[data-testid="meeting-note"]')!;
    expect(note.querySelector("strong")?.textContent).toBe("Bold");
    expect(note.querySelector("em")?.textContent).toBe("soft");
    expect(note.textContent).not.toContain("**");
  });
});
