/**
 * Company settings (console-rail US-030).
 *
 * Pure data. The page paints the last snapshot for this slug on the first
 * frame and refreshes hosted-agent rows in the background. Nothing here runs
 * before shell-ready. Grant levels are read or write. Purchases and payment
 * management leave the desktop for Stripe.
 */

export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

export const SETTINGS_TABS = [
  "general",
  "brand",
  "groups",
  "grants",
  "workforce",
  "billing",
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const GRANT_FILTERS = [
  "all",
  "people",
  "groups",
  "agents",
  "guests",
  "expiring",
] as const;
export type GrantFilter = (typeof GRANT_FILTERS)[number];

export const GRANT_LEVELS = ["read", "write"] as const;
export type GrantLevel = (typeof GRANT_LEVELS)[number];

export const WORKFORCE_CHECKOUT_URL = "https://checkout.stripe.com/c/pay/hq-workforce";

const STRIPE_HOSTS: Record<"upgrade", string> = {
  upgrade: "checkout.stripe.com",
};

/** Only Stripe-hosted https pages are opened in the system browser. */
export function approvedStripeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (host !== "checkout.stripe.com" && host !== "billing.stripe.com") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Checkout for plan changes. */
export function stripeDestination(action: "upgrade"): string {
  const approved = approvedStripeUrl(WORKFORCE_CHECKOUT_URL);
  if (!approved || new URL(approved).hostname !== STRIPE_HOSTS[action]) {
    throw new Error(`Stripe ${action} URL is not on the allowed host`);
  }
  return approved;
}

/** A portal mint from the platform adapter: `{ url }` on success. */
export type BillingPortalMint = () => Promise<{ ok: true; value: unknown } | { ok: false; code?: string; message?: string }>;

/**
 * Where Manage payment goes. A Stripe Billing Portal link is a short-lived
 * session hq-pro mints per request; there is no fixed portal URL (the old
 * `billing.stripe.com/p/login/hq` constant was a 404). When the mint is
 * missing, fails, or is refused (a non-owner gets 403), the console billing
 * page is the fallback: it shows the same state and its own Manage billing.
 */
export async function billingPortalUrl(mint: BillingPortalMint | null | undefined, fallback: string): Promise<string> {
  if (!mint) return fallback;
  try {
    const result = await mint();
    if (!result.ok) {
      console.warn(`billing: portal session refused (${result.code ?? "unknown"}); opening the console billing page`);
      return fallback;
    }
    const raw = result.value && typeof result.value === "object" ? (result.value as { url?: unknown }).url : null;
    const url = approvedStripeUrl(raw);
    if (url && new URL(url).hostname === "billing.stripe.com") return url;
    console.warn("billing: portal session answered without a Stripe billing url; opening the console billing page");
  } catch (error) {
    console.warn("billing: portal session request failed; opening the console billing page", error);
  }
  return fallback;
}

export interface SettingsGeneral {
  name: string;
  slug: string;
  website: string;
  defaultAccess: string;
  openOnSignIn: boolean;
  meetingBotName: string;
}

export interface SettingsBrand {
  appearance: "light" | "dark";
  logoName: string;
  accent: string;
  voice: string;
  botIntro: string;
}

export interface GroupMember {
  id: string;
  name: string;
  detail: string;
  role: string;
  added: string;
  agent: boolean;
}

export interface GroupPath {
  path: string;
  level: GrantLevel | "admin";
}

export interface CompanyGroup {
  id: string;
  name: string;
  description: string;
  members: GroupMember[];
  /** Live groups: members (people and bots) when the server sends a count; null when it does not. */
  memberCount?: number | null;
  paths: GroupPath[];
}

export type GrantKind = "person" | "group" | "agent" | "guest";

export interface PathGrant {
  id: string;
  principal: string;
  detail: string;
  kind: GrantKind;
  path: string;
  /** New grants are read or write; existing vault grants can also be admin. */
  level: GrantLevel | "admin";
  /** Server grantee id (person, group, email); absent on creator rows. */
  granteeId?: string;
  expiry: string;
  expiring: boolean;
  grantedBy: string;
}

export interface HostedAgent {
  id: string;
  name: string;
  detail: string;
  box: string;
  healthy: boolean;
  health: string;
  task: string;
}

export interface SettingsSnapshot {
  general: SettingsGeneral;
  brand: SettingsBrand;
  groups: CompanyGroup[];
  grants: PathGrant[];
  agents: HostedAgent[];
  /** Plan limits. Null until the plan is read; the card says so instead of guessing. */
  seatsLimit: number | null;
  agentsLimit: number | null;
}

const cache = new Map<string, SettingsSnapshot>();

export function readSettingsCache(slug: string): SettingsSnapshot | null {
  return cache.get(slug) ?? null;
}

export function writeSettingsCache(slug: string, value: SettingsSnapshot): void {
  if (slug) cache.set(slug, value);
}

export function emptySnapshot(name: string, slug: string): SettingsSnapshot {
  return {
    general: {
      name: name || slug,
      slug,
      website: "",
      defaultAccess: "knowledge/*            read\nprojects/*             write",
      openOnSignIn: true,
      meetingBotName: name ? `${name} notetaker` : "Meeting notetaker",
    },
    brand: {
      appearance: "dark",
      logoName: "",
      accent: "",
      voice: "",
      botIntro: "",
    },
    groups: [],
    grants: [],
    agents: [],
    seatsLimit: null,
    agentsLimit: null,
  };
}

export function grantFilterLabel(filter: GrantFilter): string {
  if (filter === "all") return "All";
  if (filter === "people") return "People";
  if (filter === "groups") return "Groups";
  if (filter === "agents") return "Bots";
  if (filter === "guests") return "Guests";
  return "Expiring";
}

export function filterGrants(grants: readonly PathGrant[], filter: GrantFilter): PathGrant[] {
  if (filter === "all") return [...grants];
  if (filter === "expiring") return grants.filter((g) => g.expiring);
  const kind: GrantKind = filter === "people" ? "person" : filter === "groups" ? "group" : filter === "agents" ? "agent" : "guest";
  return grants.filter((g) => g.kind === kind);
}

export function grantLevelLabel(level: GrantLevel | "admin"): string {
  return level === "admin" ? "admin" : level === "write" ? "write" : "read";
}

/** Delete runs only after the confirm dialog. Unconfirmed calls keep the list. */
export function deleteGroup(
  groups: readonly CompanyGroup[],
  id: string,
  confirmed: boolean,
): CompanyGroup[] {
  if (!confirmed) return [...groups];
  return groups.filter((g) => g.id !== id);
}

export function expiringGrantCount(grants: readonly PathGrant[]): number {
  return grants.filter((g) => g.expiring).length;
}
