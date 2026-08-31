/**
 * V2 Settings destination — pane models (Companies + host sections).
 *
 * Display-only helpers. Identity and memberships are FED IN from the host
 * (JWT + GET /membership/me). No platform fetch lives here.
 */

import {
  dedupeWorkspaces,
  pendingInviteWorkspaces,
  type Workspace,
} from "../chat/workspaces.js";
import type { ColorTheme } from "./appearance-seam.js";
import type { SettingsUiSize } from "./settings-prefs.js";

export const THEME_STORAGE_KEY = "hq-work-color-theme";

export const APPEARANCE_THEMES: ReadonlyArray<{
  id: ColorTheme;
  label: string;
  help: string;
}> = [
  { id: "system", label: "System", help: "Follow the OS appearance" },
  { id: "light", label: "Light", help: "Always light" },
  { id: "dark", label: "Dark", help: "Always dark" },
];

/**
 * Theme choices to offer for a given shell. The desktop shell pins a dark
 * window (desktop main.ts forces `data-force-theme="dark"`) and its native
 * chrome + vibrancy are tuned for dark; Light/System would flip the shared
 * tokens light while the window stays dark, leaving the dark ground behind the
 * translucent panels as an unreadable grey veil. So desktop is dark-only. Web
 * keeps the full System/Light/Dark set (its ground follows the forced theme).
 */
export function appearanceThemeOptions(
  isDesktopShell: boolean,
): ReadonlyArray<{ id: ColorTheme; label: string }> {
  if (isDesktopShell) return [{ id: "dark", label: "Dark" }];
  return APPEARANCE_THEMES.map(({ id, label }) => ({ id, label }));
}

export const APPEARANCE_SIZES: ReadonlyArray<{
  id: SettingsUiSize;
  label: string;
}> = [
  { id: "compact", label: "Compact" },
  { id: "default", label: "Default" },
  { id: "large", label: "Large" },
];

export const MEETING_PLATFORM_ORDER = ["Zoom", "Google Meet", "Teams"] as const;

export interface SettingsCompanyRow {
  id: string;
  slug: string;
  name: string;
  initials: string;
  role: string;
  status: string;
  statusKey: string;
  pending: boolean;
  personal: boolean;
}

export interface SettingsCompanyLists {
  active: SettingsCompanyRow[];
  pending: SettingsCompanyRow[];
  personal: SettingsCompanyRow | null;
}

