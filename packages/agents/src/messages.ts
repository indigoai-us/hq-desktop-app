/**
 * Plain-language copy for a refused cloud-bot create, with the one thing that
 * fixes it. Shared by every surface so the desktop, the web build and later
 * the CLI say the same thing.
 */

import type { AgentsError, CreateAvailability } from "./client.js";

/** What the person can do about a refusal. */
export type CreateErrorFix =
  | { kind: "checkout"; url: string; label: string }
  | { kind: "ask_admin"; adminName?: string }
  | { kind: "reload_quote" }
  | { kind: "edit_handle" }
  | { kind: "pick_brain" }
  | { kind: "sign_in" }
  | { kind: "retry" };

export interface CreateErrorCopy {
  message: string;
  fix: CreateErrorFix | null;
}

export interface CreateErrorContext {
  /** The company the bot was being added to ("Indigo"). */
  companyLabel?: string;
  /** The @handle that was asked for. */
  handle?: string;
  /** Who can unlock it, when the caller knows. */
  adminName?: string;
}

/** `amountMinor` + `currency` → "$500", or null when either is missing. */
export function formatPlanPrice(amountMinor?: number, currency?: string): string | null {
  if (typeof amountMinor !== "number" || !Number.isFinite(amountMinor) || !currency) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
    }).format(amountMinor / 100);
  } catch {
    return null;
  }
}

export function createErrorCopy(
  error: AgentsError,
  context: CreateErrorContext = {},
): CreateErrorCopy {
  const company = context.companyLabel?.trim() || "this company";
  switch (error.kind) {
    case "plan_limit": {
      const price = formatPlanPrice(error.amountMinor, error.currency);
      const message = price
        ? `Cloud bots need the Agents plan (${price} a month). ${company} isn't on it yet.`
        : `Cloud bots need the Agents plan. ${company} isn't on it yet.`;
      if (error.checkoutUrl) {
        return { message, fix: { kind: "checkout", url: error.checkoutUrl, label: "Upgrade plan" } };
      }
      // No checkout link means this person cannot buy it themselves.
      return {
        message: `${message} ${context.adminName ? `Ask ${context.adminName} to upgrade.` : "Ask a company owner to upgrade."}`,
        fix: { kind: "ask_admin", ...(context.adminName ? { adminName: context.adminName } : {}) },
      };
    }
    case "forbidden":
      return {
        message: `Only admins of ${company} can add cloud bots. ${
          context.adminName ? `Ask ${context.adminName}` : "Ask a company admin"
        } to add it, or to give you access.`,
        fix: { kind: "ask_admin", ...(context.adminName ? { adminName: context.adminName } : {}) },
      };
    case "brain_not_enabled":
      return {
        message: "Claude isn't available for cloud bots in this company yet. Pick Codex or Grok.",
        fix: { kind: "pick_brain" },
      };
    case "quote_stale":
      return {
        message: "The price for this size changed since you opened this. Check the new price, then create again.",
        fix: { kind: "reload_quote" },
      };
    case "handle_taken":
      return {
        message: context.handle
          ? `@${context.handle} is already taken in ${company}. Pick another handle.`
          : `That handle is already taken in ${company}. Pick another handle.`,
        fix: { kind: "edit_handle" },
      };
    case "not_found":
      return {
        message: `You're not a member of ${company}, so you can't add a bot there.`,
        fix: null,
      };
    case "unauthorized":
      return { message: "Your HQ sign-in has expired. Sign in again, then create the bot.", fix: { kind: "sign_in" } };
    case "invalid":
      return {
        message: error.serverMessage
          ? `HQ couldn't create the bot: ${error.serverMessage}`
          : "HQ couldn't create the bot with these details.",
        fix: null,
      };
    case "network":
      return { message: "Couldn't reach HQ. Check your connection and try again.", fix: { kind: "retry" } };
    case "server":
      return { message: "HQ couldn't create the bot just now. Try again in a moment.", fix: { kind: "retry" } };
  }
}

/** Why the Cloud option is off, and what turns it on. Null when it is available. */
export interface CloudUnavailableCopy {
  reason: string;
  fix: CreateErrorFix | null;
}

/**
 * Copy for a Cloud option that cannot be used. `companies` is how many
 * companies the person could add a bot to; zero means the reason is "no
 * company", whatever the probe said.
 */
export function cloudUnavailableCopy(
  availability: CreateAvailability | null,
  context: { companyLabel?: string; companies: number },
): CloudUnavailableCopy | null {
  if (context.companies === 0) {
    return {
      reason: "Cloud bots belong to a company. Create or join a company first.",
      fix: null,
    };
  }
  const company = context.companyLabel?.trim() || "this company";
  if (!availability) return null;
  switch (availability.state) {
    case "available":
    case "unknown":
      return null;
    case "role": {
      const admin = availability.admins[0];
      return {
        reason: `Only admins of ${company} can add cloud bots. ${admin ? `Ask ${admin}` : "Ask a company admin"}.`,
        fix: { kind: "ask_admin", ...(admin ? { adminName: admin } : {}) },
      };
    }
    case "plan": {
      const copy = createErrorCopy(
        {
          kind: "plan_limit",
          status: 403,
          ...(availability.checkoutUrl ? { checkoutUrl: availability.checkoutUrl } : {}),
          ...(availability.amountMinor !== undefined ? { amountMinor: availability.amountMinor } : {}),
          ...(availability.currency ? { currency: availability.currency } : {}),
        },
        { companyLabel: company },
      );
      return { reason: copy.message, fix: copy.fix };
    }
    case "not_member":
      return { reason: `You're not a member of ${company}.`, fix: null };
  }
}
