// @vitest-environment happy-dom
// BLANK-1: company Secrets and Deployments reads that never answer must not
// hold their skeletons forever; after the shared read deadline each shows its
// failed line and Try again.
import type { SettingsApi, ShellApi } from "@hq/platform";
import { ok } from "@hq/platform";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectPendingRead } from "../../common/read-loader.test-support.js";
import FilesConnectPage from "./FilesConnectPage.svelte";

vi.mock("../company-store.svelte.js", () => ({
  companyStore: {
    revision: 0,
    loadSecrets: vi.fn(() => new Promise(() => {})),
    loadDeployments: vi.fn(() => new Promise(() => {})),
  },
}));

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FilesConnectPage pending read (BLANK-3)", () => {
  it.each([
    ["secrets", "Could not load secrets."],
    ["deployments", "Could not load deployments."],
  ] as const)("a %s read that never answers keeps loading with a waiting line and Try again, never a failed state", async (page, copy) => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    component = mount(FilesConnectPage, {
      target: document.body,
      props: {
        page,
        slug: `blank-1-${page}`,
        companyUid: "cmp_blank1",
        files: null,
        shell: { pickFile: vi.fn(async () => ok(null)) } as unknown as ShellApi,
        settings: { getConfig: vi.fn(async () => ok({})) } as unknown as SettingsApi,
        openExternal: vi.fn(),
        listDeployApps: () => new Promise(() => {}),
      } as never,
    });
    flushSync();
    expect(document.querySelector("[data-testid='files-connect-skeleton']")).toBeTruthy();
    await expectPendingRead(document, `${page}-loader`);
    expect(document.body.textContent).not.toContain(copy);
    expect(logged).not.toHaveBeenCalled();
    // BLANK-2: no zero count next to the failed read.
    expect(document.querySelector("[data-testid='secrets-count'],[data-testid='deployments-count']")).toBeNull();
    expect(document.body.textContent).not.toMatch(/(Secrets|Deployments) · 0\b/);
  });
});

describe("FilesConnectPage vault summary pending read (BLANK-3)", () => {
  it("the folder summary shows the loader, not a bare Reading folder… line", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const never = () => new Promise(() => {});
    component = mount(FilesConnectPage, {
      target: document.body,
      props: {
        page: "vault",
        slug: "blank-1-vault",
        companyUid: "cmp_blank1",
        files: { listDir: vi.fn(never), getFileContent: vi.fn(never), listVaultPrefix: vi.fn(never) },
        shell: { pickFile: vi.fn(async () => ok(null)) } as unknown as ShellApi,
        settings: { getConfig: vi.fn(async () => ok({})) } as unknown as SettingsApi,
        openExternal: vi.fn(),
      } as never,
    });
    flushSync();
    await expectPendingRead(document, "vault-summary-loader");
    expect(document.body.textContent ?? "").not.toContain("Reading folder…");
  });
});
