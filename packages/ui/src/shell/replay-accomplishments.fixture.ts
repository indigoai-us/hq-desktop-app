/**
 * Shared setup for the staff "Replay accomplishments announcement" palette
 * tests. Each test file mounts DesktopApp once (the sidebar's boot pick keeps
 * module-level state), so staff and non-staff live in separate files.
 */
import { tick } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";
import type { Workspace } from "../chat/workspaces.js";

export const ACME: Workspace = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_acme",
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

export const SELF = { uid: "prs_replay", displayName: "Ada Lovelace", email: "ada@getindigo.ai" };

/** A desktop adapter whose host answers `is_indigo_user` with `staff`. */
export function replayAdapter(staff: boolean): PlatformAdapter {
  return {
    kind: "desktop",
    isAvailable: () => false,
    capabilities: {},
    identity: {
      hasFeature: async (key: string) => ok(key === "is_indigo_user" ? staff : false),
    },
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      fetchDmThread: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    files: { listDir: async () => ok([]) },
    appShell: { setActiveCompany: async () => ok(undefined) },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ", welcomeSetupOwed: false, welcomeTourShown: true }),
      markWelcomeTourShown: async () => ok(undefined),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await tick();
  }
}

/** Open the command palette with this platform's Mod+K. */
export async function openPalette(): Promise<void> {
  const mac = /Mac OS X|Macintosh/i.test(navigator.userAgent);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: mac, ctrlKey: !mac, bubbles: true }));
  await tick();
}
