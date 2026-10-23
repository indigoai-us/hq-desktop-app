/**
 * Custom domain for one deployment (hq-deploy-custom-domain-tiers US-007).
 *
 * Routes (hq-deploy `src/api/routes/lifecycle-mutations.ts`):
 *   GET    /api/apps/:id/domains                  `{ appId, domains: [{ domain, validationState }] }`
 *   POST   /api/apps/:id/domains                  `{ domain }` -> 201 `{ domain, dnsInstructions, serving }`
 *   POST   /api/apps/:id/domains/:domain/refresh  `{ certStatus, validationState, serving, dnsInstructions? }`
 *   DELETE /api/apps/:id/domains/:domain          owner/admin only -> `{ ok, remaining, warning? }`
 *
 * Refusals are `{ error: { message, status, code, billingUrl? } }`. Billing
 * codes come from the hq-pro gate (`src/api/billing/custom-domains.ts`):
 * `PAYMENT_METHOD_REQUIRED` (402, with a Stripe `billingUrl`),
 * `BILLING_ADMIN_REQUIRED`, `PAID_PLAN_REQUIRED`, `DOMAIN_NOT_ENTITLED` (403),
 * `BILLING_UNAVAILABLE` (503).
 *
 * The price is read from `GET /v1/pricing` `usage.domains`; the fallback is a
 * copy of the published contract, used only when the feed cannot be read.
 */
import type { AdapterPromise, Json } from "@hq/platform";

export type DomainMethod = "GET" | "POST" | "DELETE";

/** Host call: answers `{ status, body }` for every HTTP reply. */
export type DeployDomainRequest = (
  scope: string,
  method: DomainMethod,
  path: string,
  body?: Json,
) => AdapterPromise<Json>;

export type DomainState = "pending" | "validated" | "failed";

export interface DomainRecord {
  domain: string;
  state: DomainState;
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  /** `ownership` proves the domain for the certificate; `routing` sends visitors to the app. */
  purpose: "ownership" | "routing";
}

export interface DomainPrices {
  standardUsd: number;
  premiumUsd: number;
}

export const DOMAIN_PRICE_FALLBACK: DomainPrices = { standardUsd: 20, premiumUsd: 500 };

