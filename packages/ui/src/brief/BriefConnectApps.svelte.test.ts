// @vitest-environment happy-dom

/**
 * "Connect your AI apps" as a brief card in the welcome report: it lists
 * only the AI apps found on this computer, copies through the same
 * copyConnectorSetup as Settings → AI tools (with the select-by-hand
 * fallback), and holds the suggested integrations from the same scan under
 * the AI apps. Nothing found leaves the card out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import type { FoundWorkApps } from "@hq/platform";

vi.mock("../settings/hq-connector-setup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings/hq-connector-setup.js")>();
  return { ...actual, copyConnectorSetup: vi.fn(actual.copyConnectorSetup) };
});

import BriefConnectApps from "./BriefConnectApps.svelte";
import { CONNECTOR_APPS, copyConnectorSetup, foundConnectorApps } from "../settings/hq-connector-setup.js";
import type { WelcomeSuggest } from "./welcome-ai-apps.js";
import type { YourAppsHost, YourAppsLoad, YourAppsResult } from "../chat/first-run/your-apps-host.js";

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
  return {
    platform: "macos",
    scannedAtMs: 1,
    apps,
    mcpServers: [],
    sources: [],
    truncated: false,
  };
}

const LOAD: YourAppsLoad = {
  catalog: {
    "linear.app": { entryId: "e-linear", name: "Linear", authClass: "oauth" },
  },
  connections: [],
  installations: {},
  canManage: true,
  problem: null,
};

function fakeHost(): YourAppsHost {
  return {
    detect: vi.fn(async () => null),
    load: vi.fn(async () => LOAD),
    autoConnect: vi.fn(async (): Promise<YourAppsResult> => ({
      ok: false,
      reason: "",
      retry: false,
    })),
    connect: vi.fn(() => new Promise<YourAppsResult>(() => undefined)),
    setup: vi.fn(() => new Promise<YourAppsResult>(() => undefined)),
    undo: vi.fn(async (): Promise<YourAppsResult> => ({
      ok: true,
      connectionId: null,
      installationId: null,
    })),
  };
}

function render(
  apps: FoundWorkApps["apps"],
  cli = { claudeCode: false, codex: false },
  suggest: WelcomeSuggest | null = null,
): { detect: ReturnType<typeof vi.fn> } {
  target = document.createElement("div");
  document.body.appendChild(target);
  const detect = vi.fn(async () => scan(apps));
  component = mount(BriefConnectApps, {
    target,
    props: { detect, cli, suggest },
  });
  return { detect };
}

beforeEach(() => {
  vi.mocked(copyConnectorSetup).mockClear();
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
  vi.restoreAllMocks();
});

describe("BriefConnectApps", () => {
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

  it("Copy goes through copyConnectorSetup with the Settings text and says Copied", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render([], { claudeCode: true, codex: false });
    await settle();
    q("connect-ai-app-claude-code-copy")!.click();
    await settle();
    const settingsText = CONNECTOR_APPS.find((a) => a.id === "claude-code")!.copyText;
    expect(copyConnectorSetup).toHaveBeenCalledTimes(1);
    expect(copyConnectorSetup).toHaveBeenCalledWith(settingsText);
    expect(writeText).toHaveBeenCalledWith(settingsText);
    expect(q("connect-ai-app-claude-code-copy")?.textContent?.trim()).toBe("Copied");
    expect(q("connect-ai-app-claude-code-manual")).toBeNull();
  });

  it("when copyConnectorSetup fails, shows the text to select by hand and the copy-failure line", async () => {
    vi.mocked(copyConnectorSetup).mockResolvedValueOnce(false);
    render([{ bundleId: "com.openai.chat", name: "ChatGPT" }]);
    await settle();
    q("connect-ai-app-chatgpt-copy")!.click();
    await settle();
    expect(copyConnectorSetup).toHaveBeenCalledWith(CONNECTOR_APPS.find((a) => a.id === "chatgpt")!.copyText);
    expect(q("connect-ai-app-chatgpt-manual")?.textContent).toBe(CONNECTOR_APPS.find((a) => a.id === "chatgpt")!.copyText);
    expect(q("connect-ai-app-chatgpt")?.textContent).toContain(
      "Copy didn't work. Select the text above, or tap the button to try again.",
    );
    expect(q("connect-ai-app-chatgpt-copy")?.textContent?.trim()).not.toBe("Copied");
  });

  it("on a denied clipboard, shows the text to select by hand", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render([{ bundleId: "com.openai.chat", name: "ChatGPT" }]);
    await settle();
    q("connect-ai-app-chatgpt-copy")!.click();
    await settle();
    expect(copyConnectorSetup).toHaveBeenCalledTimes(1);
    expect(q("connect-ai-app-chatgpt-manual")?.textContent).toBe(CONNECTOR_APPS.find((a) => a.id === "chatgpt")!.copyText);
  });

  it("warns and leaves the card out when the scan throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = new Error("scan broke");
    target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(BriefConnectApps, {
      target,
      props: {
        detect: vi.fn(async () => {
          throw err;
        }),
        cli: { claudeCode: false, codex: false },
        suggest: null,
      },
    });
    await settle();
    expect(warn).toHaveBeenCalledWith("[hq-desktop] welcome report app scan threw:", err);
    expect(q("connect-ai-apps-card")).toBeNull();
  });

  it("is left out when no found app matches and there are no suggestions", async () => {
    render([{ bundleId: "com.linear", name: "Linear" }]);
    await settle();
    expect(q("connect-ai-apps-card")).toBeNull();
  });

  it("is left out when the scan found nothing or could not run", async () => {
    render([], { claudeCode: false, codex: false }, { host: fakeHost(), company: { uid: "cmp_acme", name: "Acme" } });
    await settle();
    expect(q("connect-ai-apps-card")).toBeNull();
    unmount(component!);
    target.remove();

    target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(BriefConnectApps, {
      target,
      props: {
        detect: vi.fn(async () => null),
        cli: { claudeCode: false, codex: false },
        suggest: { host: fakeHost(), company: null },
      },
    });
    await settle();
    expect(q("connect-ai-apps-card")).toBeNull();
  });

  it("holds the suggested integrations from the same scan under the AI apps, with one detect", async () => {
    const host = fakeHost();
    const { detect } = render(
      [
        { bundleId: "com.anthropic.claudefordesktop", name: "Claude" },
        { bundleId: "com.linear", name: "Linear" },
      ],
      { claudeCode: false, codex: false },
      { host, company: { uid: "cmp_acme", name: "Acme" } },
    );
    await settle();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(host.detect).not.toHaveBeenCalled();
    const card = q("connect-ai-apps-card")!;
    const group = q("connect-suggested-apps")!;
    expect(card.contains(group)).toBe(true);
    expect(q("connect-ai-app-claude")!.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.querySelector("h2")?.textContent).toBe("Your apps");
    expect(group.querySelector("h3")?.textContent).toBe("Connect your work apps.");
    expect(q("suggested-app-linear.app")).not.toBeNull();
    expect(q("suggested-app-connect-linear.app")?.textContent?.trim()).toBe("Connect");
  });

  it("with only work apps found, the card shows just the suggested group", async () => {
    render(
      [{ bundleId: "com.linear", name: "Linear" }],
      { claudeCode: false, codex: false },
      { host: fakeHost(), company: null },
    );
    await settle();
    expect(q("connect-ai-apps-card")).not.toBeNull();
    expect(q("connect-ai-apps-card")?.textContent).not.toContain("Connect your AI apps");
    expect(q("suggested-app-linear.app")).not.toBeNull();
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
    expect(
      ids([{ bundleId: "com.openai.codex", name: "ChatGPT" }], {
        claudeCode: false,
        codex: true,
      }),
    ).toEqual(["chatgpt", "codex"]);
    expect(ids([{ bundleId: "ai.x.GrokApp", name: "Grok" }])).toEqual(["grok-bot"]);
    expect(ids([], { claudeCode: true, codex: true })).toEqual(["claude-code", "codex"]);
    expect(ids([{ bundleId: "com.linear", name: "Linear" }])).toEqual([]);
  });
});
