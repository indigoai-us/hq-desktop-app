// @vitest-environment happy-dom
/**
 * OWNER-019: hq-pro now returns some meetings document-shaped
 * (`sourceShape: "markdown"`): no status/notes/transcript/participants fields,
 * just `source.presigned_url` to one markdown document. The canvas read only
 * the older field shape, so these meetings showed "No notes for this meeting"
 * and the Attendees panel stayed a skeleton forever.
 */
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MeetingsStatesBody from "./MeetingsStatesBody.svelte";
import type { MeetingEvent } from "./meetings-model";
import {
  loadRecordedSignals,
  parseRecordedDetail,
  parseRecordedDocument,
  parseRecordedDocumentRef,
  parseRecordedMeetings,
  recordedToEvent,
  withRecordedDocument,
} from "./recorded-meetings";

// `hq meetings get eb52923c --company liverecover --json`, 2026-10-03.
// The meeting URL is stripped and the presigned URL replaced.
const detailWire = {
  meetingId: "eb52923c-b004-4420-9fa6-b730d406a113",
  sourceShape: "markdown",
  source: {
    path: "sources/meetings/eb52923c-b004-4420-9fa6-b730d406a113.md",
    presigned_url: "https://vault.example/sources/meetings/eb52923c.md",
    frontmatter: {
      id: "meeting:eb52923c-b004-4420-9fa6-b730d406a113",
      channel: "meeting",
      source_id: "eb52923c-b004-4420-9fa6-b730d406a113",
      source_ref: {
        channel: "meeting",
        source_id: "eb52923c-b004-4420-9fa6-b730d406a113",
        key: "sources/meetings/eb52923c-b004-4420-9fa6-b730d406a113.md",
      },
      title: "richard@sender.agency / Corey Epstein - 30min Meeting",
      origin: "recall.ai",
      company_id: "cmp_01KQ7P52H2T70HAWX9E65Z2BZV",
      person_uid: "prs_01KQ695MZHZBYFMVMPRTGFW34B",
      account_id: "acct_01KSBV7CR8D9CT6V45Y1AZ0CNS",
      meeting_platform: "zoom",
      calendar_event_id: "4576e304fda24803a741f0e489ffc789",
      scheduled_start_time: "2026-10-02T13:00:00-06:00",
      created_at: "2026-09-29T22:30:50.329Z",
      updated_at: "2026-10-02T19:46:54.149Z",
      ingested_at: "2026-10-02T19:46:54.149Z",
      recall_bot_id: "eb52923c-b004-4420-9fa6-b730d406a113",
      auto_scheduled: true,
      bot_status: "completed",
    },
  },
  signals: {},
};

// Head of the document `hq meetings notes eb52923c` prints.
const documentBody = [
  "---",
  "id: meeting:eb52923c-b004-4420-9fa6-b730d406a113",
  "channel: meeting",
  "title: richard@sender.agency / Corey Epstein - 30min Meeting",
  "bot_status: completed",
  "---",
  "## Transcript",
  "",
  "**Richard** · `[00:01:49–00:01:54]`",
  "",
  "Whoops There we go. Hey, what's up? What's up, dog?",
  "",
  "**Corey Epstein** · `[00:01:50–00:01:55]`",
  "",
  "Hey. How you doing?",
  "",
  "**Richard** · `[00:01:55–00:01:57]`",
  "",
  "I'm good, man.",
  "",
].join("\n");

const listRow = parseRecordedMeetings({
  meetings: [
    {
      meetingId: "eb52923c-b004-4420-9fa6-b730d406a113",
      sourceShape: "markdown",
      title: "richard@sender.agency / Corey Epstein - 30min Meeting",
      startTime: "2026-10-02T19:00:00.000Z",
      companyId: "cmp_01KQ7P52H2T70HAWX9E65Z2BZV",
      hasSignals: false,
    },
  ],
})[0]!;
const now = new Date("2026-10-03T06:00:00.000Z");

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});
function render(props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(MeetingsStatesBody, { target, props: props as never }));
  flushSync();
  return target;
}

/** The store + canvas-host path: detail → signals and document → shown event. */
async function shownEventFor(detail: unknown, readText: (url: string) => Promise<string>): Promise<MeetingEvent> {
  const signals = await loadRecordedSignals(parseRecordedDetail(detail), readText);
  const ref = parseRecordedDocumentRef(detail);
  const doc = ref ? parseRecordedDocument(await readText(ref.url)) : null;
  return withRecordedDocument({ ...recordedToEvent(listRow), signals }, doc);
}

describe("document-shaped recorded meeting", () => {
  it("finds the document behind source.presigned_url", () => {
    expect(parseRecordedDocumentRef(detailWire)).toEqual({ url: detailWire.source.presigned_url });
    expect(parseRecordedDocumentRef({ meetingId: "x", signals: {} })).toBeNull();
  });

  it("splits the document into transcript turns and speakers", () => {
    const doc = parseRecordedDocument(documentBody);
    expect(doc.transcript.map((t) => [t.speaker, t.at, t.text])).toEqual([
      ["Richard", "00:01:49", "Whoops There we go. Hey, what's up? What's up, dog?"],
      ["Corey Epstein", "00:01:50", "Hey. How you doing?"],
      ["Richard", "00:01:55", "I'm good, man."],
    ]);
    expect(doc.participants).toEqual(["Richard", "Corey Epstein"]);
  });

  it("renders the tabs and transcript instead of \"No notes\"", async () => {
    const event = await shownEventFor(detailWire, async () => documentBody);
    const el = render({ mode: "recap", event, now });
    expect(el.querySelector('[data-testid="meeting-no-notes"]')).toBeNull();
    expect(el.textContent).not.toContain("No notes for this meeting");
    expect(el.querySelector('[data-testid="meeting-tabs"]')).not.toBeNull();
    const transcriptTab = Array.from(el.querySelectorAll("button.tab")).find((b) => b.textContent === "Transcript") as HTMLButtonElement;
    transcriptTab.click();
    flushSync();
    expect(el.textContent).toContain("Hey. How you doing?");
  });

  it("fills Attendees from the document's speakers", async () => {
    const event = await shownEventFor(detailWire, async () => documentBody);
    const el = render({ mode: "recap", event, now });
    expect(el.querySelector('[data-testid="meeting-attendees-loading"]')).toBeNull();
    const names = Array.from(el.querySelectorAll('[data-testid="meeting-attendee"]')).map((n) => n.textContent);
    expect(names.join("|")).toContain("Richard");
    expect(names.join("|")).toContain("Corey Epstein");
  });
});

describe("attendee skeleton never outlives the load", () => {
  const recorded = recordedToEvent(listRow);

  it("shows the skeleton only while the meeting's notes load", () => {
    const el = render({ mode: "recap", event: recorded, now, notesLoading: true });
    expect(el.querySelector('[data-testid="meeting-attendees-loading"]')).not.toBeNull();
  });

  it("resolves to \"Attendees unavailable\" when nothing names them", () => {
    const el = render({ mode: "recap", event: recorded, now, notesLoading: false });
    expect(el.querySelector('[data-testid="meeting-attendees-loading"]')).toBeNull();
    expect(el.querySelector('[data-testid="meeting-attendees-unavailable"]')?.textContent).toBe("Attendees unavailable");
  });
});
