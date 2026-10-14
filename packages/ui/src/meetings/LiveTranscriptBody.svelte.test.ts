// @vitest-environment happy-dom
/**
 * Live Transcript tab rendering with a mocked transport: speaker turns, the
 * greyed in-progress line, the dot+text status, auto-follow, and the honest
 * empty states. Also the canvas copy when no notetaker is in the meeting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { AdapterResult, LiveTranscriptResult } from "@hq/platform";
import LiveTranscriptBody from "./LiveTranscriptBody.svelte";
import MeetingCanvas from "./MeetingCanvas.svelte";
import type { MeetingEvent, ScheduledBot } from "./meetings-model";

type Reply = AdapterResult<LiveTranscriptResult>;

const mounted: Array<ReturnType<typeof mount>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function scroller(): HTMLElement {
  const el = document.createElement("div");
  el.style.overflowY = "auto";
  let top = 0;
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 1000 + el.querySelectorAll("[data-testid=live-turn]").length * 40 });
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });
  document.body.appendChild(el);
  return el;
}

function render(component: any, props: Record<string, unknown>, target: HTMLElement = scroller()): HTMLElement {
  mounted.push(mount(component, { target, props }));
  flushSync();
  return target;
}

function transport(replies: Reply[]) {
  return vi.fn(async (): Promise<Reply> => replies.shift() ?? { ok: true, value: { kind: "not-modified" } });
}

const ok = (revision: number, segments: Array<[string, string, number, string]>, partial: { speaker: string; startSeconds: number; text: string } | null = null): Reply => ({
  ok: true,
  value: {
    kind: "ok",
    revision,
    etag: `"e${revision}"`,
    segments: segments.map(([segmentId, speaker, startSeconds, text]) => ({ segmentId, speaker, startSeconds, endSeconds: startSeconds + 2, text })),
    partial,
  },
});

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  flushSync();
}

describe("LiveTranscriptBody", () => {
  it("renders speaker turns, the greyed partial and the in-meeting status", async () => {
    const fetch = transport([
      ok(3, [
        ["a", "Corey", 812, "Morning all."],
        ["b", "Corey", 815, "Quick one today."],
        ["c", "Eric", 820, "Sounds good."],
      ], { speaker: "Stefan", startSeconds: 823, text: "I have a" }),
    ]);
    const el = render(LiveTranscriptBody, { recallBotId: "bot_1", companyId: "cmp_A", live: true, botStatus: "in_call_recording", fetch });
    await settle();

    const status = el.querySelector("[data-testid=live-transcript-status]")!;
    expect(status.textContent?.trim()).toBe("Notetaker is in the meeting");
    expect(status.querySelector(".dot.on")).not.toBeNull();

    const turns = [...el.querySelectorAll("[data-testid=live-turn]")].map((t) => [
      t.querySelector("b")?.textContent,
      t.querySelector(".hd span")?.textContent,
      t.querySelector("p")?.textContent,
    ]);
    expect(turns).toEqual([
      ["Corey", "13:32", "Morning all. Quick one today."],
      ["Eric", "13:40", "Sounds good."],
    ]);
    const partial = el.querySelector("[data-testid=live-partial]")!;
    expect(partial.classList.contains("partial")).toBe(true);
    expect(partial.textContent).toContain("I have a");
  });

  it("appends new lines as they arrive and follows unless the reader scrolled up", async () => {
    const fetch = transport([ok(1, [["a", "Corey", 1, "one"]]), ok(2, [["b", "Eric", 5, "two"]]), ok(3, [["c", "Corey", 9, "three"]])]);
    const el = render(LiveTranscriptBody, { recallBotId: "bot_1", companyId: "cmp_A", live: true, botStatus: "recording", fetch });
    await settle();
    expect(el.scrollTop).toBe(el.scrollHeight);

    await settle(3_000);
    expect(el.querySelectorAll("[data-testid=live-turn]")).toHaveLength(2);
    expect(el.scrollTop).toBe(el.scrollHeight);

    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
    await settle(3_000);
    expect(el.querySelectorAll("[data-testid=live-turn]")).toHaveLength(3);
    expect(el.scrollTop).toBe(100);
  });

  it("says it is listening when the server has no live view yet", async () => {
    const fetch = transport([{ ok: true, value: { kind: "not-found" } }]);
    const el = render(LiveTranscriptBody, { recallBotId: "bot_1", companyId: "cmp_A", live: true, botStatus: "joining", fetch });
    await settle();
    expect(el.querySelector("[data-testid=live-transcript-status]")?.textContent?.trim()).toBe("Notetaker is joining");
    expect(el.querySelector("[data-testid=live-transcript-empty]")?.textContent).toBe(
      "Listening. Lines appear here as people talk.",
    );
  });

  it("is honest when live transcripts are off", async () => {
    const fetch = transport([{ ok: true, value: { kind: "disabled" } }]);
    const el = render(LiveTranscriptBody, { recallBotId: "bot_1", companyId: "cmp_A", live: true, botStatus: "recording", fetch });
    await settle();
    expect(el.querySelector("[data-testid=live-transcript-empty]")?.textContent).toMatch(/^Live transcript is off for this meeting\./);
  });

  it("is honest when this host cannot fetch a live transcript", async () => {
    const el = render(LiveTranscriptBody, { recallBotId: "bot_1", companyId: "cmp_A", live: true, botStatus: "recording", fetch: null });
    await settle();
    expect(el.querySelector("[data-testid=live-transcript-empty]")?.textContent).toMatch(/^Live transcript isn't available here\./);
  });

  it("never shows raw error text after failed polls", async () => {
    const fail: Reply = { ok: false, reason: "error", code: "http-500", message: "live-transcript HTTP 500" };
    const fetch = vi.fn(async (): Promise<Reply> => fail);
    const el = render(LiveTranscriptBody, { recallBotId: "bot_1", companyId: "cmp_A", live: true, botStatus: "recording", fetch });
    await settle(9_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(el.textContent).not.toMatch(/500|HTTP|error/i);
    expect(el.querySelector("[data-testid=live-transcript-empty]")?.textContent).toBe("Connecting to the notetaker…");
  });

  it("stops polling once the meeting is no longer live", async () => {
    const fetch = transport([ok(1, [["a", "Corey", 1, "one"]])]);
    const target = scroller();
    const props = $state({ recallBotId: "bot_1", companyId: "cmp_A", live: true, botStatus: "recording", fetch });
    render(LiveTranscriptBody, props, target);
    await settle();
    props.live = false;
    flushSync();
    await settle(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(target.querySelector("[data-testid=live-transcript-status]")?.textContent?.trim()).toBe("Notetaker has left the meeting");
    expect(target.querySelectorAll("[data-testid=live-turn]")).toHaveLength(1);
  });
});

describe("MeetingCanvas Transcript tab", () => {
  const now = new Date(2026, 9, 1, 10, 14);
  const event: MeetingEvent = {
    id: "standup",
    summary: "Indigo dev standup",
    status: "confirmed",
    start: { dateTime: new Date(2026, 9, 1, 10).toISOString() },
    end: { dateTime: new Date(2026, 9, 1, 10, 30).toISOString() },
    meetingUrl: "https://zoom.us/j/1",
  };

  function openTranscript(el: HTMLElement): void {
    const tab = [...el.querySelectorAll("button.tab")].find((b) => b.textContent === "Transcript") as HTMLButtonElement;
    tab.click();
    flushSync();
  }

  it("says there is no notetaker when no bot is in the meeting", () => {
    const el = render(MeetingCanvas, { event, now }, document.body.appendChild(document.createElement("div")));
    openTranscript(el);
    expect(el.querySelector("[data-testid=live-transcript-no-bot]")?.textContent).toBe("No notetaker in this meeting.");
  });

  it("opens the live transcript door when a notetaker is in the meeting", () => {
    const bot: ScheduledBot = {
      botId: "bot_1",
      meetingUrl: "https://zoom.us/j/1",
      platform: "zoom",
      status: "in_call_recording",
      autoScheduled: false,
      companyId: "cmp_A",
    };
    const el = render(MeetingCanvas, { event, bot, now }, document.body.appendChild(document.createElement("div")));
    openTranscript(el);
    expect(el.querySelector("[data-testid=live-transcript-no-bot]")).toBeNull();
    expect(el.querySelector("[data-testid=live-transcript-skeleton]")?.textContent).toBe("Connecting to the notetaker…");
  });
});
