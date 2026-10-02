/**
 * Doors into surfaces that are not needed to paint the first frame of Home.
 * Each door is the only import of its heavy body. The shell imports this file
 * and LazyDoor.svelte; the bodies load as separate chunks on first open.
 * The module promise is memoized, and `peek()` returns the loaded module so a
 * second open paints the body in the same frame instead of the skeleton.
 * Same pattern as atlas-lazy.ts and telemetry-lazy.ts.
 */
import type { Component } from "svelte";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = Component<any>;

export interface Door {
  load(): Promise<AnyComponent>;
  peek(): AnyComponent | null;
  preload(): void;
}

function door(importer: () => Promise<{ default: AnyComponent }>): Door {
  let pending: Promise<AnyComponent> | null = null;
  let loaded: AnyComponent | null = null;
  const load = () => {
    pending ??= importer().then(
      (mod) => (loaded = mod.default),
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
      load().catch((err) => console.warn("[lazy-door] preload failed", err));
    },
  };
}

export const profilePaneDoor = door(
  () => import("./profile-panes/ProfilePaneHost.svelte"),
);
export const notificationsPopoverDoor = door(
  () => import("../inbox/NotificationsPopover.svelte"),
);
export const moreCompaniesDoor = door(
  () => import("./MoreCompaniesPopover.svelte"),
);
export const newMessageSheetDoor = door(
  () => import("../chat/NewMessageSheet.svelte"),
);
export const newChannelSheetDoor = door(
  () => import("../chat/NewChannelSheet.svelte"),
);
export const brainPageDoor = door(
  () => import("../company/brain/BrainPage.svelte"),
);
export const filesConnectDoor = door(
  () => import("../company/files-connect/FilesConnectPage.svelte"),
);
export const newCompanyDoor = door(
  () => import("./new-company/NewCompanySheet.svelte"),
);
export const meetingsSidepaneDoor = door(
  () => import("../meetings/MeetingsSidepaneHost.svelte"),
);
export const meetingCanvasDoor = door(
  () => import("../meetings/MeetingCanvasHost.svelte"),
);

/** Warm every door once the first frame is up, so later clicks skip the skeleton. */
export function preloadDoorsWhenIdle(): void {
  const all = [
    profilePaneDoor,
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
    requestIdleCallback(run, { timeout: 3000 });
  } else {
    setTimeout(run, 1500);
  }
}
