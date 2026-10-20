// @vitest-environment happy-dom

/**
 * First view, "Connect your apps": suggested integrations and the AI apps
 * not yet connected. Each row shows its full status words. A harness found
 * on this Mac shows Open when the host can open it, Connected otherwise, and
 * never a Connect button. Connect hands the row to the host, which opens the
 * existing settings page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import FirstViewConnect from "./FirstViewConnect.svelte";
import type { FirstViewConnect as Model } from "./brief-first-view.js";
import type { WelcomeAction } from "./brief-welcome-contract.js";

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const AI_ACTION: WelcomeAction = {
  id: "ai",
  kind: "connect_ai_apps",
  label: "Connect your AI apps",
  reason: "",
  launch_prompt: "",
  primary: false,
};

function model(over: Partial<Model> = {}): Model {
  return {
    mode: "settings",
    integrations: [{ slug: "linear", name: "Linear", action: null }],
    aiAction: AI_ACTION,
    aiApps: [
      { harness: "claude-code", name: "Claude Code", sessions: 42 },
      { harness: "cursor", name: "Cursor", sessions: 0 },
    ],
    harnessCounts: { claude_code: 42, codex: 0, cursor: 0 },
    ...over,
  };
}

async function render(props: Record<string, unknown>): Promise<void> {
  target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(FirstViewConnect, { target, props: props as never });
  await tick();
}
const row = (sel: string): HTMLElement => target.querySelector<HTMLElement>(`[data-testid="first-view-connect-row"]${sel}`)!;
const buttons = (el: HTMLElement): string[] => [...el.querySelectorAll("button")].map((b) => b.textContent!.trim());

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
});

describe("FirstViewConnect", () => {
  it("shows the full status words on every row", async () => {
    await render({ connect: model(), onconnectai: () => {}, onconnectintegration: () => {} });
    expect(row('[data-harness="claude-code"]').querySelector(".fv-note")!.textContent).toBe("Found on this Mac");
    expect(row('[data-harness="cursor"]').querySelector(".fv-note")!.textContent).toBe("Not connected yet");
    expect(row('[data-integration="linear"]').querySelector(".fv-note")!.textContent).toBe("Not connected yet");
  });

  it("a found harness shows Connected, never Connect, when the host cannot open it", async () => {
    await render({ connect: model(), onconnectai: () => {}, onopen: () => {}, canOpen: () => false });
    const found = row('[data-harness="claude-code"]');
    expect(found.dataset.found).toBe("true");
    expect(buttons(found)).toEqual([]);
    expect(found.querySelector('[data-testid="first-view-connected"]')!.textContent).toBe("Connected");
  });

  it("a found harness shows Open when the host can open it, and Open opens that harness", async () => {
    const onopen = vi.fn();
    const onconnectai = vi.fn();
    await render({ connect: model(), onconnectai, onopen, canOpen: (h: string) => h === "claude-code" });
    const found = row('[data-harness="claude-code"]');
    expect(buttons(found)).toEqual(["Open"]);
    found.querySelector("button")!.click();
    expect(onopen).toHaveBeenCalledWith("claude-code");
    expect(onconnectai).not.toHaveBeenCalled();
  });

  it("Open is disabled and marked busy while that harness is opening, and only that row", async () => {
    const onopen = vi.fn();
    const m = model({ aiApps: [{ harness: "claude-code", name: "Claude Code", sessions: 42 }, { harness: "codex", name: "Codex", sessions: 3 }], harnessCounts: { claude_code: 42, codex: 3, cursor: 0 } });
    await render({ connect: m, onconnectai: () => {}, onopen, canOpen: () => true, busy: { "claude-code": true } });
    const busyBtn = row('[data-harness="claude-code"]').querySelector("button")!;
    expect(busyBtn.disabled).toBe(true);
    expect(busyBtn.getAttribute("aria-busy")).toBe("true");
    busyBtn.click();
    expect(onopen).not.toHaveBeenCalled();
    const other = row('[data-harness="codex"]').querySelector("button")!;
    expect(other.disabled).toBe(false);
    other.click();
    expect(onopen).toHaveBeenCalledWith("codex");
  });

  it("Connect on a missing AI app calls onconnectai with that app", async () => {
    const onconnectai = vi.fn();
    await render({ connect: model(), onconnectai });
    const missing = row('[data-harness="cursor"]');
    expect(buttons(missing)).toEqual(["Connect"]);
    missing.querySelector("button")!.click();
    expect(onconnectai).toHaveBeenCalledWith({ harness: "cursor", name: "Cursor", sessions: 0 });
  });

  it("Connect on an integration calls onconnectintegration with that row", async () => {
    const onconnectintegration = vi.fn();
    await render({ connect: model(), onconnectintegration });
    const linear = row('[data-integration="linear"]');
    linear.querySelector("button")!.click();
    expect(onconnectintegration).toHaveBeenCalledWith({ slug: "linear", name: "Linear", action: null });
  });

  it("no Connect button anywhere offers a found harness", async () => {
    await render({ connect: model(), onconnectai: () => {}, onconnectintegration: () => {} });
    const connectRows = [...target.querySelectorAll<HTMLElement>('[data-testid="first-view-connect-row"]')].filter((r) => buttons(r).includes("Connect"));
    expect(connectRows.map((r) => r.dataset.harness ?? r.dataset.integration)).toEqual(["cursor", "linear"]);
  });

  it("without Core's connect_ai_apps action the AI apps stay out", async () => {
    await render({ connect: model({ aiAction: null }), onconnectai: () => {} });
    expect(target.querySelector("[data-harness]")).toBeNull();
    expect(target.querySelectorAll('[data-testid="first-view-connect-row"]')).toHaveLength(1);
  });

  it("with nothing left to connect it says so in one line", async () => {
    await render({ connect: model({ aiAction: null, integrations: [] }) });
    expect(target.querySelector('[data-testid="first-view-connect-empty"]')!.textContent).toBe("Every app HQ found is connected.");
    expect(target.querySelector("button")).toBeNull();
  });

  it("carries the connect mode for the host", async () => {
    await render({ connect: model() });
    expect(target.querySelector<HTMLElement>('[data-testid="first-view-connect"]')!.dataset.mode).toBe("settings");
  });
});
