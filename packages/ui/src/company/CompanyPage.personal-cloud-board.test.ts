// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";
import type { Workspace } from "../chat/workspaces.js";

vi.mock("./CompanyBoardPanel.svelte", async () => ({
  default: (await import("./CompanyBoardPanel.stub.svelte")).default,
}));
vi.mock("../projects/CompanyGoalsPage.svelte", async () => ({
  default: (await import("./CompanyBoardPanel.stub.svelte")).default,
}));
vi.mock("../projects/CompanyProjectsPage.svelte", async () => ({
  default: (await import("./CompanyBoardPanel.stub.svelte")).default,
}));
vi.mock("./CompanyOperationsPanel.svelte", async () => ({
  default: (await import("./CompanyBoardPanel.stub.svelte")).default,
}));
vi.mock("./CompanyLibraryPanel.svelte", async () => ({
  default: (await import("./CompanyBoardPanel.stub.svelte")).default,
}));
vi.mock("./CompanyKnowledgePanel.svelte", async () => ({
  default: (await import("./CompanyBoardPanel.stub.svelte")).default,
}));
vi.mock("./TeamPanel.svelte", async () => ({
  default: (await import("./CompanyBoardPanel.stub.svelte")).default,
}));
vi.mock("../meet/OfficePanel.svelte", async () => ({
  default: (await import("./CompanyBoardPanel.stub.svelte")).default,
}));
vi.mock("./company-store.svelte", () => ({
  configureCompanyApi: vi.fn(),
  startCompanyStore: vi.fn(),
}));

import CompanyPage from "./CompanyPage.svelte";

const PERSONAL_BOARD_FLAG = "desktop.personal-workspace-board-v1";

function personalWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: "personal",
    displayName: "Personal",
    kind: "personal",
    state: "personal",
    cloudUid: "prs_personal",
    bucketName: "personal-bucket",
    hasLocalFolder: true,
    localPath: "/hq",
    membershipStatus: null,
    role: null,
    syncEnabled: true,
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

function adapterWithFlag(enabled: boolean) {
  const hasFeature = vi.fn(async (flag: string) =>
    flag === PERSONAL_BOARD_FLAG ? ok(enabled) : ok(false),
  );
  return {
    adapter: {
      company: {},
      identity: { hasFeature },
    } as unknown as PlatformAdapter,
    hasFeature,
  };
}

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

async function render(company: Workspace, adapter: PlatformAdapter) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CompanyPage, {
    target: host,
    props: { company, adapter },
  });
  flushSync();
  await tick();
  await tick();
  return host;
}

afterEach(async () => {
  Reflect.deleteProperty(globalThis, "__HQ_HOST_OS__");
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

describe("CompanyPage personal cloud board", () => {
  it("uses the Windows computer noun in the pending invite explanation", async () => {
    Object.defineProperty(globalThis, "__HQ_HOST_OS__", { value: "windows", configurable: true });
    const company = personalWorkspace({
      slug: "example",
      displayName: "Example",
      kind: "company",
      state: "cloud-only",
      cloudUid: "cmp_example",
      membershipStatus: "pending",
    });
    const { adapter } = adapterWithFlag(false);
    const el = await render(company, adapter);
    expect(el.querySelector('[data-testid="company-invite-gate"]')?.textContent).toContain(
      "members, or settings on this PC.",
    );
  });

  it("enables board and summary reads and hides local-only when flagged on", async () => {
    const { adapter, hasFeature } = adapterWithFlag(true);
    const el = await render(personalWorkspace(), adapter);
    const state = el.querySelector<HTMLElement>('[data-testid="board-state"]');

    expect(hasFeature).toHaveBeenCalledWith(PERSONAL_BOARD_FLAG);
    expect(state?.dataset.cloudBacked).toBe("true");
    expect(state?.dataset.boardEnabled).toBe("true");
    expect(state?.dataset.summaryEnabled).toBe("true");
    expect(state?.textContent).not.toContain("local only");
  });

  it("keeps a personal workspace without a cloud UID local-only", async () => {
    const { adapter } = adapterWithFlag(true);
    const el = await render(personalWorkspace({ cloudUid: null }), adapter);
    const state = el.querySelector<HTMLElement>('[data-testid="board-state"]');

    expect(state?.dataset.boardEnabled).toBe("false");
    expect(state?.dataset.summaryEnabled).toBe("false");
    expect(state?.textContent).toContain("local only");
  });

  it("keeps a cloud-backed personal workspace local-only when the flag is off", async () => {
    const { adapter } = adapterWithFlag(false);
    const el = await render(personalWorkspace(), adapter);
    const state = el.querySelector<HTMLElement>('[data-testid="board-state"]');

    expect(state?.dataset.boardEnabled).toBe("false");
    expect(state?.dataset.summaryEnabled).toBe("false");
    expect(state?.textContent).toContain("local only");
  });
});
