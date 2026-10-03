// @vitest-environment happy-dom
/**
 * OWNER-019, round 27: the document-shaped fix (bacf2548) read the meeting
 * document and signal bodies with the webview's own `fetch`. The vault
 * buckets answer presigned GETs with no Access-Control-Allow-Origin header
 * and a 403 to the CORS preflight, so in the real desktop webview every read
 * failed; tests stubbed `fetch` and never saw it. The failed read then showed
 * "No notes for this meeting" and "Attendees unavailable".
 *
 * Fixture: the shapes hq-pro returned on 2026-10-03 for the Oct 1 13:00
 * Corey<>Jacob Standup and the Oct 2 13:00 richard@sender.agency meeting,
 * with ids, names, URLs and text replaced by placeholders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { failure, ok } from "@hq/platform";

vi.mock("./meetings-cache", () => ({
  loadMeetingsCache: vi.fn(() => null),
  saveMeetingsCache: vi.fn(),
}));

import { configureMeetingsApi, meetingsStore } from "./meetings-store.svelte";
import MeetingsStatesBody from "./MeetingsStatesBody.svelte";
import { parseRecordedMeetings, recordedToEvent, withRecordedDocument } from "./recorded-meetings";

const VAULT = "https://hq-vault-cmp-example.s3.us-east-1.amazonaws.com";
const signed = (key: string) => `${VAULT}/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=sig`;

const frontmatterKeys = {
  id: "meeting:m-1",
  channel: "meeting",
  source_id: "m-1",
  source_ref: { channel: "meeting", source_id: "m-1", key: "sources/meetings/m-1.md" },
  title: "Person A<>Person B Standup",
  origin: "recall.ai",
  company_id: "cmp_EXAMPLE",
  person_uid: "prs_EXAMPLE",
  account_id: "acct_EXAMPLE",
  meeting_url: "https://meet.example/abc",
  meeting_platform: "google_meet",
  calendar_event_id: "evt-1",
  scheduled_start_time: "2026-10-01T13:00:00-06:00",
  created_at: "2026-09-30T00:00:00.000Z",
  updated_at: "2026-10-01T20:00:00.000Z",
  ingested_at: "2026-10-01T20:00:00.000Z",
  recall_bot_id: "m-1",
  auto_scheduled: true,
  bot_status: "completed",
};

// GET /v1/meetings/{id}?companyId= — top-level keys exactly as returned.
const standupDetail = {
  meetingId: "m-1",
  sourceShape: "markdown",
  source: { path: "sources/meetings/m-1.md", presigned_url: signed("sources/meetings/m-1.md"), frontmatter: frontmatterKeys },
  signals: {
    summary: [{ slug: "s1", path: "signals/s1.md", presigned_url: signed("signals/s1.md") }],
    decision: [
      { slug: "d1", path: "signals/d1.md", presigned_url: signed("signals/d1.md") },
      { slug: "d2", path: "signals/d2.md", presigned_url: signed("signals/d2.md") },
    ],
  },
};
// The richard@ meeting: same shape, no signals.
const noSignalDetail = { ...standupDetail, meetingId: "m-2", signals: {} };

// The document behind source.presigned_url: frontmatter, then one
// `## Transcript` section of `**Speaker** · `[hh:mm:ss–hh:mm:ss]`` turns.
const documentBody = [
  "---",
  "id: meeting:m-1",
  "channel: meeting",
  "title: Person A<>Person B Standup",
  "bot_status: completed",
  "---",
  "## Transcript",
  "",
  "**Person A** · `[00:00:01–00:00:04]`",
  "",
  "Placeholder line one.",
  "",
  "**Person B** · `[00:00:05–00:00:09]`",
  "",
  "Placeholder line two.",
  "",
].join("\n");

const bodies: Record<string, string> = {
  "sources/meetings/m-1.md": documentBody,
  "signals/s1.md": "---\ntype: summary\n---\nPlaceholder recap.",
  "signals/d1.md": "---\ntype: decision\n---\nPlaceholder decision one.",
  "signals/d2.md": "---\ntype: decision\n---\nPlaceholder decision two.",
};
const keyOf = (u: string) => new URL(u).pathname.slice(1);

// What the desktop webview does with a cross-origin GET the bucket does not
// allow: the request rejects before any response is visible.
const webviewFetch = vi.fn(async () => {
  throw new TypeError("Load failed");
});
const nativeRead = vi.fn(async (u: string) => ok(bodies[keyOf(u)] ?? ""));

function wire(detail: unknown, read = nativeRead): void {
  configureMeetingsApi({
    accountId: "acct",
    sessionGeneration: 1,
    storage: null,
    meetings: {
      getRecorded: () => Promise.resolve(ok(detail)),
      readRecordedBody: read,
    } as never,
    feedback: {} as never,
  });
}

const listRow = parseRecordedMeetings({
  meetings: [
    {
      meetingId: "m-1",
      sourceShape: "markdown",
      title: "Person A<>Person B Standup",
      startTime: "2026-10-01T13:00:00-06:00",
      channel: "meeting",
      ingested_at: "2026-10-01T20:00:00.000Z",
      hasSignals: true,
      companyId: "cmp_EXAMPLE",
      attributed: true,
    },
  ],
})[0]!;
const now = new Date("2026-10-03T15:00:00.000Z");

const mounted: ReturnType<typeof mount>[] = [];
function render(props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(MeetingsStatesBody, { target, props: props as never }));
  flushSync();
  return target;
}

beforeEach(() => {
  vi.stubGlobal("fetch", webviewFetch);
  webviewFetch.mockClear();
  nativeRead.mockClear();
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
  configureMeetingsApi(null);
  vi.unstubAllGlobals();
});

/** What MeetingCanvasHost hands the canvas for a loaded entry. */
function shown(id: string) {
  const entry = meetingsStore.recordedNotes[id]!;
  const base = recordedToEvent(listRow);
  return entry.signals ? withRecordedDocument({ ...base, signals: entry.signals }, entry.document) : base;
}

