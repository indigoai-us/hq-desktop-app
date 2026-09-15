import { describe, it, expect } from "vitest";
import {
  TaskFeedController,
  AGENT_TASK_MAX_CONSECUTIVE_FAILURES,
} from "./task-feed-controller.svelte";

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

/**
 * A permanently-404ing agent used to be re-asked every tick forever — one
 * authenticated round-trip per 15s for as long as its conversation stayed
 * open, with the failures burying real ones in the log. The agent-wide view is
 * the last resort, so a failure there has nowhere left to fall back to.
 */
describe("TaskFeedController retires an agent whose agent-wide view keeps failing", () => {
  it("stops calling after the failure cap, and not before it", async () => {
    let calls = 0;
    const ctl = new TaskFeedController({
      agentUids: ["agt_local"],
      pollMs: 1_000_000,
      fetchTasks: async () => {
        calls += 1;
        throw new Error("not available for this agent");
      },
    });
    // The constructor already issued one poll.
    for (let i = 0; i < 10; i += 1) await ctl.tick();

    expect(calls).toBe(AGENT_TASK_MAX_CONSECUTIVE_FAILURES);
    ctl.dispose();
  });

  it("keeps the last errored feed after retiring, so the error is still readable", async () => {
    const ctl = new TaskFeedController({
      agentUids: ["agt_local"],
      pollMs: 1_000_000,
      fetchTasks: async () => {
        throw new Error("not available for this agent");
      },
    });
    for (let i = 0; i < 6; i += 1) await ctl.tick();

    expect(ctl.feeds.get("agt_local")?.error).toContain("not available for this agent");
    expect(ctl.tasks).toEqual([]);
    ctl.dispose();
  });

  it("a recovery resets the count, so a transient blip never retires an agent", async () => {
    let calls = 0;
    const ctl = new TaskFeedController({
      agentUids: ["agt_flaky"],
      pollMs: 1_000_000,
      // Fail, fail, succeed, repeating — never MAX failures in a row.
      fetchTasks: async () => {
        calls += 1;
        if (calls % 3 !== 0) throw new Error("network");
        return { running: { tasks: [] } };
      },
    });
    for (let i = 0; i < 9; i += 1) await ctl.tick();

    expect(calls).toBe(10);
    ctl.dispose();
  });

  it("a healthy agent on the same roster keeps polling after the other retires", async () => {
    let healthy = 0;
    const ctl = new TaskFeedController({
      agentUids: ["agt_local", "agt_fleet"],
      pollMs: 1_000_000,
      fetchTasks: async (uid) => {
        if (uid === "agt_local") throw new Error("not available for this agent");
        healthy += 1;
        return { running: { tasks: [] } };
      },
    });
    for (let i = 0; i < 6; i += 1) await ctl.tick();

    expect(healthy).toBe(7);
    ctl.dispose();
  });
});
