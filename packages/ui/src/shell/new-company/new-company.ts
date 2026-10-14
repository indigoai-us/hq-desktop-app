/**
 * New company (console-rail US-037).
 *
 * Step 1 collects name, slug, and plan. HQ Workforce leaves the desktop for
 * Stripe checkout and does nothing else on that click. Free creates the
 * company in-app and opens step 2. Finish pins the tile on this device,
 * sends invites, and optionally names a first project, then the host opens
 * Atlas for the new company.
 *
 * Paints from the values already on screen. Nothing here runs before
 * shell-ready.
 */

import { stripeDestination } from "../../company/company-settings.js";
import { pinCompany } from "../more-companies.js";
import { serverCompanySlug } from "../../chat/first-run/team-step.js";

export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

export const NEW_COMPANY_PLANS = [
  {
    id: "free",
    title: "Free",
    detail: "1 owner, 2 bots, local vault. Upgrade any time.",
  },
  {
    id: "workforce",
    title: "HQ Workforce",
    detail: "Hosted agents, cloud vault, team sync. Per seat, billed monthly.",
  },
] as const;

export type NewCompanyPlan = (typeof NEW_COMPANY_PLANS)[number]["id"];

export const PROJECT_TEMPLATES = ["blank", "brainstorm", "prd"] as const;
export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[number];

export interface NewCompanyDraft {
  name: string;
  slug: string;
  plan: NewCompanyPlan;
  invites: readonly string[];
}

export interface NewCompanyFinish {
  draft: NewCompanyDraft;
  companyUid: string | null;
  pin: boolean;
  pinnedIds: string[];
  projectSlug: string | null;
  template: ProjectTemplate;
}

/**
 * The company's vault slug, sent to the server on create. Same rule as the
 * first-run team step (a letter first, at most 30 long, the server's
 * COMPANY_SLUG_RE). Empty when the name has no letter to start one.
 */
export function companySlugFromName(name: string): string {
  return serverCompanySlug(name);
}

/** Lowercase slug for a project folder. Empty when the name has no letters or digits. */
function folderSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function companyInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

/** Comma- or space-separated addresses. Duplicates collapse. */
export function parseInviteEmails(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const email = part.trim().toLowerCase();
    if (!email.includes("@") || !email.includes(".") || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/**
 * What the primary button on step 1 is allowed to do.
 * Workforce opens Stripe checkout and does not create the company on that click.
 */
export function stepOneEffects(plan: NewCompanyPlan): {
  checkoutUrl: string | null;
  createNow: boolean;
} {
  if (plan === "workforce") {
    return { checkoutUrl: stripeDestination("upgrade"), createNow: false };
  }
  return { checkoutUrl: null, createNow: true };
}

export function projectSlugFromName(name: string): string | null {
  const slug = folderSlug(name);
  return slug || null;
}

/** Pin when the toggle is on and the rail has room. A full rail stays as it is. */
export function pinnedIdsAfterFinish(
  pinnedIds: readonly string[],
  companyUid: string | null,
  pin: boolean,
): string[] {
  const current = [...pinnedIds];
  if (!pin || !companyUid) return current;
  const result = pinCompany(current, companyUid);
  return result.status === "pinned" ? result.ids : current;
}

/** Six rail slots. The new tile is the next circle when pin is on. */
export function railPreview(
  existingInitials: readonly string[],
  nextInitials: string,
  pin: boolean,
): { initials: string; kind: "existing" | "new" | "empty" }[] {
  const slots: { initials: string; kind: "existing" | "new" | "empty" }[] = existingInitials
    .slice(0, 6)
    .map((initials) => ({ initials, kind: "existing" as const }));
  if (pin && slots.length < 6) slots.push({ initials: nextInitials, kind: "new" });
  while (slots.length < 6) slots.push({ initials: "", kind: "empty" });
  return slots.slice(0, 6);
}
