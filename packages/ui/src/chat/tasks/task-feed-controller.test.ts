import { describe, it, expect } from "vitest";
import { TaskFeedController } from "./task-feed-controller.svelte";

/**
 * The strip renders `{#each tasks as task (task.id)}` (AgentTaskStrip.svelte),
 * so `TaskFeedController.tasks` is a KEYED list source: two entries sharing an
 * id crash the whole shell with Svelte's `each_key_duplicate`.
 *
 * The per-agent feeds each dedupe internally (agent-task-feed.ts,
 * room-task-feed.ts), but `tasks` flattens ACROSS agents. In a channel the
 * controller polls every agent on the roster, and the room-scoped route
 * (`/agents/{agentUid}/channels/{channelId}/tasks`) reads the channel's shared
 * interaction trace — so one task legitimately comes back under every agent in
 * the room. That cross-agent overlap is what must not reach the keyed each.
 */

const roomPayload = (
  rows: ReadonlyArray<{ taskId: string; title: string; status: string }>,
) => ({ tasks: rows });

/** Drain the constructor's first poll plus an explicit tick. */
async function settled(ctl: TaskFeedController): Promise<TaskFeedController> {
  await ctl.tick();
  return ctl;
}

describe("TaskFeedController.tasks is safe to use as a keyed each source", () => {
  it("returns a task shared by two agents in the room exactly once", async () => {
    const shared = {
      taskId: "tsk_01JQSHARED0000000000000000",
      title: "Ship the release",
      status: "working",
    };
    const ctl = await settled(
      new TaskFeedController({
        agentUids: ["agt_alpha", "agt_bravo"],
        channelId: "chn_01KWGKH0H5C8D8YC7XWZTQPTX6",
        pollMs: 1_000_000,
        // Both agents on the roster report the same trace-sourced task.
        fetchRoomTasks: async () => roomPayload([shared]),
        fetchTasks: async () => ({ tasks: [] }),
      }),
    );

    const ids = ctl.tasks.map((t) => t.id);
    expect(ids).toEqual([shared.taskId]);
    ctl.dispose();
  });

  it("never yields duplicate keys for a realistic multi-agent room", async () => {
    // Three agents; a shared task in the trace plus one task private to each.
    const perAgent: Record<string, ReadonlyArray<{ taskId: string; title: string; status: string }>> = {
      agt_alpha: [
        { taskId: "tsk_shared_release", title: "Ship the release", status: "working" },
        { taskId: "tsk_alpha_only", title: "Run typecheck", status: "queued" },
      ],
      agt_bravo: [
        { taskId: "tsk_shared_release", title: "Ship the release", status: "working" },
        { taskId: "tsk_bravo_only", title: "Draft changelog", status: "done" },
      ],
      agt_charlie: [
        { taskId: "tsk_shared_release", title: "Ship the release", status: "working" },
        { taskId: "tsk_alpha_only", title: "Run typecheck", status: "queued" },
      ],
    };
    const ctl = await settled(
      new TaskFeedController({
        agentUids: ["agt_alpha", "agt_bravo", "agt_charlie"],
        channelId: "chn_01KWGKH0H5C8D8YC7XWZTQPTX6",
        pollMs: 1_000_000,
        fetchRoomTasks: async (uid) => roomPayload(perAgent[uid] ?? []),
        fetchTasks: async () => ({ tasks: [] }),
      }),
    );

    const ids = ctl.tasks.map((t) => t.id);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(new Set(ids)).toEqual(
      new Set(["tsk_shared_release", "tsk_alpha_only", "tsk_bravo_only"]),
    );
    ctl.dispose();
  });

  it("keeps roster order and lets the first agent's copy win", async () => {
    const ctl = await settled(
      new TaskFeedController({
        agentUids: ["agt_alpha", "agt_bravo"],
        channelId: "chn_room",
        pollMs: 1_000_000,
        fetchRoomTasks: async (uid) =>
          roomPayload([
            uid === "agt_alpha"
              ? { taskId: "tsk_dup", title: "Alpha view", status: "working" }
              : { taskId: "tsk_dup", title: "Bravo view", status: "done" },
          ]),
        fetchTasks: async () => ({ tasks: [] }),
      }),
    );

    expect(ctl.tasks).toHaveLength(1);
    expect(ctl.tasks[0]?.title).toBe("Alpha view");
    ctl.dispose();
  });

  it("still merges distinct tasks from every agent", async () => {
    const ctl = await settled(
      new TaskFeedController({
        agentUids: ["agt_alpha", "agt_bravo"],
        channelId: "chn_room",
        pollMs: 1_000_000,
        fetchRoomTasks: async (uid) =>
          roomPayload([
            { taskId: `tsk_${uid}`, title: `Task for ${uid}`, status: "working" },
          ]),
        fetchTasks: async () => ({ tasks: [] }),
      }),
    );

    expect(ctl.tasks.map((t) => t.id)).toEqual(["tsk_agt_alpha", "tsk_agt_bravo"]);
    ctl.dispose();
  });
});
