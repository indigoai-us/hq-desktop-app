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

  describe("Vault What's new (QA-070)", () => {
    const flush = async () => {
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        flushSync();
      }
    };
    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const baseFiles = (listing: () => Promise<unknown>) => ({
      listDir: vi.fn(async () => ok([])),
      getFileContent: vi.fn(async () => ok("# hi")),
      atlasLocal: { listing: vi.fn(listing), firstPage: vi.fn(), readText: vi.fn() },
    });
    const openNew = (target: HTMLElement) => {
      (target.querySelector("[data-testid='vault-whats-new']") as HTMLButtonElement).click();
      flushSync();
    };

    it("lists files changed in the last 7 days, newest first, never a blank body", async () => {
      const files = baseFiles(async () => ok({
        objects: [
          { key: "knowledge/old.md", lastModified: iso(9 * 86_400_000) },
          { key: "knowledge/gtm.md", lastModified: iso(2 * 3_600_000) },
          { key: "projects/x/prd.json", lastModified: iso(60_000 * 5) },
          { key: "projects/x/", lastModified: iso(1000) },
        ],
      }));
      const target = mountPage("vault", files);
      await flush();
      openNew(target);
      await flush();
      const rows = [...target.querySelectorAll<HTMLElement>("[data-testid='vault-recent-row']")];
      expect(rows.map((row) => row.dataset.path)).toEqual([
        "companies/indigo/projects/x/prd.json",
        "companies/indigo/knowledge/gtm.md",
      ]);
      expect(target.querySelector("[data-testid='vault-preview']")).not.toBeNull();
      // No selection: Access is hidden, not headless.
      expect(target.querySelector("[data-testid='vault-access']")).toBeNull();
      rows[1]!.click();
      flushSync();
      expect(target.querySelector("[data-testid='vault-access'] h2")?.textContent).toBe("knowledge");
      expect(target.querySelector("[data-testid='vault-preview-empty']")).toBeNull();
    });

    it("shows an explicit empty state when nothing changed in 7 days", async () => {
      const files = baseFiles(async () => ok({ objects: [{ key: "a.md", lastModified: iso(30 * 86_400_000) }] }));
      const target = mountPage("vault", files);
      await flush();
      openNew(target);
      await flush();
      expect(target.querySelector("[data-testid='vault-recent-empty']")?.textContent).toContain("No files changed in the last 7 days");
      expect(target.querySelector("[data-testid='vault-access']")).toBeNull();
    });

    it("shows loading, then an error state with retry when the listing fails", async () => {
      let fail = true;
      let release: (() => void) | null = null;
      const files = baseFiles(() => new Promise((resolve) => {
        release = () => resolve(fail ? { ok: false, code: "io", reason: "boom" } : ok({ objects: [] }));
      }));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const target = mountPage("vault", files);
      await flush();
      openNew(target);
      await flush();
      expect(target.querySelector("[data-testid='vault-recent-loading']")).not.toBeNull();
      release!();
      await flush();
      const error = target.querySelector("[data-testid='vault-recent-error']");
      expect(error?.textContent).toContain("Could not load recent files.");
      expect(error?.textContent).not.toContain("boom");
      fail = false;
      (error!.querySelector("button") as HTMLButtonElement).click();
      await flush();
      release!();
      await flush();
      expect(target.querySelector("[data-testid='vault-recent-empty']")).not.toBeNull();
      errSpy.mockRestore();
    });

    it("All restores the tree and its Access target", async () => {
      const files = baseFiles(async () => ok({ objects: [] }));
      const target = mountPage("vault", files);
      await flush();
      openNew(target);
      await flush();
      (target.querySelector("[aria-label='Vault view'] [role='tab']") as HTMLButtonElement).click();
      await flush();
      expect(target.querySelector("[data-testid='vault-tree']")).not.toBeNull();
      expect(target.querySelector("[data-testid='vault-access'] h2")?.textContent).toBe("indigo");
    });
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
    expect(save.querySelector(".rail-btn-label")?.textContent).toBe("Save");
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

  it("never shows one company's integrations, people or vault rows under another (QA-028)", async () => {
    const seen: Record<string, string> = {};
    for (const slug of ["indigo", "amass"]) {
      const target = document.createElement("div");
      document.body.appendChild(target);
      const c = mount(FilesConnectPage, {
        target,
        props: { page: "integrations", slug, files: null, shell: null, settings: null },
      });
      flushSync();
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync();
      seen[slug] = target.textContent ?? "";
      expect(target.querySelectorAll("button.row")).toHaveLength(0);
      expect(target.querySelector("[data-testid='integrations-empty']")?.textContent).toBe("No connected apps yet");
      await unmount(c);
      target.remove();
    }
    for (const text of Object.values(seen)) {
      expect(text).not.toMatch(/indigo\.slack\.com|Yousuf|Eric B\.|Corey/);
    }
    expect(seen.amass).not.toContain("indigo");
  });

  it("grants vault access to a chosen person through hq files share (QA-025)", async () => {
    const files = { listDir: vi.fn(async () => ok([])), getFileContent: vi.fn(async () => ok("")) };
    const adapter = {
      files,
      appShell: { setActiveCompany: vi.fn(async () => ok(undefined)) },
      company: {
        listMembers: vi.fn(async () => ok([{ email: "ada@example.com", displayName: "Ada" }])),
      },
      isAvailable: () => false,
    };
    const target = mountPage("vault", files, { adapter });
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(target.textContent).not.toContain("Eric B.");
    (target.querySelector("[data-testid='grant-access']") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(adapter.company.listMembers).toHaveBeenCalledWith("indigo");
    expect(document.querySelector("#fc-grant-members option")?.getAttribute("value")).toBe("ada@example.com");
    const save = document.querySelector("[data-testid='grant-save']") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const input = document.querySelector("[data-testid='grant-recipient']") as HTMLInputElement;
    input.value = "ada@example.com";
    input.dispatchEvent(new Event("input"));
    flushSync();
    expect(save.disabled).toBe(false);
    save.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prompt = String((openAgentWorkflow.mock.calls[0] as unknown as unknown[] | undefined)?.[1] ?? "");
    expect(prompt).toContain('hq files share "" --company indigo --with ada@example.com --permission read');
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

  it("lists deployable project sources, deploys the picked one, and explains an empty list (QA-044)", async () => {
    const P = "companies/indigo/projects";
    const tree: Record<string, unknown[]> = {
      [P]: [{ name: "launch", path: `${P}/launch`, isDir: true, hasChildren: true }],
      [`${P}/launch`]: [{ name: "index.html", path: `${P}/launch/index.html`, isDir: false, hasChildren: false }],
    };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const files = {
      listDir: vi.fn(async (path: string) => {
        if (path === P) await gate;
        return ok(tree[path] ?? []);
      }),
    };
    const listDeployApps = vi.fn(async () => ok({ apps: [] }));
    const target = mountPage("deployments", files, { listDeployApps });
    (target.querySelector("[data-testid='deploy-from-project']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='deploy-sources-skeleton']")).not.toBeNull();
    expect((target.querySelector("[data-testid='run-deploy']") as HTMLButtonElement).disabled).toBe(true);
    release();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='deploy-source']")).not.toBeNull());
    expect(target.querySelector("[data-testid='deploy-source-path']")?.textContent).toBe(`${P}/launch`);
    const run = target.querySelector("[data-testid='run-deploy']") as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    run.click();
    await vi.waitFor(() => expect(openAgentWorkflow).toHaveBeenCalled());
    const prompt = String((openAgentWorkflow.mock.calls[0] as unknown as unknown[] | undefined)?.[1] ?? "");
    expect(prompt).toContain("/deploy indigo");
    expect(prompt).toContain(`Artifact: ${P}/launch`);
  });

  it("shows why nothing is deployable and keeps Deploy disabled (QA-044)", async () => {
    const files = { listDir: vi.fn(async () => ok([])) };
    const target = mountPage("deployments", files, { listDeployApps: vi.fn(async () => ok({ apps: [] })) });
    (target.querySelector("[data-testid='deploy-from-project']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='deploy-sources-empty']")).not.toBeNull());
    expect(target.querySelector("[data-testid='deploy-sources-empty']")?.textContent).toMatch(/no projects yet/);
    expect((target.querySelector("[data-testid='run-deploy']") as HTMLButtonElement).disabled).toBe(true);
  });
});
