import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ConversationView wiring stays a source guard. The view is the whole
 * conversation shell; these pins are the mount point, the controller feed,
 * and disposal, not a render the strip test can reach.
 */
const channelView = readFileSync(
  resolve(process.cwd(), "src/chat/ConversationView.svelte"),
  "utf8",
);

describe("ConversationView wiring", () => {
  it("mounts the strip between the message list and the composer", () => {
    const strip = channelView.indexOf("<AgentTaskStrip");
    const composer = channelView.indexOf('<div class="conv-composer">');
    expect(strip).toBeGreaterThan(-1);
    expect(composer).toBeGreaterThan(strip);
  });

  it("feeds the strip from the controller, never from a command directly", () => {
    expect(channelView).toContain("tasks={taskCtl?.tasks ?? []}");
    expect(channelView).not.toContain("invoke(");
    expect(channelView).toContain("api.listChannelAgentTasks");
    expect(channelView).toContain("api.listAgentTasks");
  });

  it("disposes the task controller with the conversation", () => {
    expect(channelView).toContain("ctl.dispose()");
    expect(channelView).toContain("new TaskFeedController(");
  });
});
