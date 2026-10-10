/**
 * What the visual first-run takeover asks of its host for "Your team",
 * Note taker and Project management, what it reports back, and the desktop's
 * implementations over the platform adapter.
 *
 * Every action goes through the same calls the rest of the app uses:
 * joining through `company.claimPendingInvite` (the invite bell's Join),
 * starting a company through the `create_company` card (the New company
 * sheet), reading the catalog and connections and connecting an app through
 * `integrations` (the company Integrations page and the bot connection
 * cards). A dry walk (`VITE_HQ_DEV_FIRST_RUN_DRY`, dev-switches.ts) still
 * reads, but every action only pretends.
 */

import type { AdapterResult, IntegrationAppRef, IntegrationInstallInput, IntegrationOAuthStart, Json } from "@hq/platform";

import { catalogFailureLine } from "../../company/files-connect/integration-apps.js";
import { CONNECTING_TIMEOUT_MS } from "../messaging/connection-card-model.js";
import { connectFailureSentence, readCompanyConnections } from "../messaging/integration-cards-model.js";
import { appsForKind, catalogEntries, type AppCatalogResult, type AppConnectResult, type FirstRunApp, type FirstRunAppKind } from "./app-step.js";
import { FIRST_RUN_DRY_DELAY_MS } from "./dev-switches.js";
import { companySlugFromName, type FirstRunTeamCompany, type TeamActionResult } from "./team-step.js";
import type { FirstRunAppsHandoff, FirstRunTeamHandoff } from "./visual-first-run.js";

/** Joins and starts companies for "Your team". */
export interface FirstRunTeamHost {
  join(company: FirstRunTeamCompany): Promise<TeamActionResult>;
  create(name: string): Promise<TeamActionResult>;
}
/** Reads the catalog and connects apps for Note taker and Project management. */
export interface FirstRunAppsHost {
  catalog(companyUid: string, kind: FirstRunAppKind): Promise<AppCatalogResult>;
  /**
   * Resolves once the app is connected (or failed). `signal` aborts a wait
   * still running when the takeover goes away: it then answers a quiet
   * failure and reads nothing more.
   */
  connect(companyUid: string, app: FirstRunApp, signal?: AbortSignal): Promise<AppConnectResult>;
}
/** What the later screens settled, for the setup bot's handoff. */
export interface FirstRunSettled {
  team: FirstRunTeamHandoff | null;
  apps: FirstRunAppsHandoff;
}

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

/** A wait called off because the takeover went away. Never shown. */
export const CONNECT_ABORTED: AppConnectResult = { ok: false, reason: "", retry: false };

// ── Your team ──────────────────────────────────────────────────────────────

export interface TeamHostDeps {
  /** `adapter.company.claimPendingInvite`. */
  claimInvite?: ((slug: string) => Promise<AdapterResult<Json>>) | null;
  /** The New company sheet's create (the `create_company` card). */
  createCompany?:
    | ((name: string, slug: string) => Promise<{ ok: true; companyUid: string | null } | { ok: false; reason: string }>)
    | null;
  /** After a join or a create: pin, refresh the roster. Never navigates. */
  joined?: (companyUid: string | null) => void | Promise<void>;
  created?: (companyUid: string | null) => void | Promise<void>;
  /**
   * Re-read the roster and return the person's company with this slug, or
   * null. Asked before a create runs again after a failure or a timeout:
   * the first try may have made the company after all.
   */
  findCompany?: ((slug: string) => Promise<FirstRunTeamCompany | null>) | null;
  dry: boolean;
  delayMs?: number;
}

export const JOIN_FAILURE = "Couldn't join the company. Try again.";
export const CREATE_UNAVAILABLE = "Starting a company isn't available here yet. Continue in chat to start one.";

