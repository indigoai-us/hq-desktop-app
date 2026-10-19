/**
 * Usage pricing as hq-pro publishes it at `GET /v1/pricing` (`usage` and
 * `signup` blocks, usage-only-pricing landing 2026-10-16).
 *
 * The feed is the source of truth. `USAGE_PRICING_FALLBACK` is a copy of the
 * published contract, used only when the feed cannot be read or does not carry
 * a usable `usage` / `signup` block yet. Each block falls back on its own, so
 * a feed with `usage` and no `signup` still shows the live rates.
 *
 * Shared by the first-run usage card (apps/sync `plan-cards.ts`) and the
 * company billing pane. Display copy only: billing is hq-pro's.
 */

export const PRICING_PATH = "/v1/pricing";

export interface UsageMeterPrice {
  /** Rate-card key, e.g. `member-sync`, `vault`. */
  id: string;
  label: string;
  /** What one billed unit is: `sync`, `call`, `GB-month`, `vault-month`. */
  unit: string;
  unitUsd: number;
  waivedInTrial?: boolean;
}

export interface UsageBoxPrice {
  size: string;
  instanceType: string;
  monthlyUsd: number;
}

export interface UsagePricing {
  version: string;
  includedUsd: number;
  trial: { days: number; capUsd: number };
  meters: readonly UsageMeterPrice[];
  boxes: readonly UsageBoxPrice[];
  /** Feature keys that are never charged: `deploys`, `dms`, `background-ai`. */
  free: readonly string[];
}

export interface SignupOption {
  id: string;
  label: string;
}

export interface SignupCopy {
  options: readonly SignupOption[];
  selfHosted: { label: string; url: string };
}

export interface PricingFeed {
  usage: UsagePricing;
  signup: SignupCopy;
  /** True when both blocks came from the server; false when any fell back. */
  live: boolean;
}

/** The locked card (README "Feed contract"), used when the feed lacks it. */
export const USAGE_PRICING_FALLBACK: UsagePricing = {
  version: "2026-10-16",
  includedUsd: 10,
  trial: { days: 30, capUsd: 500 },
  meters: [
    { id: "member-sync", label: "Sync", unit: "sync", unitUsd: 0.1 },
    { id: "integration-call", label: "Gateway call", unit: "call", unitUsd: 0.05 },
    { id: "hq-mcp-call", label: "HQ MCP call", unit: "call", unitUsd: 0.05 },
    { id: "agent-run", label: "Agent run", unit: "run", unitUsd: 0.05 },
    { id: "storage", label: "Storage", unit: "GB-month", unitUsd: 2 },
    { id: "secret", label: "Secret", unit: "secret-month", unitUsd: 0.5 },
    { id: "vault", label: "Vault", unit: "vault-month", unitUsd: 5, waivedInTrial: true },
  ],
  boxes: [
    { size: "small", instanceType: "t3.small", monthlyUsd: 100 },
    { size: "medium", instanceType: "t3.medium", monthlyUsd: 200 },
    { size: "large", instanceType: "t3.large", monthlyUsd: 400 },
    { size: "xlarge", instanceType: "t3.xlarge", monthlyUsd: 800 },
  ],
  free: ["deploys", "dms", "background-ai"],
};

export const SELF_HOSTED_URL = "https://docs.hq.computer/hq/guide/use-hq-for-free/";

export const SIGNUP_FALLBACK: SignupCopy = {
  options: [
    { id: "free", label: "Sign up free" },
    { id: "enterprise", label: "Book a setup call" },
  ],
  selfHosted: { label: "Use HQ free, self-hosted or on-prem", url: SELF_HOSTED_URL },
};

export const PRICING_FALLBACK: PricingFeed = {
  usage: USAGE_PRICING_FALLBACK,
  signup: SIGNUP_FALLBACK,
  live: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function meterFrom(value: unknown): UsageMeterPrice | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const label = text(value.label);
  const unit = text(value.unit);
  const unitUsd = nonNegative(value.unitUsd);
  if (!id || !label || !unit || unitUsd === null) return null;
  return { id, label, unit, unitUsd, ...(value.waivedInTrial === true ? { waivedInTrial: true } : {}) };
}

function boxFrom(value: unknown): UsageBoxPrice | null {
  if (!isRecord(value)) return null;
  const size = text(value.size);
  const instanceType = text(value.instanceType);
  const monthlyUsd = nonNegative(value.monthlyUsd);
  if (!size || !instanceType || monthlyUsd === null) return null;
  return { size, instanceType, monthlyUsd };
}

