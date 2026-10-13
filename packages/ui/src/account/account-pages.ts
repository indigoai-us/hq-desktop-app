/**
 * Account pages (console-rail US-035).
 *
 * Profile, Billing, and Settings paint from this cache on the first frame.
 * Refresh is the caller's job and runs after paint. Stripe is the only
 * external hand-off (billing-portal.ts). Settings section ids are the
 * SettingsPage vocabulary.
 *
 * No invoice rows live here. Invoices are read in the Stripe customer portal,
 * which hq-pro mints per company. The earlier sample invoices, and the links
 * built from their made-up ids, were never real data and are gone.
 */

import { advertisedShortcutRows } from "../shell/advertised-shortcuts.js";
import { SETTINGS_SECTIONS, type SettingsTab } from "../settings/settings-sections.js";

export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

export type AccountView = "profile" | "billing" | "settings";

export const ACCOUNT_SETTINGS_SECTIONS = SETTINGS_SECTIONS;
export type AccountSettingsSection = SettingsTab;

const CACHE_KEY = "hq.account.pages.v1";

export interface AccountCompany {
  uid: string;
  label: string;
  role: string;
  plan: string;
  since: string;
}

export interface ShortcutBinding {
  id: string;
  label: string;
  keys: string;
}

export interface AccountCache {
  displayName: string;
  handle: string;
  email: string;
  timezone: string;
  bio: string;
  botAddress: string;
  companies: AccountCompany[];
  shortcuts: ShortcutBinding[];
}

/** Derived from the shell's advertised table so the list cannot drift (QA-077). */
export const DEFAULT_SHORTCUTS: ShortcutBinding[] = advertisedShortcutRows(true);

export function fixtureAccount(name = "You", email = ""): AccountCache {
  const handle = name.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") || "you";
  return {
    displayName: name,
    handle,
    email,
    timezone: "America/New_York",
    bio: "",
    botAddress: "",
    companies: [],
    shortcuts: DEFAULT_SHORTCUTS.map((row) => ({ ...row })),
  };
}

export function readAccountCache(): AccountCache | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AccountCache & { pronouns?: unknown; invoices?: unknown };
    if (!parsed || typeof parsed.displayName !== "string") return null;
    // OWNER-R20: pronouns are gone from the profile; an older cache drops them.
    delete parsed.pronouns;
    // Older caches carried sample invoices that were never real; drop them.
    delete parsed.invoices;
    // Rows come from the advertised table, not the cache: an older cache
    // could list a chord the shell no longer binds (QA-077).
    return { ...parsed, shortcuts: DEFAULT_SHORTCUTS.map((row) => ({ ...row })) };
  } catch {
    return null;
  }
}

export function writeAccountCache(cache: AccountCache): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* quota — the page still paints the in-memory copy */
  }
}

/** First frame: last cache, otherwise the fixture filled with the signed-in identity. */
export function paintAccount(
  cache: AccountCache | null,
  identity: { name: string; email: string; companies: AccountCompany[] },
): AccountCache {
  const base = cache ?? fixtureAccount(identity.name, identity.email);
  return {
    ...base,
    displayName: identity.name || base.displayName,
    email: identity.email || base.email,
    companies: identity.companies.length > 0 ? identity.companies : base.companies,
    shortcuts: base.shortcuts.length > 0 ? base.shortcuts : DEFAULT_SHORTCUTS.map((row) => ({ ...row })),
  };
}

export const DELETE_CONFIRM_PHRASE = "delete";

export function deleteConfirmed(typed: string): boolean {
  return typed.trim().toLowerCase() === DELETE_CONFIRM_PHRASE;
}

/** Recording result. A chord already bound to another row is a conflict. */
export function recordShortcut(
  rows: readonly ShortcutBinding[],
  id: string,
  keys: string,
): { rows: ShortcutBinding[]; conflict: string | null } {
  const chord = keys.trim();
  const taken = rows.find((row) => row.id !== id && row.keys === chord);
  return {
    rows: rows.map((row) => (row.id === id ? { ...row, keys: chord || row.keys } : row)),
    conflict: taken ? `${chord} is taken by ${taken.label}.` : null,
  };
}

/** True when the shared update store has a staged package waiting for restart. */
export function updateReady(phase: string, appStatus: string): boolean {
  return phase === "ready" || (appStatus === "available" && phase !== "installing");
}

/**
 * The About line in Account Settings, from the same update store the Home
 * banner feeds (QA-051). Never claims "up to date" unless a check said so.
 */
export function aboutUpdateLine(state: {
  installPhase: string;
  appStatus: string;
  availableVersion: string | null;
  backgroundUpdatesOff: boolean;
}): string {
  const off = state.backgroundUpdatesOff
    ? " Automatic updates are off in this build; use Check for updates."
    : "";
  if (state.installPhase === "installing") return "Installing the update. HQ restarts when it finishes.";
  if (state.appStatus === "available") {
    const v = state.availableVersion ? `HQ ${state.availableVersion}` : "A new version of HQ";
    return `${v} is available.${off}`;
  }
  if (state.appStatus === "checking") return "Checking for updates…";
  if (state.appStatus === "up-to-date") return `HQ is up to date.${off}`;
  if (state.appStatus === "failed") return `Could not check for updates.${off}`;
  return state.backgroundUpdatesOff
    ? "Automatic updates are off in this build. Use Check for updates to look for a new version."
    : "HQ has not checked for updates yet.";
}

/**
 * The Automatic updates row in Settings → Updates (QA-061). Reads the same
 * build capability as the About line (`background_updates_off`, mirrored in
 * update-store), so the two never disagree. When the build has no updater the
 * toggle is disabled and the saved preference is shown as pending.
 */
export function autoUpdateRow(state: {
  autoUpdate: boolean;
  backgroundUpdatesOff: boolean;
}): { disabled: boolean; checked: boolean; description: string } {
  if (state.backgroundUpdatesOff) {
    return {
      disabled: true,
      checked: false,
      description: `Automatic updates are not available in this build. Saved preference: ${
        state.autoUpdate ? "on" : "off"
      } (will apply in a release build).`,
    };
  }
  return {
    disabled: false,
    checked: state.autoUpdate,
    description: "Install HQ Core, desktop app, and CLI updates automatically in the background — no prompts.",
  };
}
