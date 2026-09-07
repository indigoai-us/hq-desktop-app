import { describe, expect, it } from "vitest";
import { TauriPlatformAdapter } from "./index.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

function makeTauri() {
  const calls: Invocation[] = [];
  const adapter = new TauriPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return { tasks: [] };
    },
  });
  return { adapter, calls };
}

describe("TauriPlatformAdapter agent task views", () => {
  it("maps the room-scoped and agent-wide task views to the desktop commands", async () => {
    const { adapter, calls } = makeTauri();
    await adapter.messaging.listChannelAgentTasks!("agt_1", "chn_9");
    await adapter.messaging.listAgentTasks!("agt_1");
    expect(calls).toEqual([
      { cmd: "list_channel_agent_tasks", args: { agentUid: "agt_1", channelId: "chn_9" } },
      { cmd: "list_agent_tasks", args: { agentUid: "agt_1" } },
    ]);
  });
});