/** Hostnames HQ serves itself; never a customer domain. */
export const RESERVED_DOMAINS = ["indigo-hq.com", "hq.work", "hq.computer", "getindigo.ai", "localhost"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `usage.domains` of a `GET /v1/pricing` body, or null when absent or malformed. */
export function domainPricesFromFeed(body: unknown): DomainPrices | null {
  if (!isRecord(body) || !isRecord(body.usage) || !isRecord(body.usage.domains)) return null;
  const { standardUsd, premiumUsd } = body.usage.domains;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  return ok(standardUsd) && ok(premiumUsd) ? { standardUsd, premiumUsd } : null;
}

export type CompanyDomainPriceBasis = "enterprise" | "comped" | "paid" | "not_enabled";

/**
 * What one company pays per custom domain (hq-pro #5202). `paid` with 0 is a
 * billing override (for example a comped test company on the paid path).
 * `cardOnFile` is set for owners and admins on `paid` only.
 */
export interface CompanyDomainPrice {
  basis: CompanyDomainPriceBasis;
  monthlyPriceUsd: number | null;
  cardOnFile?: boolean;
}

const PRICE_BASES: ReadonlySet<string> = new Set(["enterprise", "comped", "paid", "not_enabled"]);

function usableUsd(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The company price route's body, or null when it is missing or malformed. A
 * `paid` answer without a usable amount is null, so the caller shows the
 * catalog price; nothing here turns a bad read into "included".
 */
export function companyDomainPriceFrom(body: unknown): CompanyDomainPrice | null {
  if (!isRecord(body) || typeof body.basis !== "string" || !PRICE_BASES.has(body.basis)) return null;
  const basis = body.basis as CompanyDomainPriceBasis;
  const amount = usableUsd(body.monthlyPriceUsd);
  if (basis === "paid" && amount === undefined) return null;
  return {
    basis,
    monthlyPriceUsd: basis === "not_enabled" ? null : basis === "paid" ? (amount as number) : 0,
    ...(typeof body.cardOnFile === "boolean" ? { cardOnFile: body.cardOnFile } : {}),
  };
}

/** The monthly amount one domain costs this company: its own price when known, else the catalog's. */
export function domainMonthlyUsd(company: CompanyDomainPrice | null, catalog: DomainPrices): number {
  if (company && company.basis !== "not_enabled" && company.monthlyPriceUsd !== null) return company.monthlyPriceUsd;
  return catalog.standardUsd;
}

/** The price line under the domain box, in the company's own terms. */
export function domainPriceLine(company: CompanyDomainPrice | null, catalog: DomainPrices, companyName = ""): string {
  const name = companyName.trim();
  if (!company) {
    return `${formatUsd(catalog.standardUsd)}/month for this deployment, billed to the company. Remove it any time to stop the charge.`;
  }
  if (company.basis === "not_enabled") {
    return `Custom domains are not available for ${name || "this company"} yet. Contact HQ support to turn them on.`;
  }
  if (company.basis === "enterprise") {
    return `Custom domains are included in ${name ? `${name}'s` : "the company's"} enterprise plan. Nothing is charged.`;
  }
  const amount = domainMonthlyUsd(company, catalog);
  if (amount === 0) return `${name || "This company"} is not charged for custom domains.`;
  const charge = `It adds ${formatUsd(amount)}/month to ${name ? `${name}'s` : "the company's"} bill.`;
  if (company.cardOnFile === true) return `${charge} The card on file is charged; no card form is needed.`;
  if (company.cardOnFile === false) {
    return `${charge} ${name || "The company"} has no card on file, so adding stops at a page to add one.`;
  }
  return `${charge} Remove it any time to stop the charge.`;
}

export function formatUsd(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/** What a person typed, reduced to a bare lowercase hostname. */
export function normalizeDomainInput(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/)[0] ?? "";
  value = value.replace(/:\d+$/, "").replace(/\.$/, "");
  return value;
}

export type DomainInputProblem = "empty" | "invalid" | "reserved";

/** Client-side check before the network; the server repeats it. */
export function domainInputProblem(domain: string): DomainInputProblem | null {
  if (!domain) return "empty";
  const labels = domain.split(".");
  if (
    domain.length > 253
    || labels.length < 2
    || !labels.every((l) => l.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l))
    || /^\d+$/.test(labels[labels.length - 1] ?? "")
  ) {
    return "invalid";
  }
  if (RESERVED_DOMAINS.some((r) => domain === r || domain.endsWith(`.${r}`))) return "reserved";
  return null;
}

function state(value: unknown): DomainState {
  return value === "validated" || value === "failed" ? value : "pending";
}

export function domainRecordsFrom(body: unknown): DomainRecord[] {
  const list = isRecord(body) && Array.isArray(body.domains) ? body.domains : [];
  const out: DomainRecord[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const domain = text(raw.domain).toLowerCase();
    if (domain) out.push({ domain, state: state(raw.validationState) });
  }
  return out;
}

/**
 * Where a custom domain's routing CNAME points. hq-deploy hands out the
 * provisioned base (`provisionedPlatformBaseDomain()`: indigo-hq.com even when
 * the API advertises hq.work), so a rebuilt record names the same host the add
 * reply did.
 */
export function routingTargetFor(appHost: string): string {
  return appHost.endsWith(".hq.work") ? `${appHost.slice(0, -".hq.work".length)}.indigo-hq.com` : appHost;
}

/**
 * DNS records for one domain. The API returns the routing CNAME only on add
 * and the certificate record on add or refresh once ACM has made it, so the
 * routing record is rebuilt from the app's own host when it is missing.
 */
export function dnsRecordsFor(domain: string, appHost: string, instructions: unknown): DnsRecord[] {
  const out: DnsRecord[] = [];
  const list = Array.isArray(instructions) ? instructions : [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const name = text(raw.name).replace(/\.$/, "").toLowerCase();
    const value = text(raw.value).replace(/\.$/, "");
    if (!name || !value) continue;
    const purpose = name === domain ? "routing" : "ownership";
    if (out.some((r) => r.name === name)) continue;
    out.push({ type: text(raw.type) || "CNAME", name, value, purpose });
  }
  if (!out.some((r) => r.purpose === "routing") && appHost) {
    out.push({ type: "CNAME", name: domain, value: routingTargetFor(appHost), purpose: "routing" });
  }
  return out.sort((a, b) => (a.purpose === b.purpose ? 0 : a.purpose === "ownership" ? -1 : 1));
}

/** The app's own hostname, e.g. `launch-notes.indigo-hq.com`. */
export function appHostFrom(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export type DomainErrorKind =
  | "card"
  | "admin"
  | "not-eligible"
  | "reserved"
  | "invalid"
  | "taken"
  | "billing-down"
  | "signed-out"
  | "offline"
  | "generic";

export interface DomainError {
  kind: DomainErrorKind;
  message: string;
  code: string;
  /** Stripe page the server offered for adding a card (402 only). */
  billingUrl: string | null;
}

export class DomainRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly billingUrl: string | null;
  constructor(status: number, code: string, message: string, billingUrl: string | null) {
    super(message || `HTTP ${status}`);
    this.name = "DomainRequestError";
    this.status = status;
    this.code = code;
    this.billingUrl = billingUrl;
  }
}

/** A credential-free https URL on a Stripe host; anything else is dropped. */
export function trustedBillingUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    // Stripe's own hosts only: HQ zones can serve customer deployments.
    const allowed = ["stripe.com"];
    return allowed.some((d) => host === d || host.endsWith(`.${d}`)) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Plain copy for a refusal. Never shows server text except the price line it already carries. */
export function domainErrorCopy(err: unknown, prices: DomainPrices = DOMAIN_PRICE_FALLBACK): DomainError {
  const price = `${formatUsd(prices.standardUsd)}/month`;
  if (err instanceof DomainRequestError) {
    const base = { code: err.code, billingUrl: null as string | null };
    switch (err.code) {
      case "PAID_PLAN_REQUIRED":
        // Older hq-pro gate (before custom domains opened to every plan): a card alone does not clear it.
        return { ...base, kind: "not-eligible", message: "Custom domains are not on this company's plan yet. Contact HQ support to turn them on." };
      case "PAYMENT_METHOD_REQUIRED":
        return {
          ...base,
          kind: "card",
          billingUrl: err.billingUrl,
          message: `Add a card to the company to use a custom domain. It costs ${price}, and you can remove it at any time.`,
        };
      case "BILLING_ADMIN_REQUIRED":
        return { ...base, kind: "admin", message: "Only a company owner or admin can change custom domains. Ask one of them to do it." };
      case "DOMAIN_NOT_ENTITLED":
        return { ...base, kind: "not-eligible", message: "Custom domains are not available for this company yet. Contact HQ support to turn them on." };
      case "DOMAIN_RESERVED":
        return { ...base, kind: "reserved", message: "That domain belongs to HQ. Use a domain your company owns." };
      case "DOMAIN_INVALID":
      case "VALIDATION_ERROR":
        return { ...base, kind: "invalid", message: "Enter a domain like mysite.com, without https:// or a path." };
      case "DOMAIN_ALREADY_CLAIMED":
      case "DOMAIN_CROSS_TENANT":
        return { ...base, kind: "taken", message: "That domain is already linked to another deployment. Remove it there first, or use a different one." };
      case "BILLING_UNAVAILABLE":
        return { ...base, kind: "billing-down", message: "Billing could not be reached. Nothing was charged. Try again in a minute." };
      case "DOMAIN_NOT_FOUND":
        return { ...base, kind: "generic", message: "That domain is no longer linked to this deployment." };
      default:
        if (err.status === 401) return { ...base, kind: "signed-out", message: "Sign in again to manage domains." };
        if (err.status === 403) return { ...base, kind: "admin", message: "Only a company owner or admin can change custom domains. Ask one of them to do it." };
        return { ...base, kind: "generic", message: "Something went wrong on our side. Nothing was charged. Try again." };
    }
  }
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const none = { code: "", billingUrl: null };
  if (/^auth:|401/i.test(raw)) return { ...none, kind: "signed-out", message: "Sign in again to manage domains." };
  if (/fetch|network|offline/i.test(raw)) return { ...none, kind: "offline", message: "You look offline. Try again when you're connected." };
  return { ...none, kind: "generic", message: "Something went wrong on our side. Nothing was charged. Try again." };
}

export function inputProblemCopy(problem: DomainInputProblem): string {
  if (problem === "reserved") return "That domain belongs to HQ. Use a domain your company owns.";
  if (problem === "invalid") return "Enter a domain like mysite.com, without https:// or a path.";
  return "";
}

const base = (appId: string) => `/api/apps/${encodeURIComponent(appId)}/domains`;

export interface AddResult {
  domain: DomainRecord;
  instructions: unknown;
  /** What this domain costs the company each month (hq-deploy #260); absent on older servers. */
  monthlyPriceUsd?: number;
}

export interface RefreshResult {
  state: DomainState;
  serving: boolean;
  certStatus: string;
  instructions: unknown;
}

/** Thin client over the host request. A refusal throws {@link DomainRequestError}. */
export function deployDomainClient(request: DeployDomainRequest, scope: string) {
  async function run(method: DomainMethod, path: string, body?: Json): Promise<Record<string, unknown>> {
    const res = await request(scope, method, path, body);
    if (!res.ok) throw new Error(res.message ?? res.reason ?? "Request failed");
    const value = isRecord(res.value) ? res.value : {};
    const status = typeof value.status === "number" ? value.status : 200;
    const payload = isRecord(value.body) ? value.body : {};
    if (status >= 400) {
      const error = isRecord(payload.error) ? payload.error : payload;
      throw new DomainRequestError(status, text(error.code), text(error.message), trustedBillingUrl(error.billingUrl));
    }
    return payload;
  }
  return {
    list: async (appId: string) => domainRecordsFrom(await run("GET", base(appId))),
    add: async (appId: string, domain: string): Promise<AddResult> => {
      const body = await run("POST", base(appId), { domain });
      const record = isRecord(body.domain) ? body.domain : {};
      const monthlyPriceUsd = usableUsd(body.monthlyPriceUsd);
      return {
        domain: { domain: text(record.domain).toLowerCase() || domain, state: state(record.validationState) },
        instructions: body.dnsInstructions,
        ...(monthlyPriceUsd === undefined ? {} : { monthlyPriceUsd }),
      };
    },
    refresh: async (appId: string, domain: string): Promise<RefreshResult> => {
      const body = await run("POST", `${base(appId)}/${encodeURIComponent(domain)}/refresh`);
      return {
        state: state(body.validationState),
        serving: body.serving === true,
        certStatus: text(body.certStatus),
        instructions: body.dnsInstructions,
      };
    },
    remove: async (appId: string, domain: string): Promise<{ warning: string | null }> => {
      const body = await run("DELETE", `${base(appId)}/${encodeURIComponent(domain)}`);
      return { warning: text(body.warning) || null };
    },
  };
}

export type DeployDomainClient = ReturnType<typeof deployDomainClient>;

/** Waits before each automatic retry of the list read; Try again shows after the last one. */
export const LIST_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

/** A read worth retrying by itself: network trouble or a server error, not a refusal or sign-out. */
export function isRetryableReadError(err: unknown): boolean {
  if (err instanceof DomainRequestError) return err.status >= 500 || err.status === 429;
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return !/^auth:|401/i.test(raw);
}

/**
 * List an app's domains, retrying a passing failure a few times before giving
 * up. `stillWanted` stops the retries once the sheet has moved on.
 */
export async function listWithRetry(
  client: Pick<DeployDomainClient, "list">,
  appId: string,
  delays: readonly number[] = LIST_RETRY_DELAYS_MS,
  stillWanted: () => boolean = () => true,
): Promise<DomainRecord[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.list(appId);
    } catch (err) {
      const wait = delays[attempt];
      if (wait === undefined || !isRetryableReadError(err) || !stillWanted()) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (!stillWanted()) throw err;
    }
  }
}

