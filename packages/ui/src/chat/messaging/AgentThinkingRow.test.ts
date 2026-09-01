// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import AgentThinkingRow from "./AgentThinkingRow.svelte";
import type { ThinkingEntry } from "../agent-thinking.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("AgentThinkingRow", () => {
  it("renders the thinking label for each entry", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const entries: ThinkingEntry[] = [
      {
        agentUid: "agt_izzy",
        agentName: "Izzy",
        startedAt: 0,
        phase: "thinking",
      },
    ];
    component = mount(AgentThinkingRow, {
      target: host,
      props: { entries },
    });
    await tick();
    const row = host.querySelector('[data-testid="agent-thinking-row"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Izzy is thinking");
  });

  it("renders nothing when entries is empty", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AgentThinkingRow, {
      target: host,
      props: { entries: [] },
    });
    await tick();
    expect(host.querySelector('[data-testid="agent-thinking-row"]')).toBeNull();
  });
});
