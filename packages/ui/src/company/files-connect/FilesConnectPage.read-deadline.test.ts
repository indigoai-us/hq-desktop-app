// @vitest-environment happy-dom
// BLANK-1: company Secrets and Deployments reads that never answer must not
// hold their skeletons forever; after the shared read deadline each shows its
// failed line and Try again.
import type { SettingsApi, ShellApi } from "@hq/platform";
import { ok } from "@hq/platform";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READ_DEADLINE_MS } from "../../common/read-deadline.js";
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

describe("FilesConnectPage read deadline (BLANK-1)", () => {
  it.each([
    ["secrets", "Could not load secrets."],
    ["deployments", "Could not load deployments."],
  ] as const)("a %s read that never answers ends in the failed-read state", async (page, copy) => {
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
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS + 20);
    flushSync();
    expect(document.querySelector("[data-testid='files-connect-skeleton']")).toBeNull();
    expect(document.body.textContent).toContain(copy);
    expect([...document.querySelectorAll("button")].some((b) => /Try again/.test(b.textContent ?? ""))).toBe(true);
    expect(logged).toHaveBeenCalled();
  });
});
