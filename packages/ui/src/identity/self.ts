/**
 * Self-identity seam for the shared shell (platform-pure).
 *
 * The host supplies the verified signed-in principal as a prop; the shared
 * components compare roster uids against it to tag "you" and to gate
 * owner/admin-only affordances. NO platform API is called from here — per the
 * shared-core strategy (docs/architecture/shared-core.md), identity is FED IN,
 * not fetched by the display layer. Web derives it from the Cognito session;
 * desktop supplies it from its own auth source. Same components, one seam.
 */

import type { Workspace } from "../chat/workspaces.js";
import {
  roleIsAdminOrOwner,
  type WorkspaceLike,
} from "../chat/channel-admin.js";
import { workspacesFromMembershipRows } from "../company/company-display-map.js";

export interface SelfIdentity {
  /** Stable person uid — the verified session `sub`. */
  uid: string;
  email?: string | null;
  displayName?: string | null;
}

/** Footer / account-chip chrome derived from a verified session. */
export interface AccountChrome {
  label: string;
  initials: string;
}

/**
 * Settings Profile pane fields. Structurally matches `ShellSettingsProfile`
 * so hosts can inject it without the display layer fetching identity.
 */
export interface SettingsProfileChrome {
  initial: string;
  fullName: string;
  displayName: string;
  email: string;
  verified: boolean;
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

function firstWord(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("@")) return trimmed.split("@")[0] || trimmed;
  return trimmed.split(/\s+/).filter(Boolean)[0] || trimmed;
}

/** Normalize a host-provided identity; a blank uid collapses to null. */
export function toSelfIdentity(
  value:
    | {
        uid?: string | null;
        sub?: string | null;
        email?: string | null;
        displayName?: string | null;
        /** JWT `name` claim — alias for displayName. */
        name?: string | null;
      }
    | null
    | undefined,
): SelfIdentity | null {
  const uid = (value?.uid ?? value?.sub ?? "").trim();
  if (!uid) return null;
  const displayName = (value?.displayName ?? value?.name ?? "").trim();
  const email = (value?.email ?? "").trim();
  return {
    uid,
    email: email || null,
    displayName: displayName || null,
  };
}

/**
 * Visible account label + monogram for the signed-in principal.
 * Prefers display name, then email. Null when there is nothing to show
 * (unauth / empty hosts leave the account chip blank).
 */
export function accountChromeFromSelf(
  self: SelfIdentity | null | undefined,
): AccountChrome | null {
  if (!self) return null;
  const label = (self.displayName ?? "").trim() || (self.email ?? "").trim();
  if (!label) return null;
  const monogramSource =
    (self.displayName ?? "").trim() || firstWord(label) || label;
  return { label, initials: initialsFor(monogramSource) };
}

/**
 * Settings Profile pane from the signed-in principal. Null when self has
 * no name or email — callers render a "No data" profile pane.
 */
export function settingsProfileFromSelf(
  self: SelfIdentity | null | undefined,
): SettingsProfileChrome | null {
  const chrome = accountChromeFromSelf(self);
  if (!chrome || !self) return null;
  const fullName = (self.displayName ?? "").trim() || chrome.label;
  const email = (self.email ?? "").trim();
  return {
    initial: chrome.initials.slice(0, 1) || "?",
    fullName,
    displayName: firstWord(fullName),
    email,
    verified: Boolean(email),
  };
}

/**
 * True when `uid` is the signed-in principal. An absent self (unauth / empty
 * path) means nothing is ever tagged "you" — never a crash.
 */
export function isSelf(
  uid: string | null | undefined,
  self: SelfIdentity | null | undefined,
): boolean {
  const a = uid?.trim();
  const b = self?.uid?.trim();
  return Boolean(a && b && a === b);
}

/**
 * Owner/admin gate for the shared UI. Prefers an explicit host-supplied flag
 * (e.g. a defensive `identity.isAdmin()` probe result); otherwise derives it
 * from the caller's membership roles. Unknown ⇒ false, so admin-only
 * affordances stay hidden until proven.
 */
export function selfIsAdmin(
  companies: ReadonlyArray<WorkspaceLike> | null | undefined,
  explicitIsAdmin?: boolean | null,
): boolean {
  if (typeof explicitIsAdmin === "boolean") return explicitIsAdmin;
  for (const w of companies ?? []) {
    if (w.kind === "personal") continue;
    const active = (w.membershipStatus ?? "active").toLowerCase() === "active";
    if (active && roleIsAdminOrOwner(w.role)) return true;
  }
  return false;
}

export interface ResolveShellCompaniesInput {
  /** Whether the host has a verified session. */
  authed: boolean;
  /** Raw `listWorkspaces()` payload (membership rows) when authed + ok. */
  membershipRows?: unknown;
  /** Companies derived from the local-mesh cache overlay, if any. */
  overlayCompanies?: Workspace[] | null;
  /**
   * Optional leftover fallback. Product hosts pass [] / omit this — empty
   * memberships stay empty instead of painting theater companies.
   */
  fixtures?: Workspace[];
}

/**
 * Single source of company-scope precedence for the shared shell:
 *
 *   real memberships (authenticated) > local-mesh overlay > empty.
 *
 * Each tier falls through to the next when empty or unavailable. Missing
 * data stays empty — hosts must not invent a fixture roster.
 */
export function resolveShellCompanies(
  input: ResolveShellCompaniesInput,
): Workspace[] {
  if (input.authed) {
    const fromMembership = workspacesFromMembershipRows(input.membershipRows);
    if (fromMembership.length > 0) return fromMembership;
  }
  const overlay = input.overlayCompanies;
  if (overlay && overlay.length > 0) return overlay;
  return input.fixtures ?? [];
}