/** True when the records carry the certificate (ownership) CNAME, not just the routing one. */
export function hasOwnershipRecord(domain: string, instructions: unknown): boolean {
  return dnsRecordsFor(domain, "", instructions).some((r) => r.purpose === "ownership");
}

/** Waits between the extra refresh reads that fetch a certificate record ACM has not made yet. */
export const RECORD_RETRY_DELAYS_MS: readonly number[] = [1500, 2500, 4000, 6000];

export interface OwnershipRecordResult {
  /** Every DNS instruction seen so far, the known ones first. */
  instructions: unknown[];
  /** The last refresh reply, or null when none was read. */
  last: RefreshResult | null;
}

/**
 * Collect both DNS records for a pending domain before showing them. ACM fills
 * in a new certificate's validation record a few seconds after the request,
 * and hq-deploy's add reply reads it once, right away, so that reply often
 * carries only the routing CNAME. Refresh returns the certificate record once
 * it exists: read it now, then after each delay, until it shows up.
 */
export async function awaitOwnershipRecord(
  client: Pick<DeployDomainClient, "refresh">,
  appId: string,
  domain: string,
  known: unknown,
  delays: readonly number[] = RECORD_RETRY_DELAYS_MS,
  stillWanted: () => boolean = () => true,
): Promise<OwnershipRecordResult> {
  const instructions: unknown[] = Array.isArray(known) ? [...known] : [];
  let last: RefreshResult | null = null;
  for (let attempt = 0; !hasOwnershipRecord(domain, instructions); attempt += 1) {
    if (attempt > 0) {
      const wait = delays[attempt - 1];
      if (wait === undefined || !stillWanted()) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    if (!stillWanted()) break;
    try {
      last = await client.refresh(appId, domain);
    } catch (err) {
      console.warn("[custom-domain] certificate record read failed", err);
      break;
    }
    if (Array.isArray(last.instructions)) instructions.push(...last.instructions);
    if (last.serving) break;
  }
  return { instructions, last };
}

/** `https://<domain>` for the first live custom domain, or null when none is live yet. */
export function liveCustomDomainUrl(records: readonly DomainRecord[]): string | null {
  const live = records.find((r) => r.state === "validated");
  return live ? `https://${live.domain}` : null;
}

/**
 * The address a deployment's detail shows: its live custom domain when it has
 * one, otherwise null so the caller keeps the app's own URL.
 */
export async function readLiveCustomDomainUrl(request: DeployDomainRequest, scope: string, appId: string): Promise<string | null> {
  return liveCustomDomainUrl(await deployDomainClient(request, scope).list(appId));
}

/** Plain status line for a domain. */
export function domainStatusCopy(record: DomainRecord, serving: boolean, certStatus = "", checking = false): string {
  return domainStatus(record, serving, certStatus, checking).label;
}

export type DomainStatusTone = "waiting" | "verifying" | "live" | "failed";

/**
 * Where a domain is in setup, for the status chip. Verifying covers a check in
 * progress and the stretch after the certificate is issued while HQ finishes
 * pointing the domain at the deployment.
 */
export function domainStatus(
  record: DomainRecord,
  serving: boolean,
  certStatus = "",
  checking = false,
): { tone: DomainStatusTone; label: string } {
  if (serving || record.state === "validated") return { tone: "live", label: "Live" };
  if (checking || certStatus === "ISSUED") return { tone: "verifying", label: "Verifying" };
  if (record.state === "failed" || certStatus === "FAILED" || certStatus === "VALIDATION_TIMED_OUT") {
    return { tone: "failed", label: "Couldn't verify. Check the DNS records, then check again" };
  }
  return { tone: "waiting", label: "Waiting for DNS" };
}

/**
 * A DNS name or value in at most two pieces: the first label with its dot,
 * then the rest. Long ACM names wrap once, after the random label, and keep
 * the domain (or `acm-validations.aws`) whole on the next line.
 */
export function hostSegments(value: string): string[] {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return [value];
  return [value.slice(0, dot + 1), value.slice(dot + 1)];
}

/** Owners and admins manage domains; everyone else sees status only. */
export function canManageDomains(role: string | null | undefined): boolean {
  const key = (role ?? "").trim().toLowerCase();
  return key === "owner" || key === "admin";
}
