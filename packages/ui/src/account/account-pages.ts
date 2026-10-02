/**
 * Account pages (console-rail US-035).
 *
 * Profile, Billing, and Settings paint from this cache on the first frame.
 * Refresh is the caller's job and runs after paint. Stripe is the only
 * external hand-off. Settings section ids are the SettingsPage vocabulary.
 */

import { approvedStripeUrl, stripeDestination } from "../company/company-settings.js";
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

export interface AccountInvoice {
  id: string;
  date: string;
  summary: string;
  amount: string;
  status: "Paid";
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
  pronouns: string;
  bio: string;
  botAddress: string;
  companies: AccountCompany[];
  invoices: AccountInvoice[];
  shortcuts: ShortcutBinding[];
}

export const FIXTURE_INVOICES: AccountInvoice[] = [
  { id: "IN-2026-0009", date: "Sep 1, 2026", summary: "HQ Workforce · 2 hosted agents · Outpost · 11.2 meeting hours", amount: "$791.20", status: "Paid" },
  { id: "IN-2026-0008", date: "Aug 1, 2026", summary: "HQ Workforce · 2 hosted agents · Outpost · 9.6 meeting hours", amount: "$789.60", status: "Paid" },
  { id: "IN-2026-0007", date: "Jul 1, 2026", summary: "HQ Workforce · 1 hosted agent · Outpost", amount: "$680.00", status: "Paid" },
];

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { id: "palette", label: "Command palette", keys: "⌘K" },
  { id: "home", label: "Home", keys: "⌘1" },
  { id: "atlas", label: "Open Atlas", keys: "⌘⇧A" },
  { id: "new-message", label: "New message", keys: "⌘N" },
  { id: "settings", label: "Settings", keys: "⌘," },
  { id: "select-all", label: "Select all in the composer", keys: "⌘A" },
];

export function fixtureAccount(name = "You", email = ""): AccountCache {
  const handle = name.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") || "you";
  return {
    displayName: name,
    handle,
    email,
    timezone: "America/New_York",
    pronouns: "",
    bio: "",
    botAddress: "",
    companies: [],
    invoices: FIXTURE_INVOICES,
    shortcuts: DEFAULT_SHORTCUTS.map((row) => ({ ...row })),
  };
}

export function readAccountCache(): AccountCache | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AccountCache;
    if (!parsed || typeof parsed.displayName !== "string" || !Array.isArray(parsed.invoices)) return null;
    return parsed;
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
    invoices: base.invoices.length > 0 ? base.invoices : FIXTURE_INVOICES,
    shortcuts: base.shortcuts.length > 0 ? base.shortcuts : DEFAULT_SHORTCUTS.map((row) => ({ ...row })),
  };
}

function stripeInvoice(id: string, pdf: boolean): string {
  const path = pdf ? `/invoices/${encodeURIComponent(id)}.pdf` : `/invoices/${encodeURIComponent(id)}`;
  const url = approvedStripeUrl(`https://billing.stripe.com${path}`);
  if (!url) throw new Error("Invoice URL is not on the Stripe host");
  return url;
}

export function invoicePdfUrl(id: string): string {
  return stripeInvoice(id, true);
}

export function invoiceStripeUrl(id: string): string {
  return stripeInvoice(id, false);
}

/** Manage payment opens the Stripe customer portal. */
export function managePaymentUrl(): string {
  return stripeDestination("portal");
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
