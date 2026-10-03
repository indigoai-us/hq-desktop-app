// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";

import {
  AGENT_TASK_STATUS_LABEL,
  agentTaskTone,
  type AgentTask,
} from "./agent-tasks";
import TaskChip from "./TaskChip.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const task: AgentTask = {
  id: "task-1",
  title: "Ship the chip",
  status: "queued",
  lastEventAt: "2026-10-03T00:00:00.000Z",
  originMessageId: "msg-1",
};

function render(props: { task?: AgentTask; onselect?: (task: AgentTask) => void } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(TaskChip, {
    target: host,
    props: { task: props.task ?? task, onselect: props.onselect },
  });
}

function chip(): HTMLElement {
  const node = host.querySelector<HTMLElement>("[data-testid='task-chip']");
  if (!node) throw new Error("task chip missing");
  return node;
}

function scopedCss(): string {
  const scope = [...chip().classList].find((name) => name.startsWith("svelte-"));
  return [...document.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .filter((css) => (scope ? css.includes(scope) : false))
    .join("\n");
}

describe("TaskChip", () => {
  it("is a button that emits the task when it can be selected", () => {
    let selected: AgentTask | null = null;
    render({ onselect: (value) => { selected = value; } });
    expect(chip().tagName).toBe("BUTTON");
    expect(chip().getAttribute("type")).toBe("button");
    chip().click();
    expect(selected).toEqual(task);
  });

  it("is a non-interactive span when no selection callback is passed", () => {
    render();
    expect(chip().tagName).toBe("SPAN");
    expect(chip().getAttribute("type")).toBeNull();
  });

  it("names the task and its shared status label for assistive tech", () => {
    render({ task: { ...task, status: "failed" } });
    expect(chip().getAttribute("aria-label")).toBe(
      `Ship the chip, ${AGENT_TASK_STATUS_LABEL.failed}`,
    );
    expect(host.querySelector("[data-testid='task-chip-dot']")?.getAttribute("data-tone")).toBe(
      agentTaskTone("failed"),
    );
  });

  it("exposes the hover card as a tooltip described by the chip", () => {
    render();
    const card = host.querySelector<HTMLElement>("[data-testid='task-chip-card']");
    expect(card?.getAttribute("role")).toBe("tooltip");
    expect(card?.id).toBe("task-chip-card-task-1");
    expect(chip().getAttribute("aria-describedby")).toBe(card?.id);
    expect(card?.textContent).toContain(AGENT_TASK_STATUS_LABEL.queued);
    expect(card?.textContent).toContain("From a message in this thread");
  });

  it("keeps a visible focus ring and the status tones in the rendered stylesheet", () => {
    render();
    const css = scopedCss();
    expect(css).toContain(":focus-visible");
    expect(css).toContain("var(--v4-focus-ring)");
    for (const token of ["--v4-ok", "--v4-warn", "--v4-error", "--v4-unread", "--v4-idle"]) {
      expect(css).toContain(token);
    }
    expect(css).toContain(":hover");
    expect(css).toContain(":focus-within");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
