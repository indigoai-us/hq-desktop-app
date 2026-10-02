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
export const STRIPE_PORTAL_URL = "https://billing.stripe.com/p/login/hq";

const STRIPE_HOSTS: Record<"upgrade" | "portal", string> = {
  upgrade: "checkout.stripe.com",
  portal: "billing.stripe.com",
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

/** Checkout for plan changes. Portal for managing payment. */
export function stripeDestination(action: "upgrade" | "portal"): string {
  const url = action === "upgrade" ? WORKFORCE_CHECKOUT_URL : STRIPE_PORTAL_URL;
  const approved = approvedStripeUrl(url);
  if (!approved || new URL(approved).hostname !== STRIPE_HOSTS[action]) {
    throw new Error(`Stripe ${action} URL is not on the allowed host`);
  }
  return approved;
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
  level: GrantLevel;
}

export interface CompanyGroup {
  id: string;
  name: string;
  description: string;
  members: GroupMember[];
  paths: GroupPath[];
}

export type GrantKind = "person" | "group" | "agent" | "guest";

export interface PathGrant {
  id: string;
  principal: string;
  detail: string;
  kind: GrantKind;
  path: string;
  level: GrantLevel;
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
  seatsUsed: number;
  seatsLimit: number;
  agentsLimit: number;
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
    seatsUsed: 0,
    seatsLimit: 10,
    agentsLimit: 5,
  };
}

export function grantFilterLabel(filter: GrantFilter): string {
  if (filter === "all") return "All";
  if (filter === "people") return "People";
  if (filter === "groups") return "Groups";
  if (filter === "agents") return "Agents";
  if (filter === "guests") return "Guests";
  return "Expiring";
}

export function filterGrants(grants: readonly PathGrant[], filter: GrantFilter): PathGrant[] {
  if (filter === "all") return [...grants];
  if (filter === "expiring") return grants.filter((g) => g.expiring);
  const kind: GrantKind = filter === "people" ? "person" : filter === "groups" ? "group" : filter === "agents" ? "agent" : "guest";
  return grants.filter((g) => g.kind === kind);
}

export function grantLevelLabel(level: GrantLevel): string {
  return level === "write" ? "write" : "read";
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
