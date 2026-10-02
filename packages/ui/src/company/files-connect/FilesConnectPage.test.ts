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

  function mountPage(
    page: "vault" | "integrations" | "secrets" | "deployments",
    files: unknown = null,
    listDeployApps: unknown = undefined,
  ) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(FilesConnectPage, {
      target,
      props: {
        page,
        slug: "indigo",
        files: files as never,
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
        listDeployApps: listDeployApps as never,
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

  it("shows every secret and deployment, paging past 50 with a Show more row", async () => {
    const { companyStore } = await import("../company-store.svelte.js");
    const secrets = Array.from({ length: 60 }, (_, i) => ({ name: `SECRET_${i}`, kind: "standard" }));
    const deployments = Array.from({ length: 7 }, (_, i) => ({ name: `deploy-${i}`, url: `https://d${i}.example` }));
    vi.mocked(companyStore.loadSecrets).mockResolvedValue(secrets as never);
    vi.mocked(companyStore.loadDeployments).mockResolvedValue(deployments as never);
    try {
      let target = mountPage("secrets");
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync();
      const list = () => target.querySelector("[data-testid='secrets-list']") as HTMLElement;
      expect(target.querySelector("[data-testid='secrets-count']")?.textContent).toBe("Secrets · 60");
      expect(list().querySelectorAll("button.row")).toHaveLength(50);
      const more = target.querySelector("[data-testid='secrets-show-more']") as HTMLButtonElement;
      expect(more.textContent).toContain("Show 10 more");
      more.click();
      flushSync();
      expect(list().querySelectorAll("button.row")).toHaveLength(60);
      expect(list().textContent).toContain("SECRET_59");
      expect(target.querySelector("[data-testid='secrets-show-more']")).toBeNull();

      if (component) await unmount(component);
      target = mountPage("deployments");
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync();
      expect(target.querySelector("[data-testid='deployments-count']")?.textContent).toBe("Deployments · 7");
      expect(target.querySelectorAll("[data-testid='deployments-list'] button.row")).toHaveLength(7);
      expect(target.querySelector("[data-testid='deployments-show-more']")).toBeNull();
    } finally {
      vi.mocked(companyStore.loadSecrets).mockResolvedValue([
        { name: "ATTIO_API_KEY", value: "sk-live-do-not-render", kind: "standard" },
      ] as never);
      vi.mocked(companyStore.loadDeployments).mockResolvedValue([] as never);
    }
  });

  it("names company deployments from real hq-deploy apps, never placeholders (QA-013)", async () => {
    const calls: string[] = [];
    const listDeployApps = vi.fn(async (scope: string) => {
      calls.push(scope);
      return ok({
        callerSub: "me",
        apps: [
          { id: "1", name: "hq-lifecycle-email-map", subdomain: "hq-lifecycle-email-map", url: "https://hq-lifecycle-email-map.indigo-hq.com", status: "active", active: true },
          { id: "2", subdomain: "board-v2", url: "https://board-v2.indigo-hq.com", status: "active", active: false },
        ],
      });
    });
    const target = mountPage("deployments", null, listDeployApps);
    expect(target.textContent).not.toContain("indigo-standup-report");
    await vi.waitFor(() => expect(target.textContent).toContain("hq-lifecycle-email-map"));
    expect(calls).toEqual(["indigo"]);
    expect(target.textContent).toContain("board-v2");
    expect(target.textContent).not.toMatch(/deploy-\d/);
    expect(target.textContent).not.toContain("docs.getindigo.ai");
  });

  it("asks before redeploy and then calls the deploy workflow", async () => {
    const listDeployApps = vi.fn(async () =>
      ok({ apps: [{ id: "1", name: "real-app", subdomain: "real-app", url: "https://real-app.indigo-hq.com", status: "active" }] }),
    );
    const target = mountPage("deployments", null, listDeployApps);
    await vi.waitFor(() => expect(target.querySelector("[data-testid='redeploy']")).not.toBeNull());
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

  it("shows the vault as a folder tree with a quiet preview until a file is picked", async () => {
    const tree: Record<string, unknown[]> = {
      "companies/indigo": [
        { name: "knowledge", path: "companies/indigo/knowledge", isDir: true, hasChildren: true },
        { name: "README.md", path: "companies/indigo/README.md", isDir: false, hasChildren: false },
      ],
      "companies/indigo/knowledge": [
        { name: "gtm.md", path: "companies/indigo/knowledge/gtm.md", isDir: false, hasChildren: false },
      ],
    };
    const files = {
      listDir: vi.fn(async (path: string) => ok(tree[path] ?? [])),
      getFileContent: vi.fn(async () => ok("# GTM")),
    };
    const target = mountPage("vault", files);
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(target.querySelector("[data-testid='vault-tree']")).not.toBeNull();
    expect(target.querySelector("[data-testid='vault-list']")).toBeNull();
    expect(target.querySelector("[data-testid='vault-preview-empty']")?.textContent).toContain("Select a file");
    expect(target.querySelector("[data-testid='vault-summary']")?.textContent).toBe("1 folder · 1 file");
    const rowFor = (path: string) =>
      target.querySelector<HTMLElement>(`[data-testid='file-tree-row'][data-path='${path}']`);
    rowFor("companies/indigo/knowledge")!.click();
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync();
    }
    rowFor("companies/indigo/knowledge/gtm.md")!.click();
    flushSync();
    expect(target.querySelector("[data-testid='vault-preview-empty']")).toBeNull();
    expect(target.querySelector("[data-testid='vault-access'] h2")?.textContent).toBe("knowledge");
  });

  it("closes the Connect app dialog on Escape (QA-012)", () => {
    const target = mountPage("integrations");
    (target.querySelector("[data-testid='connect-app']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='sheet-connect']")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    flushSync();
    expect(target.querySelector("[data-testid='sheet-connect']")).toBeNull();
  });
});
