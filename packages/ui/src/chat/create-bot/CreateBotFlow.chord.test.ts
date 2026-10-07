// @vitest-environment happy-dom
// OWNER-D 8 (AUDIT-2-15): the New bot footer shows the platform's own create
// chord (⌘↵ on macOS, Ctrl+Enter elsewhere) in the 11px mono chord style, and
// only that chord creates. Both entry points (Messages create menu and
// Settings > Bots) render this same flow.
import { readFileSync } from "node:fs";
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import CreateBotFlow from "./CreateBotFlow.svelte";

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
};
const prior = navigator.userAgent;
let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: prior });
});

async function renderOn(platform: keyof typeof UA): Promise<HTMLElement> {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: UA[platform] });
  const host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CreateBotFlow, {
    target: host,
    props: {
      oncreate: async () => undefined,
      botRuntimeReady: { claude: true, codex: false, grok: false },
      initialHome: "local",
    } as never,
  });
  await tick();
  // The hint sits beside Create, on the last step: walk name → coding tool.
  host.querySelector<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')!.click();
  await tick();
  expect(host.querySelector('[data-testid="chat-bot-create"]')).toBeTruthy();
  return host;
}

describe("New bot create chord per platform", () => {
  it("shows ⌘↵ on macOS in the chord style", async () => {
    const host = await renderOn("mac");
    const chord = host.querySelector('[data-testid="create-bot-hint"] kbd.new-bot-chord');
    expect(chord?.textContent).toBe("⌘↵");
    expect(host.querySelector('[data-testid="create-bot-hint"]')?.textContent).not.toContain("Ctrl");
  });

  it("keeps Ctrl+Enter on Windows and Linux", async () => {
    const host = await renderOn("windows");
    expect(host.querySelector('[data-testid="create-bot-hint"] kbd.new-bot-chord')?.textContent).toBe("Ctrl+↵");
  });

  it("both entry points mount this flow", () => {
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
    // Messages create menu: the modal loads this flow through its lazy door.
    expect(read("../CreateModal.svelte")).toContain("createBotFlowDoor");
    expect(read("../../shell/lazy-doors.ts")).toContain('import("../chat/create-bot/CreateBotFlow.svelte")');
    // Settings > Bots mounts it directly.
    expect(read("../../settings/BotsSettingsPane.svelte")).toContain("<CreateBotFlow");
  });
});
