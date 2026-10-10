// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import FirstRunTakeover from "./FirstRunTakeover.svelte";
import type { FirstRunCreation } from "./visual-first-run.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

const SIGNED_IN = { claude: true, codex: false, grok: false };
const NONE = { claude: false, codex: false, grok: false };

interface RenderProps {
  creation?: FirstRunCreation;
  runtimeReady?: Record<string, boolean> | null;
  initialStep?: "name" | "tools" | "done";
  ontalk?: () => void | Promise<void>;
}

function render(props: RenderProps = {}) {
  const handlers = {
    onconfirmname: vi.fn(),
    onretry: vi.fn(),
    ontalk: vi.fn(props.ontalk ?? (() => {})),
    oncontinueinchat: vi.fn(),
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(FirstRunTakeover, {
    target: host,
    props: {
      initialName: "Pickles",
      initialStep: props.initialStep ?? "name",
      creation: props.creation ?? { state: "idle" },
      runtimeReady: props.runtimeReady === undefined ? SIGNED_IN : props.runtimeReady,
      ...handlers,
    },
  });
  return { handlers };
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("FirstRunTakeover: name your HQ assistant", () => {
  it("opens on the name step in the takeover with the slice's three bars and a prefilled name", async () => {
    render();
    await settle();
    expect(q('[data-testid="first-run-takeover"]')).toBeTruthy();
    expect(q("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Name your HQ assistant.");
    const bars = document.querySelectorAll('[data-testid="new-bot-progress"] span');
    expect(bars).toHaveLength(3);
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 1 of 3");
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("Pickles");
    expect(q('[data-testid="new-bot-continue-name"]')?.textContent).toContain("Next: Your coding tools");
    expect(q('[data-testid="new-bot-finish-name"]')?.textContent).toContain("Finish with defaults");
    // The setup bot's handle is fixed, so no "@handle" line.
    expect(q('[data-testid="new-bot-name-handle"]')).toBeNull();
    expect(q('[data-testid="first-run-continue-in-chat"]')?.textContent).toContain("Continue in chat");
  });

  it("Enter confirms the name once and moves on to the coding tools", async () => {
    const { handlers } = render();
    await settle();
    const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    input.value = "Biscuit";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(handlers.onconfirmname).toHaveBeenCalledTimes(1);
    expect(handlers.onconfirmname).toHaveBeenCalledWith("Biscuit", "claude");
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("tools");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 2 of 3");
    // The local flow's three coding tool cards.
    expect(q('[data-testid="chat-bot-runtime-claude"]')).toBeTruthy();
    expect(q('[data-testid="chat-bot-runtime-codex"]')).toBeTruthy();
    expect(q('[data-testid="chat-bot-runtime-grok"]')).toBeTruthy();
  });

  it("a name the host would refuse says why and confirms nothing", async () => {
    const { handlers } = render();
    await settle();
    const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    input.value = "123abc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    q<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')!.click();
    await settle();
    expect(handlers.onconfirmname).not.toHaveBeenCalled();
    expect(q('[data-testid="new-bot-name-issue"]')?.textContent).toContain(
      "Use letters, numbers, spaces, apostrophes, periods and hyphens.",
    );
  });

  it("a name with numbers, like StefanTest123, is accepted and moves on", async () => {
    const { handlers } = render();
    await settle();
    const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    input.value = "StefanTest123";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    q<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')!.click();
    await settle();
    expect(q('[data-testid="new-bot-name-issue"]')).toBeNull();
    expect(handlers.onconfirmname).toHaveBeenCalledWith("StefanTest123", "claude");
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("tools");
  });

  it("Finish with defaults skips to Done when a tool is ready", async () => {
    const { handlers } = render();
    await settle();
    q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
    await settle();
    expect(handlers.onconfirmname).toHaveBeenCalledWith("Pickles", "claude");
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("done");
  });

  it("Finish with defaults stops on the coding tools while none is signed in", async () => {
    render({ runtimeReady: NONE });
    await settle();
    q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
    await settle();
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("tools");
  });

  it("the name cannot change once the assistant is being created", async () => {
    render({ creation: { state: "creating", name: "Biscuit" } });
    await settle();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("Biscuit");
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.disabled).toBe(true);
    expect(q('[data-testid="new-bot-name-note"]')).toBeTruthy();
    expect(q<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')?.disabled).toBe(false);
  });

  it("Escape does not leave the first run", async () => {
    const { handlers } = render();
    await settle();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(handlers.oncontinueinchat).not.toHaveBeenCalled();
    expect(q('[data-testid="first-run-takeover"]')).toBeTruthy();
  });
});

describe("FirstRunTakeover: coding tools", () => {
  it("is required while no tool is ready: Next is held and the line says the assistant waits for one", async () => {
    render({ initialStep: "tools", runtimeReady: NONE });
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="first-run-next"]')?.disabled).toBe(true);
    expect(q('[data-testid="first-run-next"]')?.textContent).toContain("Next: Done");
    // Next to Done there is no second button.
    expect(q('[data-testid="first-run-finish"]')).toBeNull();
    expect(q('[data-testid="first-run-create-status"]')?.getAttribute("data-state")).toBe("waiting");
  });

  it("with a tool ready, Next goes to Done", async () => {
    render({ initialStep: "tools" });
    await settle();
    const next = q<HTMLButtonElement>('[data-testid="first-run-next"]')!;
    expect(next.disabled).toBe(false);
    next.click();
    await settle();
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("done");
  });

  it("shows the create in progress quietly", async () => {
    render({ initialStep: "tools", creation: { state: "creating", name: "Pickles" } });
    await settle();
    const status = q('[data-testid="first-run-create-status"]');
    expect(status?.getAttribute("data-state")).toBe("creating");
    expect(status?.textContent).toContain("Getting Pickles ready");
  });
});

describe("FirstRunTakeover: done", () => {
  it("summarises the name and tool, and holds Talk with a pending label while the create runs", async () => {
    render({ initialStep: "done", creation: { state: "creating", name: "Pickles" } });
    await settle();
    expect(q("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Meet Pickles.");
    expect(q('[data-testid="first-run-summary-name"]')?.textContent).toBe("Pickles");
    expect(q('[data-testid="first-run-summary-tool"]')?.textContent).toContain("Claude Code, signed in");
    const talk = q<HTMLButtonElement>('[data-testid="first-run-talk"]')!;
    expect(talk.disabled).toBe(true);
    expect(talk.getAttribute("aria-busy")).toBe("true");
    expect(talk.textContent).toContain("Getting Pickles ready");
  });

  it("Talk to <Name> opens the chat once, with Opening… while it goes", async () => {
    let finish!: () => void;
    const { handlers } = render({
      initialStep: "done",
      creation: { state: "ready", name: "Pickles", bot: { agentUid: "agt_1", name: "setup" } },
      ontalk: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    await settle();
    const talk = q<HTMLButtonElement>('[data-testid="first-run-talk"]')!;
    expect(talk.textContent).toContain("Talk to Pickles");
    talk.click();
    flushSync();
    talk.click();
    expect(handlers.ontalk).toHaveBeenCalledTimes(1);
    expect(talk.textContent).toContain("Opening");
    expect(talk.disabled).toBe(true);
    finish();
    await settle();
  });

  it("a failed create says why, with Retry and a way to continue in chat", async () => {
    const { handlers } = render({
      initialStep: "done",
      creation: { state: "failed", name: "Pickles", reason: "Could not create setup." },
    });
    await settle();
    const status = q('[data-testid="first-run-create-status"]');
    expect(status?.getAttribute("data-state")).toBe("failed");
    expect(status?.textContent).toContain("Could not create setup.");
    q<HTMLButtonElement>('[data-testid="first-run-retry"]')!.click();
    expect(handlers.onretry).toHaveBeenCalledTimes(1);
    q<HTMLButtonElement>('[data-testid="first-run-failed-chat"]')!.click();
    await settle();
    expect(handlers.oncontinueinchat).toHaveBeenCalledTimes(1);
    expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(true);
  });
});

describe("FirstRunTakeover: accessibility", () => {
  it("keeps one live region mounted on every screen and only changes its text", async () => {
    render({ creation: { state: "creating", name: "Pickles" } });
    await settle();
    const live = q('[data-testid="first-run-live"]')!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toContain("Getting Pickles ready");
    // Only the one region is live.
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    q<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')!.click();
    await settle();
    expect(q('[data-testid="first-run-live"]')).toBe(live);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
  });

  it("puts focus in the dialog on open, and on Next when the name is locked", async () => {
    render({ initialStep: "tools", creation: { state: "creating", name: "Pickles" } });
    await settle(8);
    const card = q('[role="dialog"]')!;
    expect(card.contains(document.activeElement)).toBe(true);
    q<HTMLButtonElement>('[data-testid="first-run-back"]')!.click();
    await settle(8);
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("name");
    expect(document.activeElement).toBe(q('[data-testid="new-bot-continue-name"]'));
  });
});
