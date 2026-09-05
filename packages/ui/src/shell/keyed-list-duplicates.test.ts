import { describe, it, expect } from "vitest";
import {
  groupByDay,
  normalizeConversations,
  takeDirectorySeed,
} from "../chat/sidebar-model";
import type { Channel } from "../chat/channels";
import { mergePaletteRows } from "./palette-rows";
import {
  activityTimelineMessages,
  mergeActivityIntoTimeline,
  projectActivityEntries,
} from "../chat/messaging/projectActivity";
import { TaskFeedController } from "../chat/tasks/task-feed-controller.svelte";

/**
 * Cross-cutting guard for the shell's KEYED lists.
 *
 * Every `{#each … (key)}` in the shell is a crash site: Svelte 5 throws
 * `each_key_duplicate` — and in a production build the message is only the
 * docs URL, so the whole window drops to "Something went wrong" with no clue
 * which list did it. The defence has to live in the derivations that BUILD
 * those lists, not in the markup, so this file runs one adversarial fixture
 * through each of them and asserts the keys come out unique.
 *
 * Every source below merges or flattens more than one upstream, which is the
 * only way a duplicate key is ever produced. Add a case here whenever a new
 * keyed list gains a second source.
 */

/** The invariant every keyed list must satisfy. */
function expectUniqueKeys(keys: readonly string[], label: string): void {
  const dupes = keys.filter((key, i) => keys.indexOf(key) !== i);
  expect(dupes, `${label} produced duplicate keys: ${dupes.join(", ")}`).toEqual(
    [],
  );
}

const CHANNEL = "chn_01KWGKH0H5C8D8YC7XWZTQPTX6";

function channel(overrides: Partial<Channel> & { channelId: string }): Channel {
  return {
    scope: "company",
    companyUid: "cmp_indigo",
    companyName: "Indigo",
    name: "hq-dev",
    unread: 2,
    ...overrides,
  } as Channel;
}

describe("keyed list sources never emit duplicate keys", () => {
  it("sidebar rows: the same channel listed twice by the directory", () => {
    // A cached row and a live row for one channel arriving in the same list.
    const channels = [
      channel({ channelId: CHANNEL, lastActivityAt: "2026-09-04T12:00:00.000Z" }),
      channel({ channelId: CHANNEL, lastActivityAt: "2026-09-04T12:00:01.000Z" }),
      channel({ channelId: "chn_other", name: "general", unread: 0 }),
    ];
    const rows = normalizeConversations(channels, [], {});
    expectUniqueKeys(
      rows.map((row) => row.id),
      "normalizeConversations",
    );

    // …and again after day-grouping, which is what the rail actually renders:
    // pinned, each section, and LAST WEEK are separate keyed blocks.
    const grouped = groupByDay(rows, Date.parse("2026-09-04T18:00:00.000Z"));
    expectUniqueKeys(
      grouped.pinned.map((row) => row.id),
      "groupByDay.pinned",
    );
    expectUniqueKeys(
      grouped.sections.map((section) => section.key),
      "groupByDay.sections",
    );
    for (const section of grouped.sections) {
      expectUniqueKeys(
        section.rows.map((row) => row.id),
        `groupByDay.sections[${section.key}].rows`,
      );
    }
    expectUniqueKeys(
      grouped.lastWeek.map((row) => row.id),
      "groupByDay.lastWeek",
    );
  });

  it("directory seed: a repeated unread channel on an over-cap account", () => {
    const rows = [
      { channelId: CHANNEL, unreadCount: 4, lastActivityAt: "2026-09-04T12:00:00.000Z" },
      { channelId: CHANNEL, unreadCount: 4, lastActivityAt: "2026-09-04T12:00:00.000Z" },
      ...Array.from({ length: 60 }, (_, i) => ({
        channelId: `chn_${i}`,
        unreadCount: 0,
        lastActivityAt: `2026-08-${String(10 + (i % 20)).padStart(2, "0")}T00:00:00.000Z`,
      })),
    ];
    expectUniqueKeys(
      takeDirectorySeed(rows, 24).map((row) => row.channelId),
      "takeDirectorySeed",
    );
  });

  it("cmd-K palette: a conversation present in both the rail and the cache", () => {
    const row = {
      id: CHANNEL,
      kind: "channel" as const,
      channelId: CHANNEL,
      title: "hq-dev",
      channelScope: "company",
      companyUid: "cmp_indigo",
    };
    expectUniqueKeys(
      mergePaletteRows([row as never], [row as never]).map((r) => r.id),
      "mergePaletteRows",
    );
  });

  it("project channel timeline: v1 and v2 envelopes for one work-mesh event", () => {
    const at = "2026-09-04T12:00:00.000Z";
    const threads = [
      {
        threadId: "thr_1",
        events: [
          // The same event, once as the v1 WORK_THREAD_EVENT row and once as
          // the v2 Work Mesh Live session event.
          { eventId: "evt_1", kind: "progress", by: "corey", at, summary: "one" },
          { eventId: "evt_1", type: "progress", actor: "corey", at, summary: "one" },
        ],
      },
    ];
    const activity = activityTimelineMessages(projectActivityEntries(threads as never));
    const chat = [
      { eventId: "evt_chat", body: "hello", createdAt: at, direction: "in" as const },
    ];
    expectUniqueKeys(
      mergeActivityIntoTimeline(chat as never, activity).map(
        (m) => m.eventId as string,
      ),
      "mergeActivityIntoTimeline",
    );
  });

  it("agent task strip: one trace task reported by every agent in the room", async () => {
    const shared = { taskId: "tsk_shared", title: "Ship it", status: "working" };
    const ctl = new TaskFeedController({
      agentUids: ["agt_a", "agt_b", "agt_c"],
      channelId: CHANNEL,
      pollMs: 1_000_000,
      fetchRoomTasks: async () => ({ tasks: [shared] }),
      fetchTasks: async () => ({ tasks: [] }),
    });
    await ctl.tick();
    expectUniqueKeys(
      ctl.tasks.map((task) => task.id),
      "TaskFeedController.tasks",
    );
    ctl.dispose();
  });
});
