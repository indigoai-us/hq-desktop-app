// @vitest-environment happy-dom
/**
 * Opening a recorded meeting ("HQ GTM Sync", Oct 7 12:30) sat on "Loading"
 * for both the notes and the attendees. The canvas waited for hq-pro's
 * meeting detail (14-16 s: it presigns every signal) and then for every
 * signal body before it showed anything, and attendees only came from the
 * transcript's speakers, so they waited too.
 *
 * Now the meeting's markdown, already synced to this computer, shows at once;
 * the recap fills in when the detail arrives; attendees come from the
 * matching calendar event. A meeting whose file is not here reads as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { failure, ok, type AdapterResult, type Json } from "@hq/platform";

vi.mock("./meetings-cache", () => ({
  loadMeetingsCache: vi.fn(() => null),
  saveMeetingsCache: vi.fn(),
}));

import { configureMeetingsApi, meetingsStore, type LocalMeetingDocument } from "./meetings-store.svelte";
import MeetingsStatesBody from "./MeetingsStatesBody.svelte";
import type { MeetingEvent } from "./meetings-model";
import { parseRecordedMeetings, withRecordedEvents, withRecordedNotes } from "./recorded-meetings";
import { createLocalMeetingDocumentReader, localMeetingDocumentPath } from "./local-meeting-document";

const signed = (key: string) => `https://vault.example/${key}?X-Amz-Signature=sig`;

const documentBody = [
  "---",
  "title: HQ GTM Sync",
  "---",
  "## Transcript",
  "",
  "**Corey** · `[00:00:01–00:00:04]`",
  "",
  "Pipeline first.",
  "",
  "**Jacob** · `[00:00:05–00:00:09]`",
  "",
  "Then the desktop beta.",
  "",
].join("\n");

const serverDocumentBody = documentBody.replace("Then the desktop beta.", "Then the desktop beta, from the server copy.");

function detailFor(id: string) {
  return {
    meetingId: id,
    sourceShape: "markdown",
    source: { path: `sources/meetings/${id}.md`, presigned_url: signed(`sources/meetings/${id}.md`), frontmatter: { title: "HQ GTM Sync" } },
    signals: {
      summary: [{ slug: "s1", presigned_url: signed("signals/s1.md") }],
      decision: [{ slug: "d1", presigned_url: signed("signals/d1.md") }],
    },
  };
}

const bodies: Record<string, string> = {
  "signals/s1.md": "---\ntype: summary\n---\nShip the beta Friday.",
  "signals/d1.md": "---\ntype: decision\n---\nCorey owns the launch post.",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function bodyRead() {
  return vi.fn(async (u: string): Promise<AdapterResult<string>> => {
    const key = new URL(u).pathname.slice(1);
    if (key.startsWith("sources/meetings/")) return ok(serverDocumentBody);
    return ok(bodies[key] ?? "");
  });
}

function wire(opts: {
  getRecorded: (id: string) => Promise<AdapterResult<Json>>;
  readRecordedBody: (u: string) => Promise<AdapterResult<string>>;
  local?: (id: string, companyUid: string | null) => Promise<LocalMeetingDocument | null>;
}): void {
  configureMeetingsApi({
    accountId: "acct",
    sessionGeneration: 1,
    storage: null,
    meetings: {
      getRecorded: (id: string) => opts.getRecorded(id),
      readRecordedBody: opts.readRecordedBody,
    } as never,
    feedback: {} as never,
    ...(opts.local ? { readLocalMeetingDocument: opts.local } : {}),
  });
}

const row = (id: string, title = "HQ GTM Sync", startTime = "2026-10-07T12:30:00-06:00") =>
  parseRecordedMeetings({ meetings: [{ meetingId: id, title, startTime, companyId: "cmp_INDIGO", hasSignals: true }] });

/** What MeetingCanvasHost hands the canvas. */
function shown(id: string, calendar: MeetingEvent[] = []): MeetingEvent {
  const event = withRecordedEvents(calendar, row(id)).find((e) => e.recorded?.meetingId === id)!;
  return withRecordedNotes(event, meetingsStore.recordedNotes[id]);
}

