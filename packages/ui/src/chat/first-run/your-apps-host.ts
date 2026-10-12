/**
 * First-run "Your apps": what the step asks of its host, and the desktop's
 * implementation over the platform adapter.
 *
 * - detect: `shell.detectWorkApps` (names only, never leaves the computer).
 * - load: the catalog lookup for the WHOLE signature list
 *   (`lookupSignatureCatalog`) and the company's connections.
 * - autoConnect: `integrations.install({ catalogEntryId, origin: "first-run-auto" })`
 *   for no-sign-in catalog apps; owner or admin only (the plan decides).
 * - connect: OAuth in the browser, then wait for a new connection to the
 *   app's domain or a subdomain of it, as the old app step did.
 * - setup: docs-based discovery, then install (no auth) or OAuth with the
 *   discovery receipt. A key-only or CLI-only answer, or a 404/409/422, ends
 *   as "HQ can't connect it yet".
 * - undo: `integrations.uninstall({ installationId })`.
 *
 * Nothing here reads or sends a credential.
 */

import type { AdapterResult, FoundWorkApps, IntegrationAppRef, IntegrationInstallInput, IntegrationOAuthStart, Json } from "@hq/platform";

import { CONNECTING_TIMEOUT_MS } from "../messaging/connection-card-model.js";
import { connectFailureSentence } from "../messaging/integration-cards-model.js";
import { FIRST_RUN_DRY_DELAY_MS } from "./dev-switches.js";
import { lookupSignatureCatalog, type CatalogLookupApi, type CatalogMatch } from "./found-apps.js";
import type { AppTile, StepConnection } from "./your-apps.js";

export type YourAppsResult =
  | { ok: true; connectionId: string | null; installationId: string | null }
  | { ok: false; reason: string; retry: boolean; unsupported?: boolean };

export interface YourAppsLoad {
  catalog: Record<string, CatalogMatch | null> | null;
  connections: StepConnection[];
  /** Installation ids by connection id, for Undo on rows hq-pro marked automatic. */
  installations: Record<string, string>;
  canManage: boolean;
  /** The connections list could not be read. */
  problem: { reason: string; retry: boolean } | null;
}

export interface YourAppsHost {
  detect(): Promise<FoundWorkApps | null>;
  load(companyUid: string): Promise<YourAppsLoad>;
  autoConnect(companyUid: string, entryId: string, name: string): Promise<YourAppsResult>;
  connect(companyUid: string, tile: AppTile, signal?: AbortSignal): Promise<YourAppsResult>;
  setup(companyUid: string, tile: AppTile, signal?: AbortSignal): Promise<YourAppsResult>;
  undo(companyUid: string, installationId: string): Promise<YourAppsResult>;
}