describe("recorded meeting bodies are read natively, not by the webview", () => {
  it("loads the standup's document and signals without the webview fetch", async () => {
    wire(standupDetail);
    await meetingsStore.loadRecordedNotes("m-1", "cmp_EXAMPLE");
    const entry = meetingsStore.recordedNotes["m-1"];
    expect(entry?.status).toBe("ready");
    expect(webviewFetch).not.toHaveBeenCalled();
    expect(nativeRead).toHaveBeenCalledTimes(4);
    expect(entry?.signals?.summary).toBe("Placeholder recap.");
    expect(entry?.document?.transcript.map((t) => t.speaker)).toEqual(["Person A", "Person B"]);
  });

  it("renders recap, transcript and speakers for the standup", async () => {
    wire(standupDetail);
    await meetingsStore.loadRecordedNotes("m-1", "cmp_EXAMPLE");
    const el = render({ mode: "recap", event: shown("m-1"), now });
    expect(el.textContent).not.toContain("No notes for this meeting");
    expect(el.querySelector('[data-testid="meeting-tabs"]')).not.toBeNull();
    expect(el.textContent).toContain("Placeholder recap.");
    const names = Array.from(el.querySelectorAll('[data-testid="meeting-attendee"]')).map((n) => n.textContent);
    expect(names.join("|")).toContain("Person A");
    expect(names.join("|")).toContain("Person B");
    expect(el.querySelector('[data-testid="meeting-attendees-unavailable"]')).toBeNull();
  });

  it("renders the transcript for a meeting with no signals", async () => {
    wire(noSignalDetail);
    await meetingsStore.loadRecordedNotes("m-2", "cmp_EXAMPLE");
    expect(meetingsStore.recordedNotes["m-2"]?.status).toBe("ready");
    const el = render({ mode: "recap", event: shown("m-2"), now });
    expect(el.textContent).not.toContain("No notes for this meeting");
    const transcriptTab = Array.from(el.querySelectorAll("button.tab")).find((b) => b.textContent === "Transcript") as HTMLButtonElement;
    transcriptTab.click();
    flushSync();
    expect(el.textContent).toContain("Placeholder line two.");
  });
});