export function createFirstRunTeamHost(deps: TeamHostDeps): FirstRunTeamHost {
  const delay = deps.delayMs ?? FIRST_RUN_DRY_DELAY_MS;
  /**
   * Calls still running, by action and slug. A Retry after the screen gave up
   * waiting (team-step.ts TEAM_ACTION_TIMEOUT_MS) waits on the same call
   * instead of joining or creating a second time.
   */
  const inFlight = new Map<string, Promise<TeamActionResult>>();
  /** How the last create for a slug ended, once it has. */
  const lastCreate = new Map<string, TeamActionResult>();
  function once(key: string, start: () => Promise<TeamActionResult>): Promise<TeamActionResult> {
    const running = inFlight.get(key);
    if (running) return running;
    const call = start().finally(() => inFlight.delete(key));
    inFlight.set(key, call);
    return call;
  }

  async function join(company: FirstRunTeamCompany): Promise<TeamActionResult> {
    if (deps.dry) {
      await sleep(delay);
      return { ok: true, choice: { kind: "company", how: "joined", company } };
    }
    if (!deps.claimInvite) return { ok: false, reason: JOIN_FAILURE };
    const claim = await deps.claimInvite(company.slug);
    const { inviteClaimOutcome } = await import("../../inbox/company-invite-requests.js");
    const outcome = inviteClaimOutcome(claim, company.companyUid ?? "", []);
    if (!outcome.ok) return { ok: false, reason: outcome.message };
    await deps.joined?.(company.companyUid);
    return { ok: true, choice: { kind: "company", how: "joined", company } };
  }

  async function create(name: string, slug: string): Promise<TeamActionResult> {
    if (deps.dry) {
      await sleep(delay);
      return { ok: true, choice: { kind: "company", how: "created", company: { companyUid: "cmp_dry_run", slug, name } } };
    }
    if (!deps.createCompany) return { ok: false, reason: CREATE_UNAVAILABLE };
    const before = lastCreate.get(slug);
    // The last try made it after the screen gave up waiting: keep that company.
    if (before?.ok) return before;
    // The last try failed or never answered: it may have made the company anyway.
    if (before && deps.findCompany) {
      const found = await deps.findCompany(slug).catch(() => null);
      if (found) return { ok: true, choice: { kind: "company", how: "existing", company: found } };
    }
    const result = await deps.createCompany(name, slug);
    if (!result.ok) return { ok: false, reason: result.reason };
    await deps.created?.(result.companyUid);
    return { ok: true, choice: { kind: "company", how: "created", company: { companyUid: result.companyUid, slug, name } } };
  }

  return {
    join(company) {
      return once(`join:${company.slug}`, () => join(company));
    },
    create(name) {
      const slug = companySlugFromName(name);
      if (!slug) return Promise.resolve({ ok: false, reason: "Use at least three letters or digits, starting with a letter." });
      return once(`create:${slug}`, async () => {
        let result: TeamActionResult;
        try {
          result = await create(name, slug);
        } catch (err) {
          lastCreate.set(slug, { ok: false, reason: "" });
          throw err;
        }
        lastCreate.set(slug, result);
        return result;
      });
    },
  };
}

// ── Note taker and Project management ──────────────────────────────────────

