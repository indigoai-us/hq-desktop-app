// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

// (vitest resolve.conditions=['browser'] already picks Svelte's client build.)

import { mount, unmount } from "svelte";
import MeetingsAgenda from "./MeetingsAgenda.svelte";
import type { MeetingEvent, ScheduledBot } from "./meetings-model";
import type { MeetingBotAction } from "./meetings-store.svelte";

const event = {
  id: "event-1",
  summary: "Design review",
  start: { dateTime: "2026-07-29T16:00:00Z" },
  end: { dateTime: "2026-07-29T16:30:00Z" },
  hangoutLink: "https://meet.google.com/abc-defg-hij",
} as MeetingEvent;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountAgenda(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(MeetingsAgenda, {
    target: host,
    props: {
      groups: [{ label: "Today", events: [event] }],
      upNext: null,
      totalCount: 1,
      ...props,
    },
  });
}

function bot(status: string, extra: Partial<ScheduledBot> = {}): ScheduledBot {
  return {
    botId: `bot-${status}`,
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    platform: "google_meet",
    status,
    calendarEventId: event.id,
    autoScheduled: false,
    ...extra,
  };
}

describe("MeetingsAgenda pending controls", () => {
  it("marks only Join now busy while disabling the sibling Invite action", () => {
    mountAgenda({
      pendingActionsByEventId: new Map<string, MeetingBotAction>([
        ["event-1", "join-now"],
      ]),
    });

    const invite = host.querySelector<HTMLButtonElement>(".row-icon-invite");
    const joinNow = host.querySelector<HTMLButtonElement>(".row-icon-bot-now");
    expect(invite?.disabled).toBe(true);
    expect(invite?.getAttribute("aria-busy")).toBe("false");
    expect(invite?.querySelector(".row-icon-spinner")).toBeNull();
    expect(joinNow?.disabled).toBe(true);
    expect(joinNow?.getAttribute("aria-busy")).toBe("true");
    expect(joinNow?.querySelector(".row-icon-spinner")).not.toBeNull();
  });

  it("keeps a rejected meeting handoff visible and retryable", async () => {
    const openExternal = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("browser unavailable"))
      .mockResolvedValueOnce();
    mountAgenda({ onOpenExternal: openExternal });

    host.querySelector<HTMLButtonElement>(".row-icon-join")?.click();
    await vi.waitFor(() => {
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        "Couldn’t open this meeting.",
      );
    });

    host
      .querySelector<HTMLButtonElement>(".meeting-open-error button")
      ?.click();
    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });
  });
});

describe("MeetingsAgenda bot lifecycle rendering (US-005)", () => {
  const lifecycle: Array<{
    status: string;
    attachment: string;
    extra?: Partial<ScheduledBot>;
    expectSelector: string;
  }> = [
    {
      status: "scheduled",
      attachment: "invited",
      expectSelector: ".row-icon-invited",
    },
    {
      status: "joining",
      attachment: "joining",
      expectSelector: ".row-icon-joining",
    },
    {
      status: "recording",
      attachment: "recording",
      expectSelector: ".row-icon-incall",
    },
    {
      status: "processing",
      attachment: "processing",
      expectSelector: ".row-icon-processing",
    },
    {
      status: "completed",
      attachment: "completed",
      extra: { sourceLanded: true },
      expectSelector: ".row-icon-done",
    },
  ];

  it("renders available-to-invite when no bot is attached", () => {
    mountAgenda({});
    const row = host.querySelector('[data-testid="meeting-row"]');
    expect(row?.getAttribute("data-bot-state")).toBe("available-to-invite");
    expect(host.querySelector(".row-icon-invite")).not.toBeNull();
    expect(host.querySelector(".row-icon-bot-now")).not.toBeNull();
  });

  it.each(lifecycle)(
    "maps scheduled-bot status $status → data-bot-state=$attachment",
    ({ status, attachment, extra, expectSelector }) => {
      const scheduled = bot(status, extra);
      mountAgenda({
        botsByEventId: new Map([[event.id, scheduled]]),
        scheduledBots: [scheduled],
      });

      const row = host.querySelector('[data-testid="meeting-row"]');
      expect(row?.getAttribute("data-bot-state")).toBe(attachment);
      expect(host.querySelector(expectSelector)).not.toBeNull();
    },
  );

  it("keeps completed-without-source as processing (not false done)", () => {
    const scheduled = bot("completed", { sourceLanded: false });
    mountAgenda({
      botsByEventId: new Map([[event.id, scheduled]]),
      scheduledBots: [scheduled],
    });

    const row = host.querySelector('[data-testid="meeting-row"]');
    expect(row?.getAttribute("data-bot-state")).toBe("processing");
    expect(host.querySelector(".row-icon-processing")).not.toBeNull();
    expect(host.querySelector(".row-icon-done")).toBeNull();
  });
});
