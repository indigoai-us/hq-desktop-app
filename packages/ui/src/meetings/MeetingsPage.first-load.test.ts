// @vitest-environment happy-dom

// US-010: first-load UX — skeleton while the initial snapshot is in flight,
// connect-a-calendar empty state only after a SUCCESSFUL refresh proves there
// are no accounts and no meetings, and never on a failed fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import {
  ok,
  failure,
  unavailable,
  type AdapterResult,
  type PlatformAdapter,
} from "@hq/platform";

import MeetingsPage from "./MeetingsPage.svelte";
import {
  configureMeetingsApi,
  meetingsStore,
  stopMeetingsStore,
} from "./meetings-store.svelte";

const call =
  vi.fn<
    (method: string, payload?: unknown) => Promise<AdapterResult<unknown>>
  >();

const api = {
  listMemberships: () => call("listMemberships") as never,
  listUpcoming: () => call("listUpcoming") as never,
  listScheduledBots: () => call("listScheduledBots") as never,
  inviteBot: () => call("inviteBot") as never,
  cancelBot: () => call("cancelBot") as never,
  joinBotNow: () => call("joinBotNow") as never,
  listAccounts: () => call("listAccounts") as never,
  listCalendars: () => call("listCalendars") as never,
  connectCalendar: () => call("connectCalendar") as never,
  disconnectCalendar: () => call("disconnectCalendar") as never,
  permissionsState: () => Promise.resolve(unavailable("desktop-only")) as never,
  openPermissionsSetup: () => call("openPermissionsSetup") as never,
};

function fakeAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    meetings: api,
    feedback: { submitBugReport: () => call("submitBugReport") as never },
    identity: {
      whoami: () => Promise.resolve(ok({ personUid: "prs_fixture", email: "" })) as never,
      hasFeature: () => Promise.resolve(ok(false)) as never,
    },
    files: {
      listDir: () => Promise.resolve(ok([])) as never,
      vault: { readNote: () => Promise.resolve(ok({ text: "" })) as never },
    },
  } as unknown as PlatformAdapter;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function mountPage() {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(MeetingsPage, {
    target: host,
    props: { adapter: fakeAdapter() },
  });
}

const q = (testid: string) =>
  host.querySelector<HTMLElement>(`[data-testid="${testid}"]`);

beforeEach(() => {
  call.mockReset();
  localStorage.clear();
  stopMeetingsStore();
  meetingsStore.stopCalendarConnectWatch();
  meetingsStore.clearConnectNotice();
  configureMeetingsApi({
    meetings: api,
    feedback: { submitBugReport: () => call("submitBugReport") as never },
  });
});

afterEach(async () => {
  meetingsStore.stopCalendarConnectWatch();
  stopMeetingsStore();
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("MeetingsPage first-load UX (US-010)", () => {
  it("shows a flagged local personal transcript in the routed Past meetings list without calendar rows", async () => {
    const adapter = fakeAdapter();
    adapter.identity.hasFeature = () => Promise.resolve(ok(true)) as never;
    adapter.files.listDir = (relPath: string) => Promise.resolve(ok(
      relPath === "personal/sources/meetings"
        ? [{ path: "personal/sources/meetings/note.md", name: "note.md", isDir: false }]
        : [],
    )) as never;
    adapter.files.vault!.readNote = () => Promise.resolve(ok({ text: `---\nid: "meeting:note"\nsource_id: "note"\nchannel: "meeting"\nperson_uid: "prs_fixture"\nvisibility: "personal"\nstorage: "local"\ntitle: "Personal notes"\ncreated_at: "2026-10-02T11:00:00.000Z"\n---\n` })) as never;
    call.mockImplementation((method: string) => {
      if (method === "listCalendars") return Promise.resolve(ok({ calendars: [], selectedCalendarIds: [] }));
      return Promise.resolve(ok([]));
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MeetingsPage, { target: host, props: { adapter } });
    await vi.waitFor(() => expect(q("meetings-loading")).toBeNull());
    await q("meetings-tab-past")!.click();
    await vi.waitFor(() => expect(host.textContent).toContain("Personal notes"));
    expect(q("meetings-connect-empty")).toBeNull();
  });

  it("shows the skeleton while the first fetch is in flight, then the connect empty state when truly empty", async () => {
    const upcoming = deferred<AdapterResult<unknown>>();
    call.mockImplementation((method: string) => {
      if (method === "listUpcoming") return upcoming.promise;
      if (method === "listCalendars") {
        return Promise.resolve(ok({ calendars: [], selectedCalendarIds: [] }));
      }
      return Promise.resolve(ok([]));
    });

    mountPage();
    await tick();

    // In flight with no cache: skeleton, never a bare "no meetings" list.
    expect(q("meetings-loading")).not.toBeNull();
    expect(q("meetings-connect-empty")).toBeNull();

    upcoming.resolve(ok([]));
    await vi.waitFor(() => {
      expect(q("meetings-loading")).toBeNull();
      expect(q("meetings-connect-empty")).not.toBeNull();
    });
    expect(q("meetings-connect-empty-cta")).not.toBeNull();
  });

  it("keeps the connect empty state hidden when the first fetch fails", async () => {
    call.mockImplementation((method: string) => {
      if (method === "listUpcoming") {
        return Promise.resolve(failure("http-500", "listUpcoming HTTP 500"));
      }
      if (method === "listCalendars") {
        return Promise.resolve(ok({ calendars: [], selectedCalendarIds: [] }));
      }
      return Promise.resolve(ok([]));
    });

    mountPage();
    await tick();

    await vi.waitFor(() => {
      expect(q("meetings-loading")).toBeNull();
    });
    // Failure is not "you have no meetings" — no connect-first takeover.
    expect(q("meetings-connect-empty")).toBeNull();
  });

  it("the connect empty state's CTA starts the calendar connect flow", async () => {
    const consentUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?state=us-010";
    call.mockImplementation((method: string) => {
      if (method === "connectCalendar") {
        return Promise.resolve(ok({ url: consentUrl }));
      }
      if (method === "listCalendars") {
        return Promise.resolve(ok({ calendars: [], selectedCalendarIds: [] }));
      }
      return Promise.resolve(ok([]));
    });
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({} as unknown as Window);

    mountPage();
    await vi.waitFor(() => {
      expect(q("meetings-connect-empty-cta")).not.toBeNull();
    });

    q("meetings-connect-empty-cta")?.click();
    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledWith("connectCalendar");
      expect(openSpy).toHaveBeenCalled();
    });

    openSpy.mockRestore();
  });
});
