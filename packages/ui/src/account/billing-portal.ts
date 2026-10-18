/**
 * Manage payment: open the Stripe customer portal for one company.
 *
 * The portal URL is minted per click by hq-pro (`POST /v1/billing/portal`,
 * via `CompanyApi.createBillingPortalSession`). hq-pro owner-gates the call
 * and verifies the Stripe customer belongs to the company before minting, so
 * the desktop never holds a portal URL of its own. The earlier build opened a
 * hard-coded `billing.stripe.com/p/login/hq` link that 404'd for everyone.
 *
 * Failures never reach the user as raw text. Transient ones retry with
 * backoff; what is left is a short outcome the pane turns into a quiet hint
 * (owner handoff, or "try again" on the same button).
 */

import type { AdapterResult } from "@hq/platform";
import { approvedStripeUrl } from "../company/company-settings.js";

export type BillingPortalOutcome =
  /** The portal opened in the system browser. */
  | { kind: "opened" }
  /** The caller is not an owner of this company; only an owner can open it. */
  | { kind: "owner-only" }
  /** Billing for this company needs a fix on Indigo's side (mislinked customer). */
  | { kind: "needs-support" }
  /** Still failing after retries; the same button tries again. */
  | { kind: "retry" };

export interface OpenBillingPortalInput {
  companyUid: string;
  createSession: (companyUid: string) => Promise<AdapterResult<{ url: string }>>;
  openExternal: (url: string) => void;
  /**
   * Which minted URL may be opened. Defaults to the portal host; the card
   * setup flow passes `approvedCheckoutUrl`.
   */
  approveUrl?: (raw: unknown) => string | null;
  /** Total tries for a transient failure. */
  attempts?: number;
  /** Backoff between tries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const BACKOFF_MS = [400, 1200];

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Only a checkout.stripe.com https page counts as a card-setup Checkout URL. */
export function approvedCheckoutUrl(raw: unknown): string | null {
  const url = approvedStripeUrl(raw);
  if (!url) return null;
  return new URL(url).hostname === "checkout.stripe.com" ? url : null;
}

/** Only a billing.stripe.com https page counts as a portal URL. */
export function approvedPortalUrl(raw: unknown): string | null {
  const url = approvedStripeUrl(raw);
  if (!url) return null;
  return new URL(url).hostname === "billing.stripe.com" ? url : null;
}

function terminalOutcome(code: string | undefined): BillingPortalOutcome | null {
  if (code === "FORBIDDEN" || code === "http-403") return { kind: "owner-only" };
  if (code === "BILLING_CUSTOMER_CONFLICT" || code === "http-409") return { kind: "needs-support" };
  if (code === "MISSING_COMPANY_UID" || code === "http-400") return { kind: "needs-support" };
  return null;
}

export async function openBillingPortal(input: OpenBillingPortalInput): Promise<BillingPortalOutcome> {
  const attempts = Math.max(1, input.attempts ?? 3);
  const sleep = input.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!);
    let result: AdapterResult<{ url: string }>;
    try {
      result = await input.createSession(input.companyUid);
    } catch (error) {
      console.warn("[billing] portal session request threw", error);
      continue;
    }
    if (result.ok) {
      const url = (input.approveUrl ?? approvedPortalUrl)(result.value?.url);
      if (!url) {
        // A non-Stripe or malformed URL is never opened; nothing to retry.
        console.warn("[billing] portal session returned an unapproved URL");
        return { kind: "retry" };
      }
      input.openExternal(url);
      return { kind: "opened" };
    }
    const terminal = terminalOutcome(result.code);
    console.warn("[billing] portal session failed", { code: result.code, message: result.message });
    if (terminal) return terminal;
  }
  return { kind: "retry" };
}

/** Plain-language hint under the button for each non-success outcome. */
export function billingPortalHint(outcome: BillingPortalOutcome | null, companyLabel: string): string | null {
  if (!outcome || outcome.kind === "opened") return null;
  if (outcome.kind === "owner-only") return `Only an owner of ${companyLabel} can manage payment. Ask an owner to open it.`;
  if (outcome.kind === "needs-support") return `Billing for ${companyLabel} needs a fix on our side. Tap to retry, or contact support.`;
  return "Stripe didn't open. Tap to retry.";
}
