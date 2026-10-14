// @vitest-environment happy-dom

/**
 * Settings → AI tools carries the setup for connecting outside AI apps
 * (Grok Bot, Claude, ChatGPT, Claude Code, Codex, Grok CLI) to the hosted HQ
 * MCP connector. It lives inside the existing AI tools pane, not a new screen.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import type { PlatformAdapter } from "@hq/platform";
import AgentsSettingsPane from "./AgentsSettingsPane.svelte";
import {
  CONNECTOR_APPS,
  GROK_BOT_CONNECT_PROMPT,
  INDIGO_MCP_URL,
} from "./hq-connector-setup.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const adapter = {
    isAvailable: () => true,
    sessions: { preflight: async () => ({ ok: true, value: {} }) },
  } as unknown as PlatformAdapter;
  component = mount(AgentsSettingsPane, { target: host, props: { adapter } });
  await tick();
  await Promise.resolve();
  flushSync();
}

async function settle() {
  await Promise.resolve();
  await tick();
  flushSync();
}

function q(testid: string) {
  return host.querySelector<HTMLElement>(`[data-testid='${testid}']`);
}

describe("Settings → AI tools: Connect AI apps to HQ", () => {
  it("sits inside the AI tools pane with a row per app, Grok Bot first", async () => {
    await render();
    const pane = q("settings-agents-pane");
    const section = q("settings-hq-connector");
    expect(pane?.contains(section)).toBe(true);
    expect(section?.textContent).toContain("Connect AI apps to HQ");
    expect(section?.textContent).toContain("every company you belong to");
    for (const id of ["url", ...CONNECTOR_APPS.map((app) => app.id)]) {
      expect(q(`settings-hq-connector-${id}`)).not.toBeNull();
    }
    expect(CONNECTOR_APPS[0].id).toBe("grok-bot");
    expect(q("settings-hq-connector-url")?.textContent).toContain(INDIGO_MCP_URL);
  });

  it("every app points at the hosted connector, never a local server", () => {
    for (const app of CONNECTOR_APPS) {
      expect(app.copyText).toContain(INDIGO_MCP_URL);
      expect(app.copyText).not.toContain("localhost");
      expect(app.copyText).not.toContain("hq mcp serve");
    }
    expect(GROK_BOT_CONNECT_PROMPT).toContain("custom MCP server");
    expect(GROK_BOT_CONNECT_PROMPT).toContain("OAuth");
  });

  it("Grok Bot copies full instructions for working across companies", () => {
    expect(GROK_BOT_CONNECT_PROMPT).toContain("custom instructions for the indigo server");
    expect(GROK_BOT_CONNECT_PROMPT).toContain("hq_companies_list");
    expect(GROK_BOT_CONNECT_PROMPT).toContain("Pass that company on every HQ call");
    expect(GROK_BOT_CONNECT_PROMPT).toContain("hq_secrets_sandbox");
    expect(GROK_BOT_CONNECT_PROMPT).toContain("hq_integrations_call");
    expect(GROK_BOT_CONNECT_PROMPT).not.toContain("—");
  });

  it("copies the Grok Bot instructions and confirms with Copied", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await render();
    expect(q("settings-hq-connector-grok-bot-copy")?.textContent).toBe("Copy instructions");
    expect(q("settings-hq-connector-claude-copy")?.textContent).toBe("Copy");
    q("settings-hq-connector-grok-bot-copy")?.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(GROK_BOT_CONNECT_PROMPT);
    expect(q("settings-hq-connector-grok-bot-copy")?.textContent).toBe("Copied");
  });

  it("on a denied clipboard, reveals the text to select by hand and keeps Copy live", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await render();
    q("settings-hq-connector-grok-bot-copy")?.click();
    await settle();
    const manual = q("settings-hq-connector-grok-bot-manual");
    expect(manual?.textContent).toBe(GROK_BOT_CONNECT_PROMPT);
    const button = q("settings-hq-connector-grok-bot-copy") as HTMLButtonElement | null;
    expect(button?.disabled).toBe(false);
    expect(host.textContent).not.toContain("denied");
  });
});

describe("Settings → AI tools: Claude setup steps", () => {
  it("shows Claude's connector steps and no deep-link buttons", async () => {
    await render();
    const steps = q("settings-hq-connector-claude-steps");
    expect(steps?.querySelectorAll("li").length).toBe(4);
    expect(steps?.textContent).toContain("Add custom connector");
    expect(steps?.textContent).toContain("Indigo HQ");
    expect(host.querySelector("[data-testid$='-open']")).toBeNull();
    expect(q("settings-hq-connector-grok-bot-steps")).toBeNull();
  });
});