describe("a failed read is not an empty meeting", () => {
  it("shows Couldn't load and Try again, never \"No notes\"", async () => {
    wire(noSignalDetail, vi.fn(async () => failure("network", "meeting notes HTTP 403")) as never);
    await meetingsStore.loadRecordedNotes("m-3", "cmp_EXAMPLE");
    expect(meetingsStore.recordedNotes["m-3"]?.status).toBe("error");
    const onretrynotes = vi.fn();
    const el = render({ mode: "recap", event: recordedToEvent(listRow), now, notesFailed: true, onretrynotes });
    expect(el.textContent).not.toContain("No notes for this meeting");
    expect(el.querySelector('[data-testid="meeting-notes-failed"]')?.textContent).toContain("Couldn't load the notes.");
    expect(el.textContent).not.toContain("403");
    (el.querySelector('[data-testid="meeting-notes-retry"]') as HTMLButtonElement).click();
    expect(onretrynotes).toHaveBeenCalledTimes(1);
  });

  it("Try again reads the meeting again after a failure", async () => {
    const flaky = vi
      .fn()
      .mockResolvedValueOnce(failure("network", "offline"))
      .mockImplementation(async (u: string) => ok(bodies[keyOf(u)] ?? ""));
    wire(noSignalDetail, flaky as never);
    await meetingsStore.loadRecordedNotes("m-4", "cmp_EXAMPLE");
    expect(meetingsStore.recordedNotes["m-4"]?.status).toBe("error");
    await meetingsStore.loadRecordedNotes("m-4", "cmp_EXAMPLE");
    expect(meetingsStore.recordedNotes["m-4"]?.status).toBe("error");
    await meetingsStore.loadRecordedNotes("m-4", "cmp_EXAMPLE", { retry: true });
    expect(meetingsStore.recordedNotes["m-4"]?.status).toBe("ready");
    expect(meetingsStore.recordedNotes["m-4"]?.document?.transcript).toHaveLength(2);
  });
});

/**
 * OWNER-019 part 2 (round 29): the Oct 1 company standup still failed while
 * the Oct 2 personal meeting loaded. Its detail call (company scope, three
 * signals) answers in 14-16 s and the shared native bound was 15 s, so the
 * detail read timed out. These cover what the store does with that shape.
 */
describe("OWNER-019 part 2: partial reads and fresh links", () => {
  it("a failed signal read still shows the transcript, with its own Try again", async () => {
    const read = vi.fn(async (u: string) =>
      keyOf(u).startsWith("signals/") ? failure("network", "meeting notes HTTP 403") : ok(bodies[keyOf(u)] ?? ""),
    );
    wire(standupDetail, read as never);
    await meetingsStore.loadRecordedNotes("m-5", "cmp_EXAMPLE");
    const entry = meetingsStore.recordedNotes["m-5"];
    expect(entry?.status).toBe("ready");
    expect(entry?.recapFailed).toBe(true);
    expect(entry?.document?.transcript).toHaveLength(2);
    const onretrynotes = vi.fn();
    const el = render({ mode: "recap", event: shown("m-5"), now, recapFailed: entry?.recapFailed, onretrynotes });
    expect(el.querySelector('[data-testid="meeting-tabs"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="meeting-notes-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="meeting-recap-failed"]')?.textContent).toContain("Couldn't load part of the recap.");
    expect(el.textContent).not.toContain("403");
    (el.querySelector('[data-testid="meeting-recap-retry"]') as HTMLButtonElement).click();
    expect(onretrynotes).toHaveBeenCalledTimes(1);
  });

  it("Try again refetches the detail and reads the fresh links, not the stale ones", async () => {
    let generation = 0;
    const getRecorded = vi.fn(async () => {
      generation += 1;
      const g = generation;
      const fresh = (key: string) => `${signed(key)}&gen=${g}`;
      return ok({
        ...standupDetail,
        source: { ...standupDetail.source, presigned_url: fresh("sources/meetings/m-1.md") },
        signals: { summary: [{ slug: "s1", path: "signals/s1.md", presigned_url: fresh("signals/s1.md") }] },
      });
    });
    const seen: string[] = [];
    const read = vi.fn(async (u: string) => {
      seen.push(new URL(u).searchParams.get("gen") ?? "");
      // Links from the first detail have expired.
      return new URL(u).searchParams.get("gen") === "1" ? failure("network", "meeting notes HTTP 403") : ok(bodies[keyOf(u)] ?? "");
    });
    configureMeetingsApi({
      accountId: "acct",
      sessionGeneration: 1,
      storage: null,
      meetings: { getRecorded, readRecordedBody: read } as never,
      feedback: {} as never,
    });
    await meetingsStore.loadRecordedNotes("m-6", "cmp_EXAMPLE");
    expect(meetingsStore.recordedNotes["m-6"]?.status).toBe("error");
    await meetingsStore.loadRecordedNotes("m-6", "cmp_EXAMPLE", { retry: true });
    expect(getRecorded).toHaveBeenCalledTimes(2);
    expect(seen.slice(-2)).toEqual(["2", "2"]);
    expect(meetingsStore.recordedNotes["m-6"]?.status).toBe("ready");
    expect(meetingsStore.recordedNotes["m-6"]?.signals?.summary).toBe("Placeholder recap.");
  });

  it("Try again after a partial recap failure reads the meeting again", async () => {
    let fail = true;
    const read = vi.fn(async (u: string) =>
      fail && keyOf(u).startsWith("signals/") ? failure("network", "offline") : ok(bodies[keyOf(u)] ?? ""),
    );
    wire(standupDetail, read as never);
    await meetingsStore.loadRecordedNotes("m-7", "cmp_EXAMPLE");
    expect(meetingsStore.recordedNotes["m-7"]?.recapFailed).toBe(true);
    fail = false;
    await meetingsStore.loadRecordedNotes("m-7", "cmp_EXAMPLE", { retry: true });
    expect(meetingsStore.recordedNotes["m-7"]?.recapFailed).toBe(false);
    expect(meetingsStore.recordedNotes["m-7"]?.signals?.decisions).toHaveLength(2);
  });
});

