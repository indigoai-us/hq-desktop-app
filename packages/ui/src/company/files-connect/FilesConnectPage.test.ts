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
    loadDeployments: vi.fn(async () => [
      { name: "standup-report", url: "https://standup.example.test", state: "live" },
    ]),
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
    extra: Record<string, unknown> = {},
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
        ...extra,
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
    const target = mountPage("deployments", null, { listDeployApps });
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
    const target = mountPage("deployments", null, { listDeployApps });
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

  it("lists every secret from environment groups, not three sample rows (QA-014)", async () => {
    const store = (await import("../company-store.svelte.js")).companyStore as unknown as {
      loadSecrets: ReturnType<typeof vi.fn>;
    };
    const items = Array.from({ length: 25 }, (_, i) => ({ key: `KEY_${i}`, upd: "", rot: "2d ago" }));
    store.loadSecrets.mockResolvedValueOnce([
      { env: "prod", count: 25, items },
      { env: "dev", count: 3, items: items.slice(0, 3) },
    ]);
    const target = mountPage("secrets");
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(target.querySelectorAll("[data-testid='secret-row']").length).toBe(28);
    expect(target.querySelector("[data-testid='secrets-count']")?.textContent).toBe("Secrets · 28");
    expect(target.textContent).not.toContain("STRIPE_SECRET_KEY");
  });

  it("opens New secret as a centered sheet with Save, and Escape closes it", async () => {
    const target = mountPage("secrets");
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    (target.querySelector("[data-testid='new-secret']") as HTMLButtonElement).click();
    flushSync();
    const sheet = document.querySelector("[data-testid='sheet-new-secret']");
    expect(sheet?.getAttribute("role")).toBe("dialog");
    const save = document.querySelector("[data-testid='secret-save']") as HTMLButtonElement;
    expect(save.textContent).toBe("Save");
    expect(save.disabled).toBe(true);
    const name = document.querySelector("[data-testid='secret-name']") as HTMLInputElement;
    name.value = "NEW_KEY";
    name.dispatchEvent(new Event("input"));
    flushSync();
    expect(save.disabled).toBe(false);
    expect(document.querySelector("input[type='password']")).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    flushSync();
    expect(document.querySelector("[data-testid='sheet-new-secret']")).toBeNull();
  });

  it("binds the company read scope before listing the vault (QA-011)", async () => {
    const calls: string[] = [];
    const files = {
      listDir: vi.fn(async (path: string) => {
        calls.push(`list:${path}`);
        return ok([]);
      }),
      getFileContent: vi.fn(async () => ok("")),
    };
    const adapter = {
      files,
      appShell: {
        setActiveCompany: vi.fn(async (slug: string) => {
          calls.push(`bind:${slug}`);
          return ok(undefined);
        }),
      },
      isAvailable: () => false,
    };
    mountPage("vault", files, { adapter });
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync();
    }
    expect(calls[0]).toBe("bind:indigo");
    expect(calls).toContain("list:companies/indigo");
  });

  it("Vault Share shows this company's vault, never a secret from another view (QA-023)", async () => {
    const files = { listDir: vi.fn(async () => ok([])), getFileContent: vi.fn(async () => ok("")) };
    const target = mountPage("vault", files);
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    (target.querySelector("[data-testid='vault-share']") as HTMLButtonElement).click();
    flushSync();
    const sheet = document.querySelector("[data-testid='sheet-share']");
    expect(sheet?.textContent).toContain("companies/indigo");
    expect(sheet?.textContent).not.toContain("ATTIO_API_KEY");
    expect(sheet?.querySelector("[aria-selected='true']")?.textContent).toBe("Read");
  });

  it("opens the upload sheet from Vault Upload", async () => {
    const files = { listDir: vi.fn(async () => ok([])), getFileContent: vi.fn(async () => ok("")) };
    const target = mountPage("vault", files);
    flushSync();
    (target.querySelector("[data-testid='vault-upload']") as HTMLButtonElement).click();
    flushSync();
    expect(document.querySelector("[data-testid='sheet-upload']")).not.toBeNull();
    expect(document.querySelector("[data-testid='upload-choose']")).not.toBeNull();
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

  it("closes the vault Share dialog on Escape (QA-024)", async () => {
    const target = mountPage("vault");
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    (target.querySelector("[data-testid='vault-share']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='sheet-share']")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    flushSync();
    expect(target.querySelector("[data-testid='sheet-share']")).toBeNull();
  });
});
