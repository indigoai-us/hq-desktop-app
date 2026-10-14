// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { renderMarkdown } from "../common/markdown.js";
import { normalizeRecapMarkdown, segmentFlatRecap } from "./recap-markdown";
import { loadRecordedSignals, signalBodyMarkdown } from "./recorded-meetings";
import { nextStepsFromSummary, recapDetailsLine, recapModel, venueLabel } from "./meeting-states-model";
import MeetingsStatesBody from "./MeetingsStatesBody.svelte";
import type { MeetingEvent } from "./meetings-model";

// Shape of the HQ GTM Sync (Oct 5) summary signal as stored in the vault.
const SIGNAL = `---
type: summary
source_ref: sources/meetings/m1.md
---
## Summary

**Meeting:** HQ GTM Sync — 2026-10-05
**Participants:** Corey Epstein, Jacob Posel

### Key Topics

1. **Google Ads Update** — ~$400 spent, 3 sign-ups.
2. **Attribution / CDP** — contact tagging.
3. **LinkedIn Plagiarism Issue** — agency article flagged.

### Next Steps
- Jacob to close loop on Stripe payouts for referrals.
- Cherie to remind Stefan about automation connections needed.
- Team to launch next bot/feature on Wednesday.
- Jacob to put together backlog of upcoming launches.
- Meta Ads moving to $50/day with Cherie this week.
- Corey/Cherie/Jonathan to explore UGC sourcing via Tribe.
`;

const FLAT =
  "Summary **Meeting:** HQ GTM Sync — 2026-10-05 **Participants:** Corey Epstein, Jacob Posel Key Topics 1. **Google Ads Update** — ~$400 spent. 2. **Attribution / CDP** — tagging. 3. **LinkedIn Plagiarism Issue** — flagged. Next Steps - Jacob to close loop on payouts. - Cherie to remind Stefan. - Team to launch Wednesday.";

function dom(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

function renderRecap(signals: Record<string, unknown>): HTMLElement {
  const event = {
    id: "recorded:m1",
    summary: "HQ GTM Sync",
    status: "confirmed",
    start: { dateTime: "2026-10-05T16:30:00.000Z" },
    end: { dateTime: "2026-10-05T17:00:00.000Z" },
    recorded: { meetingId: "m1", durationLabel: "30m", hasSignals: true },
    signals,
  } as MeetingEvent;
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(MeetingsStatesBody, { target, props: { mode: "recap", event, now: new Date("2026-10-06T16:00:00Z") } as never }));
  flushSync();
  return target;
}

describe("recap structure", () => {
  it("keeps a summary signal's headings and lists and drops the duplicate Summary heading", async () => {
    const md = signalBodyMarkdown(SIGNAL);
    expect(md.startsWith("**Meeting:**")).toBe(true);
    const signals = await loadRecordedSignals([{ kind: "summary", title: null, url: "u" }], async () => SIGNAL);
    const el = dom(renderMarkdown(normalizeRecapMarkdown(signals.summary, "HQ GTM Sync")));
    expect([...el.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Key Topics", "Next Steps"]);
    expect(el.querySelectorAll("ol > li")).toHaveLength(3);
    expect(el.querySelectorAll("ul > li")).toHaveLength(6);
    expect(el.textContent).not.toMatch(/^\s*Summary/);
  });

  it("re-segments a recap that lost its newlines upstream", () => {
    const md = normalizeRecapMarkdown(FLAT, "HQ GTM Sync");
    expect(md).toBe(segmentFlatRecap(FLAT));
    const el = dom(renderMarkdown(md));
    expect([...el.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Key Topics", "Next Steps"]);
    expect([...el.querySelectorAll("ol > li")].map((li) => li.textContent?.split(" —")[0])).toEqual([
      "Google Ads Update",
      "Attribution / CDP",
      "LinkedIn Plagiarism Issue",
    ]);
    expect(el.querySelectorAll("ul > li")).toHaveLength(3);
    expect(el.textContent).not.toContain("Summary");
  });

  it("counts the summary's Next Steps as actions when no action signals were extracted", () => {
    const summary = signalBodyMarkdown(SIGNAL);
    expect(nextStepsFromSummary(summary)).toHaveLength(6);
    const model = recapModel({ id: "m1", start: {}, end: {}, signals: { summary } } as MeetingEvent);
    expect(model.actions).toHaveLength(6);
    expect(model.actions.every((a) => a.derived)).toBe(true);
    expect(recapDetailsLine(model)).toBe("6 actions");
  });

  it("prefers extracted action signals over the summary list", () => {
    const model = recapModel({
      id: "m1",
      start: {},
      end: {},
      signals: { summary: signalBodyMarkdown(SIGNAL), actions: [{ title: "Ship it" }] },
    } as MeetingEvent);
    expect(model.actions.map((a) => a.title)).toEqual(["Ship it"]);
  });

  it("recap view: block elements, 6 actions in Details, no duplicate action list, no 'No link'", () => {
    const el = renderRecap({ summary: signalBodyMarkdown(SIGNAL) });
    const summary = el.querySelector('[data-testid="recap-summary"]')!;
    expect(summary.querySelectorAll("h3")).toHaveLength(2);
    expect(summary.querySelectorAll("li")).toHaveLength(9);
    expect(el.querySelector('[data-testid="meeting-details-counts"]')?.textContent).toBe("6 actions");
    expect(el.querySelectorAll('[data-testid="recap-action"]')).toHaveLength(0);
    expect(el.textContent).not.toContain("No link");
    expect(el.textContent).not.toMatch(/0 decisions|0 questions/);
  });

  it("recap view hides Details when nothing was extracted", () => {
    const el = renderRecap({ summary: "Short chat with no follow-ups." });
    expect(el.querySelector('[data-testid="meeting-details-counts"]')).toBeNull();
    expect(el.textContent).not.toContain("0 decisions");
  });

  it("has no details line when every count is zero and no venue text without a link", () => {
    expect(recapDetailsLine({ decisions: [], actions: [], questions: [] })).toBe("");
    expect(venueLabel({ id: "x", start: {}, end: {} } as MeetingEvent)).toBe("");
  });
});