/**
 * OWNER-R2 (2026-10-03 16:45Z): most meetings in "Your meetings" showed
 * "Couldn't load the notes". The list is painted from the local cache first;
 * the cache stores parsed rows (`companyUid`), and hydration re-parsed them
 * reading only the wire field `companyId`, so every cached row lost its
 * company. Its detail was then read unscoped, and hq-pro answers an unscoped
 * read of a company meeting with 404 meeting-not-found (measured for all four
 * Sep 23 meetings; scoped reads returned 200).
 */
describe("OWNER-R2: cached rows keep their company", () => {
  const wireRow = {
    meetingId: "m-8",
    sourceShape: "markdown",
    title: "Person A<>Person B Standup",
    startTime: "2026-09-23T09:00:00-06:00",
    channel: "meeting",
    ingested_at: "2026-09-23T16:00:00.000Z",
    hasSignals: true,
    companyId: "cmp_EXAMPLE",
    attributed: true,
  };

  it("a row read back from the cache keeps its company", () => {
    const parsed = parseRecordedMeetings({ meetings: [wireRow] });
    const cached = JSON.parse(JSON.stringify(parsed));
    expect(parseRecordedMeetings(cached)).toEqual(parsed);
    expect(parseRecordedMeetings(cached)[0]?.companyUid).toBe("cmp_EXAMPLE");
  });

  it("opening a cached company meeting reads its detail in that company and shows the transcript", async () => {
    const getRecorded = vi.fn(async (_id: string, companyId: string | null) =>
      companyId === "cmp_EXAMPLE"
        ? ok(standupDetail)
        : failure("http-404", "Meeting not found"),
    );
    configureMeetingsApi({
      accountId: "acct",
      sessionGeneration: 1,
      storage: null,
      meetings: { getRecorded, readRecordedBody: nativeRead } as never,
      feedback: {} as never,
    });
    const cachedRow = parseRecordedMeetings(JSON.parse(JSON.stringify(parseRecordedMeetings({ meetings: [wireRow] }))))[0]!;
    const event = recordedToEvent(cachedRow);
    await meetingsStore.loadRecordedNotes("m-8", event.sourceCompanyUid ?? null);
    expect(getRecorded).toHaveBeenCalledWith("m-8", "cmp_EXAMPLE");
    expect(meetingsStore.recordedNotes["m-8"]?.status).toBe("ready");
    expect(meetingsStore.recordedNotes["m-8"]?.document?.transcript).toHaveLength(2);
  });

  it("a read that failed without a company is read again once the row knows its company", async () => {
    const getRecorded = vi.fn(async (_id: string, companyId: string | null) =>
      companyId ? ok(standupDetail) : failure("http-404", "Meeting not found"),
    );
    configureMeetingsApi({
      accountId: "acct",
      sessionGeneration: 1,
      storage: null,
      meetings: { getRecorded, readRecordedBody: nativeRead } as never,
      feedback: {} as never,
    });
    await meetingsStore.loadRecordedNotes("m-9", null);
    expect(meetingsStore.recordedNotes["m-9"]?.status).toBe("error");
    await meetingsStore.loadRecordedNotes("m-9", "cmp_EXAMPLE");
    expect(meetingsStore.recordedNotes["m-9"]?.status).toBe("ready");
  });

  it("a meeting with a transcript and no saved recap says so plainly, not as an error", async () => {
    wire(noSignalDetail);
    await meetingsStore.loadRecordedNotes("m-10", "cmp_EXAMPLE");
    const el = render({ mode: "recap", event: shown("m-10"), now });
    expect(el.querySelector('[data-testid="meeting-tabs"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="meeting-recap-none"]')?.textContent).toBe("There is no recap for this meeting yet.");
    expect(el.querySelector('[data-testid="meeting-notes-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="meeting-attendees-unavailable"]')).toBeNull();
  });
});
