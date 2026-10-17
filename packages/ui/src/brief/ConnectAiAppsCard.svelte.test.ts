// @vitest-environment happy-dom

/**
 * "Connect your AI apps" on the welcome report: lists only the AI apps found
 * on this computer, copies the same setup text as Settings → AI tools, and is
 * left out when nothing matches.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import type { FoundWorkApps } from "@hq/platform";

import ConnectAiAppsCard from "./ConnectAiAppsCard.svelte";
import { CONNECTOR_APPS, foundConnectorApps } from "../settings/hq-connector-setup.js";

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}
const q = (id: string): HTMLElement | null => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function scan(apps: FoundWorkApps["apps"]): FoundWorkApps {
  return { platform: "macos", scannedAtMs: 1, apps, mcpServers: [], sources: [], truncated: false };
}

function render(
  apps: FoundWorkApps["apps"],
  cli = { claudeCode: false, codex: false },
  anywhereOnId: string | null = null,
): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(ConnectAiAppsCard, { target, props: { detect: async () => scan(apps), cli, anywhereOnId } });
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
  vi.restoreAllMocks();
});

describe("ConnectAiAppsCard", () => {
  it("lists only the AI apps found, under the decided heading and line", async () => {
    render([
      { bundleId: "com.anthropic.claudefordesktop", name: "Claude" },
      { bundleId: "com.linear", name: "Linear" },
    ]);
    await settle();
    expect(q("connect-ai-apps-card")?.querySelector("h2")?.textContent).toBe("Connect your AI apps");
    expect(q("connect-ai-apps-card")?.textContent).toContain("Let the apps you already use read and write your HQ.");
    expect(q("connect-ai-app-claude")).not.toBeNull();
    expect(q("connect-ai-app-chatgpt")).toBeNull();
    expect(q("connect-ai-app-claude-code")).toBeNull();
    expect(target.querySelectorAll('[data-testid^="connect-ai-app-"][data-testid$="-copy"]').length).toBe(1);
  });

  it("copies the same setup text as Settings → AI tools", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render([], { claudeCode: true, codex: false });
    await settle();
    q("connect-ai-app-claude-code-copy")!.click();
    await settle();
    const settingsText = CONNECTOR_APPS.find((a) => a.id === "claude-code")!.copyText;
    expect(writeText).toHaveBeenCalledWith(settingsText);
    expect(q("connect-ai-app-claude-code-copy")?.textContent?.trim()).toBe("Copied");
  });

  it("on a denied clipboard, shows the text to select by hand", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render([{ bundleId: "com.openai.chat", name: "ChatGPT" }]);
    await settle();
    q("connect-ai-app-chatgpt-copy")!.click();
    await settle();
    expect(q("connect-ai-app-chatgpt-manual")?.textContent).toBe(CONNECTOR_APPS.find((a) => a.id === "chatgpt")!.copyText);
  });

  it("keeps Copy on every tool and adds a quiet note where HQ Anywhere is on", async () => {
    render([], { claudeCode: true, codex: true }, "codex");
    await settle();
    expect(q("connect-ai-app-codex-anywhere")?.textContent).toBe("HQ Anywhere on");
    expect(q("connect-ai-app-codex-copy")?.textContent?.trim()).toBe("Copy");
    expect(q("connect-ai-app-codex-setup")).toBeNull();
    expect(q("connect-ai-app-codex")?.textContent).toContain("Paste into Codex");
    expect(q("connect-ai-app-claude-code-copy")).not.toBeNull();
    expect(q("connect-ai-app-claude-code-anywhere")).toBeNull();
    expect(q("connect-ai-app-claude-code")?.textContent).not.toContain("HQ is already installed");
  });

  it("keeps Copy when the install did not succeed", async () => {
    render([], { claudeCode: true, codex: true }, null);
    await settle();
    expect(q("connect-ai-app-claude-code-copy")?.textContent?.trim()).toBe("Copy");
    expect(q("connect-ai-app-codex-copy")?.textContent?.trim()).toBe("Copy");
    expect(q("connect-ai-app-claude-code-setup")).toBeNull();
    expect(q("connect-ai-app-codex-setup")).toBeNull();
    expect(q("connect-ai-app-claude-code")?.textContent).toContain("Paste into a Claude Code session");
  });

  it("is left out when no found app matches", async () => {
    render([{ bundleId: "com.linear", name: "Linear" }]);
    await settle();
    expect(q("connect-ai-apps-card")).toBeNull();
  });
});

describe("foundConnectorApps", () => {
  it("matches Claude, ChatGPT, Codex and Grok by bundle id and the CLIs from launch detection", () => {
    const ids = (apps: FoundWorkApps["apps"], cli = { claudeCode: false, codex: false }) =>
      foundConnectorApps(apps, cli).map((a) => a.id);
    expect(ids([{ bundleId: "com.anthropic.claudefordesktop", name: "Claude" }])).toEqual(["claude"]);
    expect(ids([{ bundleId: "com.openai.chat", name: "ChatGPT" }])).toEqual(["chatgpt"]);
    // The ChatGPT app can carry this bundle id; Codex is listed only when the CLI was found.
    expect(ids([{ bundleId: "com.openai.codex", name: "ChatGPT" }])).toEqual(["chatgpt"]);
    expect(ids([{ bundleId: "com.openai.codex", name: "ChatGPT" }], { claudeCode: false, codex: true })).toEqual(["chatgpt", "codex"]);
    expect(ids([{ bundleId: "ai.x.GrokApp", name: "Grok" }])).toEqual(["grok-bot"]);
    expect(ids([], { claudeCode: true, codex: true })).toEqual(["claude-code", "codex"]);
    expect(ids([{ bundleId: "com.linear", name: "Linear" }])).toEqual([]);
  });
});