/** Every entry must parse; one bad entry rejects the list (no half a card). */
function allOf<T>(value: unknown, parse: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: T[] = [];
  for (const entry of value) {
    const parsed = parse(entry);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

/** The `usage` block of a `GET /v1/pricing` body, or null when absent or malformed. */
export function usagePricingFromFeed(body: unknown): UsagePricing | null {
  if (!isRecord(body) || !isRecord(body.usage)) return null;
  const usage = body.usage;
  const includedUsd = nonNegative(usage.includedUsd);
  const trial = isRecord(usage.trial) ? usage.trial : null;
  const days = trial ? positiveInt(trial.days) : null;
  const capUsd = trial ? nonNegative(trial.capUsd) : null;
  const meters = allOf(usage.meters, meterFrom);
  const boxes = allOf(usage.boxes, boxFrom);
  if (includedUsd === null || days === null || capUsd === null || !meters || !boxes) return null;
  const free = Array.isArray(usage.free) ? usage.free.filter((key): key is string => Boolean(text(key))) : [];
  return {
    version: text(usage.version) ?? "",
    includedUsd,
    trial: { days, capUsd },
    meters,
    boxes,
    free,
  };
}

/** The `signup` block of a `GET /v1/pricing` body, or null when absent or malformed. */
export function signupFromFeed(body: unknown): SignupCopy | null {
  if (!isRecord(body) || !isRecord(body.signup)) return null;
  const signup = body.signup;
  const options = allOf(signup.options, (entry): SignupOption | null => {
    if (!isRecord(entry)) return null;
    const id = text(entry.id);
    const label = text(entry.label);
    return id && label ? { id, label } : null;
  });
  const selfHosted = isRecord(signup.selfHosted) ? signup.selfHosted : null;
  const selfLabel = selfHosted ? text(selfHosted.label) : null;
  const selfUrl = selfHosted ? approvedHttpsUrl(selfHosted.url) : null;
  if (!options || !options.some((option) => option.id === "free") || !selfLabel || !selfUrl) return null;
  return { options, selfHosted: { label: selfLabel, url: selfUrl } };
}

/** Both blocks, each falling back to the contract copy on its own. */
export function pricingFromFeed(body: unknown): PricingFeed {
  const usage = usagePricingFromFeed(body);
  const signup = signupFromFeed(body);
  return {
    usage: usage ?? USAGE_PRICING_FALLBACK,
    signup: signup ?? SIGNUP_FALLBACK,
    live: Boolean(usage && signup),
  };
}

/** A credential-free https URL, normalized; null otherwise. */
export function approvedHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Dollars the way the card prints them: cents under $5 keep two decimals
 * ($0.10, $2.00), whole amounts from $5 up drop them ($5, $100, $800).
 */
export function formatCardUsd(amount: number): string {
  if (Number.isInteger(amount) && amount >= 5) return `$${amount.toLocaleString("en-US")}`;
  return `$${amount.toFixed(2)}`;
}

/** Cents as dollars, always two decimals ($3.40, $10.00). */
export function formatCardCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** "$0.10 per sync". */
export function meterRate(meter: UsageMeterPrice): string {
  return `${formatCardUsd(meter.unitUsd)} per ${meter.unit}`;
}

export function vaultMeter(usage: UsagePricing): UsageMeterPrice | null {
  return usage.meters.find((meter) => meter.id === "vault") ?? null;
}

/** "$100 to $800 a month", from the cheapest and dearest box. */
export function boxRange(boxes: readonly UsageBoxPrice[]): string {
  if (boxes.length === 0) return "";
  const prices = boxes.map((box) => box.monthlyUsd);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high ? `${formatCardUsd(low)} a month` : `${formatCardUsd(low)} to ${formatCardUsd(high)} a month`;
}

/** "small $100 · medium $200 · large $400 · xlarge $800". */
export function boxLadder(boxes: readonly UsageBoxPrice[]): string {
  return boxes.map((box) => `${box.size} ${formatCardUsd(box.monthlyUsd)}`).join(" · ");
}

const FREE_LABELS: Record<string, string> = {
  deploys: "deploys",
  dms: "DMs",
  "background-ai": "background AI",
};

/** "Deploys, DMs and background AI". */
export function freeList(keys: readonly string[]): string {
  const words = keys.map((key) => FREE_LABELS[key] ?? key.replace(/-/g, " "));
  if (words.length === 0) return "";
  const joined = words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}
