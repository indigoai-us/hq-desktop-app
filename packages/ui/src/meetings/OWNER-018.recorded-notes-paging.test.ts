// @vitest-environment happy-dom
/**
 * OWNER-018: a recorded meeting with more saved notes than one read page
 * (24 bodies) shows the first page right away and reaches the rest through
 * "Load more". No note is dropped, and order matches the server's ref order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ok } from "@hq/platform";

vi.mock("./meetings-cache", () => ({
  loadMeetingsCache: vi.fn(() => null),
  saveMeetingsCache: vi.fn(),
}));

import { configureMeetingsApi, meetingsStore } from "./meetings-store.svelte";
import MeetingsStatesBody from "./MeetingsStatesBody.svelte";
import type { MeetingEvent } from "./meetings-model";
import {
  RECORDED_SIGNAL_READ_LIMIT,
  loadNextRecordedSignalPage,
  parseRecordedDetail,
  recordedSignalsFromPages,
  recordedSignalsRemaining,
  type RecordedSignalPages,
  type RecordedSignalRef,
} from "./recorded-meetings";

const url = (i: number) => `https://s3.example/d${i}`;

/** Detail envelope from hq-pro GET /v1/meetings/{id}: one summary, then `decisions` decisions. */
function detail(decisions: number) {
  return {
    meetingId: "big",
    signals: {
      summary: [{ slug: "s", presigned_url: "https://s3.example/s" }],
      decision: Array.from({ length: decisions }, (_, i) => ({ slug: `d${i}`, presigned_url: url(i) })),
    },
  };
}

function bodyFor(u: string): string {
  if (u.endsWith("/s")) return "---\ntype: summary\n---\nThe recap.";
  return `---\ntype: decision\n---\nDecision ${u.split("/d").pop()}`;
}

let fetchMock: ReturnType<typeof vi.fn<(u: string) => Promise<Response>>>;

function wire(decisions: number): void {
  configureMeetingsApi({
    accountId: "acct",
    sessionGeneration: 1,
    storage: null,
    meetings: {
      getRecorded: () => Promise.resolve(ok(detail(decisions))),
      readRecordedBody: async (u: string) => ok(await (await fetchMock(u)).text()),
    } as never,
    feedback: {} as never,
  });
}

beforeEach(() => {
  fetchMock = vi.fn(async (u: string) => new Response(bodyFor(u)));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  configureMeetingsApi(null);
  vi.unstubAllGlobals();
});

describe("recorded meeting notes past the first page", () => {
  it("renders every one of 31 saved notes once every page is loaded, in server order", async () => {
    wire(30);
    await meetingsStore.loadRecordedNotes("big", null);
    for (let guard = 0; meetingsStore.recordedNotes.big?.remaining && guard < 10; guard++) {
      await meetingsStore.loadMoreRecordedNotes("big");
    }
    const signals = meetingsStore.recordedNotes.big?.signals;
    expect(signals?.summary).toBe("The recap.");
    expect(signals?.decisions.map((d) => d.title)).toEqual(
      Array.from({ length: 30 }, (_, i) => `Decision ${i}`),
    );
    expect(meetingsStore.recordedNotes.big?.remaining).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(31);
  });

  it("reads only the first 24 bodies when the meeting opens", async () => {
    wire(30);
    await meetingsStore.loadRecordedNotes("big", null);
    expect(fetchMock).toHaveBeenCalledTimes(RECORDED_SIGNAL_READ_LIMIT);
    expect(RECORDED_SIGNAL_READ_LIMIT).toBe(24);
    const entry = meetingsStore.recordedNotes.big;
    expect(entry?.status).toBe("ready");
    expect(entry?.signals?.decisions).toHaveLength(23);
    expect(entry?.remaining).toBe(7);
  });
});

describe("recorded signal paging state", () => {
  const refs: RecordedSignalRef[] = parseRecordedDetail(detail(50));

  it("pages 24 at a time and counts what is left", async () => {
    const read = vi.fn(async (u: string) => bodyFor(u));
    let pages: RecordedSignalPages = { refs, texts: [] };
    expect(recordedSignalsRemaining(pages)).toBe(51);
    pages = await loadNextRecordedSignalPage(pages, read);
    expect(pages.texts).toHaveLength(24);
    expect(recordedSignalsRemaining(pages)).toBe(27);
    pages = await loadNextRecordedSignalPage(pages, read);
    pages = await loadNextRecordedSignalPage(pages, read);
    expect(recordedSignalsRemaining(pages)).toBe(0);
    expect(read).toHaveBeenCalledTimes(51);
    const again = await loadNextRecordedSignalPage(pages, read);
    expect(again.texts).toHaveLength(51);
    expect(read).toHaveBeenCalledTimes(51);
  });

  it("keeps an unreadable body as an empty slot so later notes stay aligned", async () => {
    const read = vi.fn(async (u: string) => {
      if (u === url(1)) throw new Error("expired");
      return bodyFor(u);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pages = await loadNextRecordedSignalPage({ refs: refs.slice(0, 4), texts: [] }, read);
    expect(warn).toHaveBeenCalled();
    expect(recordedSignalsFromPages(pages).decisions.map((d) => d.title)).toEqual(["Decision 0", "Decision 2"]);
    warn.mockRestore();
  });
});

describe("recap Load more control", () => {
  const mounted: ReturnType<typeof mount>[] = [];
  afterEach(() => {
    while (mounted.length) unmount(mounted.pop()!);
    document.body.innerHTML = "";
  });

  const event: MeetingEvent = {
    id: "recorded:big",
    summary: "Big meeting",
    status: "confirmed",
    start: { dateTime: "2026-09-29T10:00:00.000Z" },
    end: { dateTime: "2026-09-29T10:30:00.000Z" },
    recorded: { meetingId: "big", durationLabel: "30m", hasSignals: true },
    signals: { summary: "The recap.", decisions: [{ title: "Decision 0" }], actions: [], questions: [] },
  } as MeetingEvent;

  function render(props: Record<string, unknown>): HTMLElement {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(MeetingsStatesBody, { target, props: props as never }));
    flushSync();
    return target;
  }

  it("shows how many notes are left and asks for the next page", () => {
    const onloadmore = vi.fn();
    const el = render({ mode: "recap", event, now: new Date("2026-10-02T16:00:00Z"), notesRemaining: 12, onloadmore });
    expect(el.querySelector('[data-testid="recap-more-count"]')?.textContent).toBe("12 more notes");
    (el.querySelector('[data-testid="recap-load-more"]') as HTMLButtonElement).click();
    expect(onloadmore).toHaveBeenCalledTimes(1);
  });

  it("disables the control while a page is loading and hides it when nothing is left", () => {
    const busy = render({ mode: "recap", event, now: new Date("2026-10-02T16:00:00Z"), notesRemaining: 1, notesLoadingMore: true });
    const btn = busy.querySelector('[data-testid="recap-load-more"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(busy.querySelector('[data-testid="recap-more-count"]')?.textContent).toBe("1 more note");
    const done = render({ mode: "recap", event, now: new Date("2026-10-02T16:00:00Z"), notesRemaining: 0 });
    expect(done.querySelector('[data-testid="recap-more"]')).toBeNull();
  });
});
