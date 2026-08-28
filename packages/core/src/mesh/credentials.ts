/**
 * Pluggable credential vending + proactive renewal for the MeshClient.
 *
 * hq-pro vends short-lived (1h) scoped STS credentials plus the company thread
 * topics the caller is entitled to. The STS inline-policy 2048-char cap means
 * some companies may be dropped from the vended scope — the response surfaces
 * those as `droppedCompanies` so the UI can tell the user realtime is degraded
 * for them (REST reconcile still covers correctness).
 */

import type { MeshCredentials } from "./presign.js";

/** A vended credential bundle (contract v1). */
export interface MeshCredentialBundle {
  credentials: MeshCredentials;
  /** ISO8601 expiry (mirror of credentials.expiration). */
  expiration: string;
  /** AWS IoT ATS endpoint hostname. */
  iotEndpoint: string;
  region: string;
  /** Person UID the per-person topics are scoped to. */
  personUid: string;
  /** Company UIDs whose `hq/{companyUid}/thread/#` topics were vended. */
  companyTopics: string[];
  /**
   * Company UIDs that could NOT be included in the STS inline policy
   * (2048-char cap). Realtime wakes are unavailable for these; REST
   * reconciliation remains the source of truth.
   */
  droppedCompanies: string[];
}

/** Pluggable source of credential bundles. */
export interface CredentialProvider {
  fetchCredentials(): Promise<MeshCredentialBundle>;
}

/** Minimal fetch signature so tests and non-DOM hosts can inject. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    credentials?: "include" | "same-origin" | "omit";
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Web credential provider: same-origin proxy POST (the server holds the
 * Cognito bearer; it never reaches the browser). Requests contract v1 so the
 * response carries company thread topics + droppedCompanies.
 */
export function createWebCredentialProvider(
  options: {
    /** Same-origin proxy path. */
    url?: string;
    fetchImpl?: FetchLike;
  } = {},
): CredentialProvider {
  const url = options.url ?? "/api/realtime/credentials";
  const fetchImpl =
    options.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  return {
    async fetchCredentials(): Promise<MeshCredentialBundle> {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contract: "v1", scope: "company-topics" }),
        credentials: "same-origin",
      });
      if (!res.ok) {
        throw new Error(`credential vend failed: HTTP ${res.status}`);
      }
      return normalizeBundle(await res.json());
    },
  };
}

function uidFromHqTopic(topic: unknown): string {
  if (typeof topic !== "string") return "";
  const match = /^hq\/((?:prs_|agt_|cmp_)[^/]+)\//.exec(topic.trim());
  return match?.[1] ?? "";
}

function personUidFromVend(r: Record<string, unknown>): string {
  if (typeof r.personUid === "string" && r.personUid.trim()) {
    return r.personUid.trim();
  }
  const fromTopic = uidFromHqTopic(r.topic);
  if (fromTopic.startsWith("prs_") || fromTopic.startsWith("agt_")) {
    return fromTopic;
  }
  const topics =
    r.topics && typeof r.topics === "object" && !Array.isArray(r.topics)
      ? (r.topics as Record<string, unknown>)
      : null;
  for (const key of ["dm", "work", "notifications", "sessions"] as const) {
    const uid = uidFromHqTopic(topics?.[key]);
    if (uid.startsWith("prs_") || uid.startsWith("agt_")) return uid;
  }
  return "";
}

function companyTopicsFromVend(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (uid: string) => {
    const value = uid.trim();
    if (!value.startsWith("cmp_") || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  for (const item of v) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.startsWith("cmp_")) push(trimmed);
      else push(uidFromHqTopic(trimmed));
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.companyUid === "string") push(rec.companyUid);
    else push(uidFromHqTopic(rec.threadTopicFilter));
  }
  return out;
}

/** Normalize a raw vend response into a MeshCredentialBundle (fail-safe). */
export function normalizeBundle(raw: unknown): MeshCredentialBundle {
  const r = raw as Record<string, unknown>;
  const creds = r.credentials as Record<string, unknown> | undefined;
  if (
    !creds ||
    typeof creds.accessKeyId !== "string" ||
    typeof creds.secretAccessKey !== "string" ||
    typeof creds.sessionToken !== "string"
  ) {
    throw new Error("credential vend response missing credentials");
  }
  const expiration =
    (typeof r.expiresAt === "string" && r.expiresAt) ||
    (typeof creds.expiration === "string" && creds.expiration) ||
    "";
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
      expiration: expiration || undefined,
    },
    expiration,
    iotEndpoint: typeof r.iotEndpoint === "string" ? r.iotEndpoint : "",
    region: typeof r.region === "string" ? r.region : "",
    personUid: personUidFromVend(r),
    companyTopics: companyTopicsFromVend(r.companyTopics),
    droppedCompanies: strings(r.droppedCompanies),
  };
}

/** Injectable timer seam (fake timers in tests). */
export interface TimerHost {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const realTimerHost: TimerHost = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
  now: () => Date.now(),
};

const MIN_RENEWAL_DELAY_MS = 5_000;

/**
 * Compute when to proactively renew: the EARLIER of 80% of remaining lifetime
 * and (expiry - 5min), clamped to a small floor so a short/misbehaving expiry
 * cannot busy-loop renewal.
 */
export function renewalDelayMs(nowMs: number, expirationIso: string): number {
  const expMs = Date.parse(expirationIso);
  if (Number.isNaN(expMs)) return 30 * 60_000; // no usable expiry — hourly-ish
  const lifetime = expMs - nowMs;
  const at80 = lifetime * 0.8;
  const fiveBefore = lifetime - 5 * 60_000;
  return Math.max(MIN_RENEWAL_DELAY_MS, Math.min(at80, fiveBefore));
}

/**
 * Proactive renewal manager: renews well before the 1-hour STS expiry and
 * hands the fresh bundle to `onRenewed` (the MeshClient re-presigns and
 * reconnects without dropping its subscription set). Renewal failures retry
 * on a short fixed delay until expiry-driven disconnect makes the client's
 * reconnect loop take over.
 */
export class CredentialRenewalManager {
  private handle: unknown = null;
  private stopped = false;

  constructor(
    private readonly provider: CredentialProvider,
    private readonly onRenewed: (bundle: MeshCredentialBundle) => void,
    private readonly onError: (err: unknown) => void = () => {},
    private readonly timers: TimerHost = realTimerHost,
    private readonly retryDelayMs: number = 30_000,
  ) {}

  /** Schedule renewal for a bundle just obtained. */
  schedule(bundle: MeshCredentialBundle): void {
    if (this.stopped) return;
    this.clear();
    const delay = renewalDelayMs(this.timers.now(), bundle.expiration);
    this.handle = this.timers.setTimeout(() => void this.renew(), delay);
  }

  private async renew(): Promise<void> {
    if (this.stopped) return;
    try {
      const bundle = await this.provider.fetchCredentials();
      if (this.stopped) return;
      this.onRenewed(bundle);
      this.schedule(bundle);
    } catch (err) {
      this.onError(err);
      if (this.stopped) return;
      this.clear();
      this.handle = this.timers.setTimeout(
        () => void this.renew(),
        this.retryDelayMs,
      );
    }
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private clear(): void {
    if (this.handle !== null) {
      this.timers.clearTimeout(this.handle);
      this.handle = null;
    }
  }
}