function initialsFor(title: string): string {
  const parts = title.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (
      `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase() || "?"
    );
  }
  return title.trim().slice(0, 2).toUpperCase() || "?";
}

export function roleLabel(role: string | null | undefined): string {
  const value = (role ?? "").trim().toLowerCase();
  if (value === "owner") return "Owner";
  if (value === "admin") return "Admin";
  if (value === "member") return "Member";
  if (value === "guest") return "Guest";
  if (value) return value[0]!.toUpperCase() + value.slice(1);
  return "Member";
}

export function membershipStatusLabel(
  status: string | null | undefined,
): string {
  const value = (status ?? "active").trim().toLowerCase();
  if (value === "pending" || value === "invited") return "Invite";
  if (value === "active" || value === "accepted") return "Active";
  if (value === "revoked" || value === "removed") return "Removed";
  if (value) return value[0]!.toUpperCase() + value.slice(1);
  return "Active";
}

function toRow(workspace: Workspace): SettingsCompanyRow {
  const pending =
    (workspace.membershipStatus ?? "").toLowerCase() === "pending";
  return {
    id: workspace.cloudUid ?? workspace.slug,
    slug: workspace.slug,
    name: workspace.displayName,
    initials: initialsFor(workspace.displayName),
    role: roleLabel(workspace.role),
    status: membershipStatusLabel(workspace.membershipStatus),
    statusKey: (workspace.membershipStatus ?? "active").toLowerCase(),
    pending,
    personal: workspace.kind === "personal",
  };
}

/** Prototype always shows a Personal vault row under companies. */
export function personalSettingsRow(label?: string | null): SettingsCompanyRow {
  const name = (label ?? "").trim() || "Personal";
  return {
    id: "personal",
    slug: "personal",
    name: "Personal",
    initials: initialsFor(name === "Personal" ? "Personal" : name) || "PE",
    role: "Owner",
    status: "Local",
    statusKey: "personal",
    pending: false,
    personal: true,
  };
}

/** Split the signed-in roster into active companies, pending invites, personal. */
export function settingsCompanyLists(
  workspaces: ReadonlyArray<Workspace> | null | undefined,
  personalLabel?: string | null,
): SettingsCompanyLists {
  const all = dedupeWorkspaces([...(workspaces ?? [])]);
  const personalWs = all.find((w) => w.kind === "personal") ?? null;
  const pendingWs = pendingInviteWorkspaces(all);
  const pendingIds = new Set(pendingWs.map((w) => w.cloudUid ?? w.slug));
  const active = all
    .filter(
      (w) => w.kind === "company" && !pendingIds.has(w.cloudUid ?? w.slug),
    )
    .map(toRow);
  return {
    active,
    pending: pendingWs.map(toRow),
    personal: personalWs
      ? toRow(personalWs)
      : personalSettingsRow(personalLabel),
  };
}

export function normalizeColorTheme(value: unknown): ColorTheme {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "dark";
}

export function readStoredTheme(
  storage:
    Pick<Storage, "getItem"> | null | undefined = globalThis.localStorage,
): ColorTheme {
  try {
    return normalizeColorTheme(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

/** Apply theme to <html>. `system` removes the force attribute. */
export function applyColorTheme(
  theme: ColorTheme,
  root: HTMLElement | null = globalThis.document?.documentElement ?? null,
  storage:
    Pick<Storage, "setItem"> | null | undefined = globalThis.localStorage,
): ColorTheme {
  const next = normalizeColorTheme(theme);
  if (root) {
    if (next === "system") root.removeAttribute("data-force-theme");
    else root.setAttribute("data-force-theme", next);
  }
  try {
    storage?.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* private mode */
  }
  return next;
}

/** Density attribute for the V2 shell (Daybook Appearance → Interface size). */
export function applyUiSize(
  size: SettingsUiSize,
  root: HTMLElement | null = globalThis.document?.documentElement ?? null,
): SettingsUiSize {
  const next: SettingsUiSize =
    size === "compact" || size === "large" || size === "default"
      ? size
      : "default";
  if (root) {
    if (next === "default") root.removeAttribute("data-ui-size");
    else root.setAttribute("data-ui-size", next);
  }
  return next;
}

export function applyWindowOpacity(
  opacity: number,
  root: HTMLElement | null = globalThis.document?.documentElement ?? null,
): number {
  const next = Math.min(100, Math.max(50, Math.round(opacity)));
  root?.style.setProperty("--hq-window-opacity", `${next}%`);
  return next;
}

/** Deterministic avatar wash — same idea as the preview-v2 company chips. */
const AVATAR_WASH: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: "#3B2F8A", fg: "#D9D4FF" },
  { bg: "#7A3F1A", fg: "#FFD7B8" },
  { bg: "#1E3A6E", fg: "#C5DBFF" },
  { bg: "#6B1F4A", fg: "#FFD0E6" },
  { bg: "#14504A", fg: "#B8F3EA" },
  { bg: "#1F5A32", fg: "#C8F5D2" },
];

export function companyAvatarWash(key: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % AVATAR_WASH.length;
  return AVATAR_WASH[idx]!;
}

export function calendarAccountLabel(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "Calendar";
  const rec = raw as Record<string, unknown>;
  for (const key of ["email", "displayName", "name", "account"] as const) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Calendar";
}

/** Hold the profile skeleton this long so a fast load never flashes a placeholder. */
export const PROFILE_SKELETON_DELAY_MS = 150;

export type ProfilePanePhase = "ready" | "loading" | "error" | "empty";

/** Structural match for ShellSettingsProfile without importing the Svelte component. */
export interface ProfilePaneIdentity {
  initial: string;
  fullName: string;
  displayName: string;
  email: string;
  verified: boolean;
}

export function profilePanePhase(args: {
  hasProfile: boolean;
  fetching: boolean;
  error: string | null;
}): ProfilePanePhase {
  if (args.hasProfile) return "ready";
  if (args.fetching) return "loading";
  if (args.error) return "error";
  return "empty";
}

export function profileFromMemberProfile(args: {
  displayName?: string | null;
  email?: string | null;
}): ProfilePaneIdentity | null {
  const fullName = (args.displayName ?? "").trim();
  if (!fullName) return null;
  const email = (args.email ?? "").trim();
  const firstWord = fullName.split(/\s+/).filter(Boolean)[0] || fullName;
  return {
    initial: fullName[0]!.toUpperCase(),
    fullName,
    displayName: firstWord,
    email,
    verified: Boolean(email),
  };
}
