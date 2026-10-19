/**
 * Doors into surfaces that are not needed to paint the first frame of Home.
 * Each door is the only import of its heavy body. The shell imports this file
 * and LazyDoor.svelte; the bodies load as separate chunks on first open.
 * The module promise is memoized, and `peek()` returns the loaded module so a
 * second open paints the body in the same frame instead of the skeleton.
 * Same pattern as atlas-lazy.ts and telemetry-lazy.ts.
 */
import type { Component } from "svelte";
import { reportLazyLoadFailure } from "../common/lazy-load-report.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = Component<any>;

export interface Door {
  load(): Promise<AnyComponent>;
  peek(): AnyComponent | null;
  preload(): void;
}

/**
 * Waits between attempts after a failed chunk load. A chunk can fail to load
 * when the file is briefly missing (a UI bundle swap, an app update in
 * progress) or the read is interrupted. Two retries, then the failure is
 * reported and the door shows its failed state with Try again.
 */
export const LAZY_DOOR_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A memoized door. `surface` names the body in failure reports. A load that
 * fails after its retries clears the memo, so the next `load()` (Try again,
 * or the next mount) starts over.
 */
export function createDoor(
  surface: string,
  importer: () => Promise<{ default: AnyComponent }>,
  retryDelaysMs: readonly number[] = LAZY_DOOR_RETRY_DELAYS_MS,
): Door {
  let pending: Promise<AnyComponent> | null = null;
  let loaded: AnyComponent | null = null;
  const attempt = async (): Promise<AnyComponent> => {
    let lastError: unknown;
    for (let i = 0; i <= retryDelaysMs.length; i++) {
      try {
        return (await importer()).default;
      } catch (err) {
        lastError = err;
        if (i < retryDelaysMs.length) await wait(retryDelaysMs[i]!);
      }
    }
    reportLazyLoadFailure(surface, lastError);
    throw lastError;
  };
  const load = () => {
    pending ??= attempt().then(
      (component) => (loaded = component),
      (err) => {
        pending = null;
        throw err;
      },
    );
    return pending;
  };
  return {
    load,
    peek: () => loaded,
    preload: () => {
      load().catch(() => undefined);
    },
  };
}

export const profilePaneDoor = createDoor("ProfilePaneHost",
  () => import("./profile-panes/ProfilePaneHost.svelte"),
);
// OWNER-R5/R6: the shared styled dropdown loads with the first filter that
// shows it, keeping it out of the start-up bundle.
export const dropdownDoor = createDoor("Dropdown", () => import("../common/Dropdown.svelte"));
// OWNER-R9: the Team member pane's access section loads when a pane opens.
// OWNER-R9: the company Team page loads when Team opens.
export const teamPageDoor = createDoor("TeamPage", () => import("../company/TeamPage.svelte"));
export const memberAccessDoor = createDoor("MemberAccessSection", () => import("../company/MemberAccessSection.svelte"));
/** The Files explorer; fetched right after startup so Files opens in one frame. */
export const vaultExplorerDoor = createDoor("VaultExplorer", () => import("../files/explorer/VaultExplorer.svelte"));
/** OWNER-R17: the Access section of the Files and Vault right pane. */
export const accessSectionDoor = createDoor("AccessSection", () => import("../files/explorer/AccessSection.svelte"));
/** OWNER-R13: a selected folder's contents on the Vault page. */
export const vaultFolderViewDoor = createDoor("VaultFolderView", () => import("../files/explorer/VaultFolderView.svelte"));
export const notificationsPopoverDoor = createDoor("NotificationsPopover",
  () => import("../inbox/NotificationsPopover.svelte"),
);
export const moreCompaniesDoor = createDoor("MoreCompaniesPopover",
  () => import("./MoreCompaniesPopover.svelte"),
);
/** The New bot flow inside the create modal; preloaded when the modal opens. */
export const createBotFlowDoor = createDoor("CreateBotFlow",
  () => import("../chat/create-bot/CreateBotFlow.svelte"),
);
export const newMessageSheetDoor = createDoor("NewMessageSheet",
  () => import("../chat/NewMessageSheet.svelte"),
);
export const newChannelSheetDoor = createDoor("NewChannelSheet",
  () => import("../chat/NewChannelSheet.svelte"),
);
export const brainPageDoor = createDoor("BrainPage",
  () => import("../company/brain/BrainPage.svelte"),
);
export const filesConnectDoor = createDoor("FilesConnectPage",
  () => import("../company/files-connect/FilesConnectPage.svelte"),
);
export const newCompanyDoor = createDoor("NewCompanySheet",
  () => import("./new-company/NewCompanySheet.svelte"),
);
export const meetingsSidepaneDoor = createDoor("MeetingsSidepaneHost",
  () => import("../meetings/MeetingsSidepaneHost.svelte"),
);
export const meetingCanvasDoor = createDoor("MeetingCanvasHost",
  () => import("../meetings/MeetingCanvasHost.svelte"),
);
/**
 * The first-run "Bring in your context" scene (the knowledge tree). Only a
 * first run needs it: the takeover warms it when it opens, so it is not in
 * the idle preload below.
 */
export const firstRunImportDoor = createDoor("FirstRunImportStep",
  () => import("../chat/first-run/knowledge-tree/FirstRunImportStep.svelte"),
);

/**
 * Warm every door once the first frame is up, so later clicks skip the
 * skeleton. Returns a cancel for unmount, so a torn-down shell never starts
 * chunk loads.
 */
export function preloadDoorsWhenIdle(): () => void {
  const all = [
    profilePaneDoor,
    dropdownDoor,
    teamPageDoor,
    notificationsPopoverDoor,
    moreCompaniesDoor,
    newMessageSheetDoor,
    newChannelSheetDoor,
    brainPageDoor,
    filesConnectDoor,
    newCompanyDoor,
    meetingsSidepaneDoor,
    meetingCanvasDoor,
  ];
  const run = () => all.forEach((d) => d.preload());
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(run, { timeout: 3000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(run, 1500);
  return () => clearTimeout(id);
}
