// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok } from "@hq/platform";
import BrainPage from "./BrainPage.svelte";

const openAgentWorkflow = vi.hoisted(() => vi.fn(async () => ({
  outcome: "opened" as const,
  ok: true,
  message: "Opened the standup-brief in Claude Code.",
})));

vi.mock("../agent-workflow.js", () => ({
  openAgentWorkflow,
}));

describe("US-028 BrainPage", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    openAgentWorkflow.mockClear();
  });

  it("opens Claude Code with the skill prefilled when Run is clicked", async () => {
    const library = {
      getCompany: vi.fn(async () => ok({
        workers: [],
        skills: [{
          name: "standup-brief",
          description: "Daily brief",
          scope: "company",
          company: "indigo",
          path: "companies/indigo/skills/standup-brief/SKILL.md",
          allowedTools: [],
        }],
      })),
    };
    const shell = {
      openClaudeCodeLink: vi.fn(async () => ok(undefined)),
      openInEditor: vi.fn(async () => ok(undefined)),
      openFileInClaude: vi.fn(async () => ok(undefined)),
    };
    const settings = { getConfig: vi.fn(async () => ok({ hqFolderPath: "/tmp/hq" })) };
    component = mount(BrainPage, {
      target: document.body,
      props: {
        page: "skills",
        slug: "indigo",
        files: null,
        library: library as never,
        shell: shell as never,
        settings: settings as never,
      },
    });
    await vi.waitFor(() => {
      expect(document.querySelector("[data-testid='skill-run']")).toBeTruthy();
    });
    flushSync();
    (document.querySelector("[data-testid='skill-run']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(openAgentWorkflow).toHaveBeenCalled();
    });
    const calls = openAgentWorkflow.mock.calls as unknown as unknown[][];
    expect(calls[0]?.[1]).toBe("/standup-brief");
  });

  it("paints a shimmer before the listing arrives", () => {
    const library = { getCompany: vi.fn(() => new Promise(() => undefined)) };
    component = mount(BrainPage, {
      target: document.body,
      props: {
        page: "skills",
        slug: "fresh-co",
        files: null,
        library: library as never,
        shell: null,
        settings: null,
      },
    });
    expect(document.querySelector("[data-testid='brain-shimmer']")).toBeTruthy();
  });
});