const now = new Date("2026-10-07T21:00:00.000Z");
const mounted: ReturnType<typeof mount>[] = [];
function render(props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(MeetingsStatesBody, { target, props: props as never }));
  flushSync();
  return target;
}
const names = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('[data-testid="meeting-attendee"]')).map((n) => n.textContent ?? "");

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
  configureMeetingsApi(null);
});

describe("a recorded meeting opens from its synced file", () => {
  it("shows the transcript and speakers before hq-pro's detail answers, then fills in the recap", async () => {
    const detail = deferred<AdapterResult<Json>>();
    const read = bodyRead();
    const local = vi.fn(async () => ({ text: documentBody, truncated: false }));
    wire({ getRecorded: () => detail.promise, readRecordedBody: read, local });

    const load = meetingsStore.loadRecordedNotes("gtm-1", "cmp_INDIGO");
    await vi.waitFor(() => expect(meetingsStore.recordedNotes["gtm-1"]?.document?.transcript).toHaveLength(2));
    expect(local).toHaveBeenCalledWith("gtm-1", "cmp_INDIGO");

    // The detail call has not answered yet.
    const entry = meetingsStore.recordedNotes["gtm-1"]!;
    expect(entry.status).toBe("loading");
    expect(entry.signals).toBeUndefined();
    expect(read).not.toHaveBeenCalled();

    const el = render({ mode: "recap", event: shown("gtm-1"), notesLoading: true, now });
    expect(el.querySelector('[data-testid="meeting-no-notes"]')).toBeNull();
    expect(el.querySelector('[data-testid="meeting-tabs"]')).not.toBeNull();
    // The recap is still being read: a loader, never "no recap".
    expect(el.querySelector('[data-testid="meeting-recap-loading"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="meeting-recap-none"]')).toBeNull();
    expect(el.querySelector('[data-testid="meeting-attendees-loading"]')).toBeNull();
    expect(names(el).join("|")).toContain("Corey");
    expect(names(el).join("|")).toContain("Jacob");
    const transcriptTab = Array.from(el.querySelectorAll("button.tab")).find((b) => b.textContent === "Transcript") as HTMLButtonElement;
    transcriptTab.click();
    flushSync();
    expect(el.textContent).toContain("Then the desktop beta.");

    detail.resolve(ok(detailFor("gtm-1")));
    await load;
    const done = meetingsStore.recordedNotes["gtm-1"]!;
    expect(done.status).toBe("ready");
    expect(done.signals?.summary).toBe("Ship the beta Friday.");
    expect(done.signals?.decisions.map((d) => d.title)).toEqual(["Corey owns the launch post."]);
    // The synced copy was whole, so the server's copy of the document is not read.
    expect(read.mock.calls.map(([u]) => new URL(u).pathname)).toEqual(["/signals/s1.md", "/signals/d1.md"]);
    expect(done.document?.transcript[1]?.text).toBe("Then the desktop beta.");
  });

  it("reads the meeting from hq-pro as before when the file is not on this computer", async () => {
    const read = bodyRead();
    const local = vi.fn(async () => null);
    wire({ getRecorded: async (id) => ok(detailFor(id)), readRecordedBody: read, local });

    await meetingsStore.loadRecordedNotes("gtm-2", "cmp_INDIGO");
    const entry = meetingsStore.recordedNotes["gtm-2"]!;
    expect(local).toHaveBeenCalledOnce();
    expect(entry.status).toBe("ready");
    expect(read).toHaveBeenCalledTimes(3);
    expect(entry.document?.transcript[1]?.text).toBe("Then the desktop beta, from the server copy.");
    expect(entry.signals?.summary).toBe("Ship the beta Friday.");
  });

  it("reads the meeting from hq-pro when the host has no local reader", async () => {
    const read = bodyRead();
    wire({ getRecorded: async (id) => ok(detailFor(id)), readRecordedBody: read });
    await meetingsStore.loadRecordedNotes("gtm-3", null);
    expect(meetingsStore.recordedNotes["gtm-3"]?.status).toBe("ready");
    expect(meetingsStore.recordedNotes["gtm-3"]?.document?.transcript).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("an unreadable synced file falls back to hq-pro without an error", async () => {
    const read = bodyRead();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    wire({
      getRecorded: async (id) => ok(detailFor(id)),
      readRecordedBody: read,
      local: async () => {
        throw new Error("company scope not bound");
      },
    });
    await meetingsStore.loadRecordedNotes("gtm-4", "cmp_INDIGO");
    expect(meetingsStore.recordedNotes["gtm-4"]?.status).toBe("ready");
    expect(meetingsStore.recordedNotes["gtm-4"]?.document?.transcript[1]?.text).toContain("from the server copy");
    warn.mockRestore();
  });

  it("a file read only in part is replaced by the server's whole copy", async () => {
    const read = bodyRead();
    wire({
      getRecorded: async (id) => ok(detailFor(id)),
      readRecordedBody: read,
      local: async () => ({ text: documentBody, truncated: true }),
    });
    await meetingsStore.loadRecordedNotes("gtm-5", "cmp_INDIGO");
    expect(read).toHaveBeenCalledTimes(3);
    expect(meetingsStore.recordedNotes["gtm-5"]?.document?.transcript[1]?.text).toContain("from the server copy");
  });

  it("keeps the synced transcript when hq-pro's detail fails, with Try again on the recap", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    wire({
      getRecorded: async () => failure("http-503", "upstream unavailable"),
      readRecordedBody: bodyRead(),
      local: async () => ({ text: documentBody, truncated: false }),
    });
    await meetingsStore.loadRecordedNotes("gtm-6", "cmp_INDIGO");
    const entry = meetingsStore.recordedNotes["gtm-6"]!;
    expect(entry.status).toBe("ready");
    expect(entry.recapFailed).toBe(true);
    expect(entry.document?.transcript).toHaveLength(2);
    const el = render({ mode: "recap", event: shown("gtm-6"), recapFailed: true, now });
    expect(el.querySelector('[data-testid="meeting-notes-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="meeting-recap-retry"]')).not.toBeNull();
    expect(el.textContent).not.toContain("upstream unavailable");
    error.mockRestore();
  });
});

describe("recorded meeting attendees come from the calendar event", () => {
  const calendarEvent: MeetingEvent = {
    id: "cal-gtm",
    summary: "HQ GTM Sync",
    status: "confirmed",
    start: { dateTime: "2026-10-07T12:32:00-06:00" },
    end: { dateTime: "2026-10-07T13:00:00-06:00" },
    attendees: [
      { email: "corey@example.com", displayName: "Corey", responseStatus: "accepted", organizer: true },
      { email: "jacob@example.com", displayName: "Jacob", responseStatus: "accepted" },
      { email: "stefan@example.com", displayName: "Stefan", responseStatus: "needsAction" },
    ],
    organizer: { email: "corey@example.com", displayName: "Corey" },
  } as MeetingEvent;

  it("shows the invite's attendees while the notes are still loading", () => {
    const event = withRecordedEvents([calendarEvent], row("gtm-cal")).find((e) => e.recorded)!;
    expect(event.attendees?.map((a) => a.displayName)).toEqual(["Corey", "Jacob", "Stefan"]);
    const el = render({ mode: "recap", event, notesLoading: true, now });
    expect(el.querySelector('[data-testid="meeting-attendees-loading"]')).toBeNull();
    expect(names(el).join("|")).toContain("Stefan");
  });

  it("matches the calendar event only with the same title starting within ten minutes", () => {
    const late = withRecordedEvents([calendarEvent], row("gtm-late", "HQ GTM Sync", "2026-10-07T12:45:00-06:00")).find((e) => e.recorded)!;
    expect(late.attendees).toBeUndefined();
    const other = withRecordedEvents([calendarEvent], row("gtm-other", "Board prep")).find((e) => e.recorded)!;
    expect(other.attendees).toBeUndefined();
    const spaced = withRecordedEvents([calendarEvent], row("gtm-case", "  hq gtm   sync ")).find((e) => e.recorded)!;
    expect(spaced.attendees).toHaveLength(3);
  });

  it("keeps the calendar attendees over the transcript speakers once the document loads", () => {
    const event = withRecordedEvents([calendarEvent], row("gtm-both")).find((e) => e.recorded)!;
    const merged = withRecordedNotes(event, {
      document: { transcript: [{ id: "t", speaker: "Corey", at: "", text: "hi" }], notes: [], participants: ["Corey"] },
    });
    expect(merged.attendees?.map((a) => a.displayName)).toEqual(["Corey", "Jacob", "Stefan"]);
  });

  it("without a matching event, attendees still wait for the notes", () => {
    const event = withRecordedEvents([], row("gtm-none")).find((e) => e.recorded)!;
    const el = render({ mode: "recap", event, notesLoading: true, now });
    expect(el.querySelector('[data-testid="meeting-attendees-loading"]')).not.toBeNull();
  });
});

describe("reading the synced meeting file", () => {
  function shell(active: AdapterResult<string | null>) {
    const calls: string[] = [];
    return {
      calls,
      appShell: {
        getActiveCompany: vi.fn(async () => active),
        setActiveCompany: vi.fn(async (slug: string) => {
          calls.push(`bind:${slug}`);
          return ok(undefined);
        }),
      },
    };
  }
  const note = (text: string, truncated = false) => ok({ text, size: text.length, truncated });

  it("names the file by meeting id under the company or personal folder", () => {
    expect(localMeetingDocumentPath("bot_123", "indigo")).toBe("companies/indigo/sources/meetings/bot_123.md");
    expect(localMeetingDocumentPath("bot_123", null)).toBe("personal/sources/meetings/bot_123.md");
    expect(localMeetingDocumentPath("../secrets", "indigo")).toBeNull();
    expect(localMeetingDocumentPath("a/b", null)).toBeNull();
    expect(localMeetingDocumentPath("bot_1", "../other")).toBeNull();
  });

  it("binds the meeting's company for the read and puts the previous company back", async () => {
    const s = shell(ok("acme"));
    const readNote = vi.fn(async (path: string) => {
      s.calls.push(`read:${path}`);
      return note(documentBody);
    });
    const read = createLocalMeetingDocumentReader({
      vault: { readNote } as never,
      appShell: s.appShell as never,
      companySlugForUid: (uid) => (uid === "cmp_INDIGO" ? "indigo" : null),
    });
    await expect(read("bot_1", "cmp_INDIGO")).resolves.toEqual({ text: documentBody, truncated: false });
    expect(s.calls).toEqual(["bind:indigo", "read:companies/indigo/sources/meetings/bot_1.md", "bind:acme"]);
  });

  it("clears the binding again when no company was bound before", async () => {
    const s = shell(ok(null));
    const read = createLocalMeetingDocumentReader({
      vault: { readNote: async () => note(documentBody) } as never,
      appShell: s.appShell as never,
      companySlugForUid: () => "indigo",
    });
    await read("bot_1", "cmp_INDIGO");
    expect(s.calls).toEqual(["bind:indigo", "bind:"]);
  });

  it("does not rebind when the company is already bound, and reads personal meetings without binding", async () => {
    const s = shell(ok("indigo"));
    const readNote = vi.fn(async () => note(documentBody, true));
    const read = createLocalMeetingDocumentReader({
      vault: { readNote } as never,
      appShell: s.appShell as never,
      companySlugForUid: () => "indigo",
    });
    await expect(read("bot_1", "cmp_INDIGO")).resolves.toEqual({ text: documentBody, truncated: true });
    await read("bot_2", null);
    expect(s.calls).toEqual([]);
    expect(readNote).toHaveBeenLastCalledWith("personal/sources/meetings/bot_2.md");
  });

  it("skips the local read when the company is not synced here or the binding cannot be restored", async () => {
    const readNote = vi.fn(async () => note(documentBody));
    const notSynced = createLocalMeetingDocumentReader({
      vault: { readNote } as never,
      appShell: shell(ok(null)).appShell as never,
      companySlugForUid: () => null,
    });
    await expect(notSynced("bot_1", "cmp_OTHER")).resolves.toBeNull();
    const unknownBinding = createLocalMeetingDocumentReader({
      vault: { readNote } as never,
      appShell: shell(failure("ipc", "no scope")).appShell as never,
      companySlugForUid: () => "indigo",
    });
    await expect(unknownBinding("bot_1", "cmp_INDIGO")).resolves.toBeNull();
    expect(readNote).not.toHaveBeenCalled();
  });

  it("a missing file is null, not an error", async () => {
    const read = createLocalMeetingDocumentReader({
      vault: { readNote: async () => failure("io", "No such file") } as never,
      appShell: shell(ok(null)).appShell as never,
      companySlugForUid: () => null,
    });
    await expect(read("bot_1", null)).resolves.toBeNull();
  });
});
