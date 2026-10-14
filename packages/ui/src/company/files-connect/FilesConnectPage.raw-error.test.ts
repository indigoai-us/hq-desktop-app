// @vitest-environment happy-dom
/** AUDIT-3c: a refused upload never shows the server text in its row. */
import type { SettingsApi, ShellApi } from "@hq/platform";
import { failure, ok } from "@hq/platform";
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

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}. Bucket refused.';

describe("FilesConnectPage upload raw error text", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("a refused presign shows plain copy in the row and logs the raw text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const files = {
      listDir: vi.fn(async () => ok([])),
      getFileContent: vi.fn(async () => ok("")),
      presignVaultPut: vi.fn(async () => failure("UPSTREAM_500", RAW)),
    };
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(FilesConnectPage, {
      target,
      props: {
        page: "vault",
        slug: "indigo",
        companyUid: "cmp_indigo",
        files: files as never,
        shell: { pickFile: vi.fn(async () => ok(null)) } as unknown as ShellApi,
        settings: { getConfig: vi.fn(async () => ok({})) } as unknown as SettingsApi,
        openExternal: vi.fn(),
      },
    });
    flushSync();
    (target.querySelector("[data-testid='vault-upload']") as HTMLButtonElement).click();
    flushSync();
    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const file = new File(["hello"], "notes.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    const startBtn = document.querySelector("[data-testid='upload-start']") as HTMLButtonElement;
    startBtn.click();
    await vi.waitFor(() => {
      expect(document.querySelector(".fr[data-status='failed']")).not.toBeNull();
    });
    flushSync();
    const row = document.querySelector(".fr[data-status='failed']")!;
    expect(row.textContent).toContain("Could not prepare the upload.");
    expect(document.body.innerHTML).not.toContain("HTTP 500");
    expect(document.body.innerHTML).not.toContain("Bucket refused");
    expect(warn).toHaveBeenCalledWith("[files] upload presign failed", "UPSTREAM_500", RAW);
  });
});