export interface AppsHostDeps {
  catalogSearch?: ((companyUid: string, query: string, limit?: number) => Promise<AdapterResult<Json>>) | null;
  listConnections?: ((companyUid: string) => Promise<AdapterResult<Json>>) | null;
  startOAuth?: ((input: IntegrationAppRef) => Promise<AdapterResult<IntegrationOAuthStart>>) | null;
  install?: ((input: IntegrationInstallInput) => Promise<AdapterResult<Json>>) | null;
  /** Opens the provider's sign-in page in the system browser. */
  openUrl: (url: string) => void;
  dry: boolean;
  delayMs?: number;
  /** How often the connection list is read while a browser sign-in runs. */
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** The catalog's server bound (1..100): one read covers both screens' apps. */
export const CATALOG_LIMIT = 100;

function connectedDomains(json: unknown): string[] {
  return (readCompanyConnections(json)?.connections ?? []).map((c) => c.domain).filter((d): d is string => !!d);
}

export function createFirstRunAppsHost(deps: AppsHostDeps): FirstRunAppsHost {
  const delay = deps.delayMs ?? FIRST_RUN_DRY_DELAY_MS;
  const pollMs = deps.pollMs ?? 3000;
  const timeoutMs = deps.timeoutMs ?? CONNECTING_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  /** The ids of the company's connections to this app's domain, or null when the list cannot be read. */
  async function connectionIds(companyUid: string, domain: string): Promise<Set<string> | null> {
    const list = deps.listConnections;
    if (!list) return null;
    const read = await list(companyUid).catch(() => null);
    if (!read?.ok) return null;
    const facts = readCompanyConnections(read.value);
    return new Set((facts?.connections ?? []).filter((c) => c.domain === domain).map((c) => c.id));
  }

  /**
   * Wait for a connection to the app's domain that was not on the list before
   * the browser opened. Ids are compared, never the server's clock against
   * this computer's. Only this computer's clock times the wait.
   */
  async function waitForConnection(
    companyUid: string,
    app: FirstRunApp,
    before: Set<string>,
    signal?: AbortSignal,
  ): Promise<AppConnectResult> {
    if (!deps.listConnections) return { ok: false, reason: `Could not check on ${app.name}. Try again.`, retry: true };
    const started = now();
    while (now() - started <= timeoutMs) {
      await sleep(pollMs, signal);
      if (signal?.aborted) return CONNECT_ABORTED;
      const ids = await connectionIds(companyUid, app.domain);
      if (signal?.aborted) return CONNECT_ABORTED;
      if (ids && [...ids].some((id) => !before.has(id))) return { ok: true };
    }
    return { ok: false, reason: `${app.name} did not finish connecting. Try again.`, retry: true };
  }

  return {
    async catalog(companyUid, kind) {
      const search = deps.catalogSearch;
      if (!search) return { ok: false, reason: "Apps can't be listed here. You can skip this.", retry: false };
      const res = await search(companyUid, "", CATALOG_LIMIT);
      if (!res.ok) {
        const verdict = catalogFailureLine(res);
        return { ok: false, reason: verdict.line, retry: verdict.retry };
      }
      const apps = appsForKind(catalogEntries(res.value), kind);
      const listed = deps.listConnections ? await deps.listConnections(companyUid).catch(() => null) : null;
      return { ok: true, apps, connected: listed?.ok ? connectedDomains(listed.value) : [] };
    },
    async connect(companyUid, app, signal) {
      if (deps.dry) {
        await sleep(delay);
        return { ok: true };
      }
      if (app.authClass === "none") {
        const installed = deps.install ? await deps.install({ companyUid, domain: app.domain }) : null;
        if (installed?.ok) return { ok: true };
        const why = connectFailureSentence(installed && !installed.ok ? installed : null, app.name);
        return { ok: false, reason: why.sentence, retry: why.retry };
      }
      if (app.authClass === "key") return { ok: false, reason: `${app.name} needs an access key. Connect it later from Integrations.`, retry: false };
      // What is there before the browser opens: only a connection not in
      // this set answers the press.
      const before = await connectionIds(companyUid, app.domain);
      const started = deps.startOAuth
        ? await deps.startOAuth({ companyUid, domain: app.domain, ...(app.entryId ? { catalogEntryId: app.entryId } : {}) })
        : null;
      if (!started?.ok || !/^https:\/\//i.test(started.value.authorizationUrl ?? "")) {
        const why = connectFailureSentence(started && !started.ok ? started : null, app.name);
        return { ok: false, reason: why.sentence, retry: why.retry };
      }
      if (signal?.aborted) return CONNECT_ABORTED;
      deps.openUrl(started.value.authorizationUrl);
      return waitForConnection(companyUid, app, before ?? new Set(), signal);
    },
  };
}