export interface YourAppsHostDeps {
  detectWorkApps?: (() => Promise<AdapterResult<FoundWorkApps>>) | null;
  catalogLookup?: CatalogLookupApi["catalogLookup"] | null;
  listConnections?: ((companyUid: string) => Promise<AdapterResult<Json>>) | null;
  startOAuth?: ((input: IntegrationAppRef & { discoveryReceiptId?: string }) => Promise<AdapterResult<IntegrationOAuthStart>>) | null;
  install?: ((input: IntegrationInstallInput) => Promise<AdapterResult<Json>>) | null;
  discoverDocs?: ((input: { companyUid: string; docsUrl: string }) => Promise<AdapterResult<Json>>) | null;
  uninstall?: ((input: { companyUid: string; installationId: string }) => Promise<AdapterResult<Json>>) | null;
  openUrl: (url: string) => void;
  dry: boolean;
  delayMs?: number;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export const YOUR_APPS_ABORTED: YourAppsResult = { ok: false, reason: "", retry: false };
export const CANT_CONNECT_YET = (name: string): string => `HQ can't connect ${name} yet. We noted that you use it.`;
export const LIST_FAILED = "Couldn't read your company's apps. You can connect them later from Integrations.";
/** The catalog lookup is all or nothing (a 502 when any domain gets no answer). */
export const LOOKUP_FAILED = "Couldn't check which apps HQ can connect. Try again.";

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedDomain(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const d = raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#:].*$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) ? d : null;
}

/**
 * The connections list (`GET /v1/integrations/admin?view=summary`) as the
 * step needs it: connected rows only, with hq-pro's automatic marker
 * (`origin`, or `installation.origin`) and the installation id for Undo.
 */
export function readStepConnections(json: unknown): { connections: StepConnection[]; installations: Record<string, string>; canManage: boolean } | null {
  if (!isRecord(json)) return null;
  const viewer = isRecord(json.viewer) ? json.viewer : null;
  const connections: StepConnection[] = [];
  const installations: Record<string, string> = {};
  for (const raw of Array.isArray(json.connections) ? json.connections : []) {
    if (!isRecord(raw) || raw.status !== "connected") continue;
    const id = str(raw.id);
    if (!id) continue;
    const installation = isRecord(raw.installation) ? raw.installation : null;
    const origin = str(raw.origin) ?? str(installation?.origin);
    const installationId = str(installation?.id);
    if (installationId) installations[id] = installationId;
    connections.push({
      id,
      domain: normalizedDomain(installation?.domain),
      provider: (str(raw.provider) ?? "").replace(/^factory:/i, "").toLowerCase(),
      ...(origin === "first-run-auto" ? { autoConnected: true } : {}),
    });
  }
  return { connections, installations, canManage: viewer?.canManageIntegrations === true };
}

function sameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** The install answer's connection and installation ids. */
function installIds(json: unknown): { connectionId: string | null; installationId: string | null } {
  const root = isRecord(json) ? json : null;
  const connection = isRecord(root?.connection) ? root.connection : null;
  const installation = isRecord(root?.installation) ? root.installation : null;
  return { connectionId: str(connection?.id) ?? str(installation?.connectionId), installationId: str(installation?.id) };
}

/** The docs-discovery answer, read for the next step. */
export type DocsVerdict =
  | { next: "install"; receiptId: string }
  | { next: "oauth"; receiptId: string }
  | { next: "unsupported" };

export function readDocsDiscovery(json: unknown): DocsVerdict {
  const root = isRecord(json) ? json : null;
  const receiptId = str(root?.discoveryReceiptId);
  const discovery = isRecord(root?.discovery) ? root.discovery : null;
  if (!root || root.ok !== true || !receiptId || !discovery) return { next: "unsupported" };
  if (discovery.authMode === "none" && discovery.verification === "verified") return { next: "install", receiptId };
  // A key-only server would need the person to paste a key: not taken here.
  if (discovery.authMode === "oauth" && discovery.verification === "pending-auth") return { next: "oauth", receiptId };
  return { next: "unsupported" };
}

/** A well-formed https address (the only kind a sign-in may open). */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function createYourAppsHost(deps: YourAppsHostDeps): YourAppsHost {
  const delay = deps.delayMs ?? FIRST_RUN_DRY_DELAY_MS;
  const pollMs = deps.pollMs ?? 3000;
  const timeoutMs = deps.timeoutMs ?? CONNECTING_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  async function ids(companyUid: string, domain: string): Promise<Set<string> | null> {
    if (!deps.listConnections) return null;
    const read = await deps.listConnections(companyUid).catch(() => null);
    if (!read?.ok) return null;
    const facts = readStepConnections(read.value);
    return new Set((facts?.connections ?? []).filter((c) => c.domain && sameSite(c.domain, domain)).map((c) => c.id));
  }

  /** Wait for a connection to the app's domain that was not there before the browser opened. */
  async function waitFor(companyUid: string, tile: AppTile, before: Set<string>, signal?: AbortSignal): Promise<YourAppsResult> {
    if (!deps.listConnections) return { ok: false, reason: `Could not check on ${tile.name}. Try again.`, retry: true };
    const started = now();
    while (now() - started <= timeoutMs) {
      await sleep(pollMs, signal);
      if (signal?.aborted) return YOUR_APPS_ABORTED;
      const current = await ids(companyUid, tile.domain);
      if (signal?.aborted) return YOUR_APPS_ABORTED;
      const fresh = current ? [...current].find((id) => !before.has(id)) : undefined;
      if (fresh) return { ok: true, connectionId: fresh, installationId: null };
    }
    return { ok: false, reason: `${tile.name} did not finish connecting. Try again.`, retry: true };
  }

  async function oauth(companyUid: string, tile: AppTile, ref: IntegrationAppRef & { discoveryReceiptId?: string }, signal?: AbortSignal): Promise<YourAppsResult> {
    // Without the list as it was before the browser opens, an existing
    // connection would look new: stop with a retry instead of guessing.
    const before = await ids(companyUid, tile.domain);
    if (!before) return { ok: false, reason: `Could not check on ${tile.name}. Try again.`, retry: true };
    const started = deps.startOAuth ? await deps.startOAuth(ref).catch(() => null) : null;
    if (!started?.ok || !isHttpsUrl(started.value.authorizationUrl)) {
      const why = connectFailureSentence(started && !started.ok ? started : null, tile.name);
      return { ok: false, reason: why.sentence, retry: why.retry };
    }
    if (signal?.aborted) return YOUR_APPS_ABORTED;
    deps.openUrl(started.value.authorizationUrl);
    return waitFor(companyUid, tile, before, signal);
  }

  async function installWith(input: IntegrationInstallInput, name: string): Promise<YourAppsResult> {
    const res = deps.install ? await deps.install(input).catch(() => null) : null;
    if (res?.ok) return { ok: true, ...installIds(res.value) };
    const why = connectFailureSentence(res && !res.ok ? res : null, name);
    return { ok: false, reason: why.sentence, retry: why.retry };
  }

  return {
    async detect() {
      if (!deps.detectWorkApps) return null;
      const res = await deps.detectWorkApps().catch(() => null);
      return res?.ok ? res.value : null;
    },

    async load(companyUid) {
      const [catalog, listed] = await Promise.all([
        lookupSignatureCatalog(deps.catalogLookup ? { catalogLookup: deps.catalogLookup } : null, companyUid),
        deps.listConnections ? deps.listConnections(companyUid).catch(() => null) : Promise.resolve(null),
      ]);
      const facts = listed?.ok ? readStepConnections(listed.value) : null;
      return {
        catalog,
        connections: facts?.connections ?? [],
        installations: facts?.installations ?? {},
        canManage: facts?.canManage ?? false,
        problem: !facts
          ? { reason: LIST_FAILED, retry: !!deps.listConnections }
          : deps.catalogLookup && !catalog
            ? { reason: LOOKUP_FAILED, retry: true }
            : null,
      };
    },

    async autoConnect(companyUid, entryId, name) {
      if (deps.dry) {
        await sleep(delay);
        return { ok: true, connectionId: null, installationId: null };
      }
      return installWith({ companyUid, catalogEntryId: entryId, origin: "first-run-auto" }, name);
    },

    async connect(companyUid, tile, signal) {
      if (deps.dry) {
        await sleep(delay);
        return { ok: true, connectionId: null, installationId: null };
      }
      if (tile.action === "install" && tile.entryId) return installWith({ companyUid, catalogEntryId: tile.entryId }, tile.name);
      if (tile.action !== "connect") return { ok: false, reason: `${tile.name} can't be connected here.`, retry: false };
      return oauth(companyUid, tile, { companyUid, domain: tile.domain, ...(tile.entryId ? { catalogEntryId: tile.entryId } : {}) }, signal);
    },

    async setup(companyUid, tile, signal) {
      if (deps.dry) {
        await sleep(delay);
        return { ok: false, reason: CANT_CONNECT_YET(tile.name), retry: false, unsupported: true };
      }
      if (!tile.docsUrl || !deps.discoverDocs) return { ok: false, reason: CANT_CONNECT_YET(tile.name), retry: false, unsupported: true };
      const res = await deps.discoverDocs({ companyUid, docsUrl: tile.docsUrl }).catch(() => null);
      if (signal?.aborted) return YOUR_APPS_ABORTED;
      if (!res) return { ok: false, reason: `Couldn't reach HQ to set up ${tile.name}. Try again.`, retry: true };
      if (!res.ok) {
        const status = (res as { status?: number }).status;
        if (status === 404 || status === 409 || status === 422) return { ok: false, reason: CANT_CONNECT_YET(tile.name), retry: false, unsupported: true };
        const why = connectFailureSentence(res, tile.name);
        return { ok: false, reason: why.sentence, retry: why.retry };
      }
      const verdict = readDocsDiscovery(res.value);
      if (verdict.next === "install") {
        const done = await installWith({ companyUid, discoveryReceiptId: verdict.receiptId }, tile.name);
        return done.ok ? done : { ...done, unsupported: !done.retry };
      }
      if (verdict.next === "oauth") {
        const done = await oauth(companyUid, tile, { companyUid, discoveryReceiptId: verdict.receiptId }, signal);
        return done;
      }
      return { ok: false, reason: CANT_CONNECT_YET(tile.name), retry: false, unsupported: true };
    },

    async undo(companyUid, installationId) {
      if (deps.dry) {
        await sleep(delay);
        return { ok: true, connectionId: null, installationId };
      }
      const res = deps.uninstall ? await deps.uninstall({ companyUid, installationId }).catch(() => null) : null;
      if (res?.ok) return { ok: true, connectionId: null, installationId };
      return { ok: false, reason: "Couldn't undo that. You can remove it from Integrations.", retry: true };
    },
  };
}
