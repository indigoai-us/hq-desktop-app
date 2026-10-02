// @vitest-environment happy-dom
import type { SettingsApi, ShellApi } from "@hq/platform";
import { ok } from "@hq/platform";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilesConnectPage from "./FilesConnectPage.svelte";

const openAgentWorkflow = vi.hoisted(() => vi.fn(async () => ({
  outcome: "opened" as const,
  ok: true,
  message: "Opened the deploy workflow in Claude Code.",
})));

vi.mock("../agent-workflow.js", () => ({ openAgentWorkflow }));
vi.mock("../company-store.svelte.js", () => ({
  companyStore: {
    revision: 0,
    loadSecrets: vi.fn(async () => [
      { name: "ATTIO_API_KEY", value: "sk-live-do-not-render", kind: "standard" },
    ]),
    loadDeployments: vi.fn(async () => []),
  },
}));

describe("US-029 FilesConnectPage", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    openAgentWorkflow.mockClear();
  });

  function mountPage(page: "vault" | "integrations" | "secrets" | "deployments") {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(FilesConnectPage, {
      target,
      props: {
        page,
        slug: "indigo",
        files: null,
        shell: {
          openInEditor: vi.fn(async () => ok(undefined)),
          openClaudeCodeLink: vi.fn(async () => ok(undefined)),
          openCodexDeepLink: vi.fn(async () => ok(undefined)),
          openFileInClaude: vi.fn(async () => ok(undefined)),
          launchClaudeCode: vi.fn(async () => ok(undefined)),
          launchCodexWorkspace: vi.fn(async () => ok(undefined)),
          launchCliInTerminal: vi.fn(async () => ok(undefined)),
          detectAiTools: vi.fn(async () => ok({})),
          pickFolder: vi.fn(async () => ok(null)),
          pickFile: vi.fn(async () => ok(null)),
        } satisfies ShellApi,
        settings: {
          getConfig: vi.fn(async () => ok({})),
          getSettings: vi.fn(async () => ok({})),
          updateSettings: vi.fn(async () => ok(undefined)),
          getSetupStatus: vi.fn(async () => ok({})),
          getTelemetryConsent: vi.fn(async () => ok(null)),
        } satisfies SettingsApi,
        openExternal: vi.fn(),
      },
    });
    flushSync();
    return target;
  }

  it("never puts a secret value in the share sheet or the page", async () => {
    const target = mountPage("secrets");
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const share = target.querySelector("[data-testid='share-secret']") as HTMLButtonElement;
    share.click();
    flushSync();
    expect(target.textContent).not.toContain("sk-live");
    expect(target.querySelector("[data-testid='share-no-value']")?.textContent).toContain("No secret value");
  });

  it("asks before redeploy and then calls the deploy workflow", async () => {
    const target = mountPage("deployments");
    const redeploy = target.querySelector("[data-testid='redeploy']") as HTMLButtonElement;
    redeploy.click();
    flushSync();
    expect(target.querySelector("[data-testid='sheet-confirm-redeploy']")).not.toBeNull();
    expect(openAgentWorkflow).not.toHaveBeenCalled();
    (target.querySelector("[data-testid='confirm-redeploy']") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openAgentWorkflow).toHaveBeenCalled();
    const prompt = String((openAgentWorkflow.mock.calls[0] as unknown as unknown[] | undefined)?.[1] ?? "");
    expect(prompt).toContain("/deploy indigo");
  });
});
