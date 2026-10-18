/**
 * First-run "Your apps" (integration auto-detect MVP): the one step that
 * replaces Note taker and Project management. Every app found on this
 * computer is on one view, grouped by what is left for the person to do:
 *
 * 1. Connected: the company already has it (`team`), it connected with no
 *    sign-in during this step (`auto`, with Undo), or the person connected it
 *    here (`person`).
 * 2. Ready to connect: in the catalog; Connect runs the sign-in. Apps that
 *    need a key say to add it later from Integrations. Members (not owner or
 *    admin) see "An admin can connect this".
 * 3. Not in HQ yet: found, not in the catalog. "Set up with HQ" runs the
 *    docs-based discovery when the signature table has a docs URL.
 * 4. Also on this computer: found apps HQ does not connect to, by name.
 *
 * Owner decision dec-20261012015131-z0g0 ("Add it to install. We do not need
 * Corey's OK") and the defaults in companies/indigo/projects/
 * integration-auto-detect/mvp-plan.md.
 *
 * Pure: grouping, copy and the auto-connect plan. The host runs the network.
 */

import { APP_SIGNATURES, type CatalogMatch, type FoundApp, type FoundAppKind, type NativeProvider } from "./found-apps.js";

export type { CatalogMatch };

/** One of the company's connections, as the step needs it. */
export interface StepConnection {
  id: string;
  /** Normalized website domain, when the list carries it. */
  domain: string | null;
  /** Provider slug without `factory:`, e.g. "slack", "google", "linear". */
  provider: string;
  /** Recorded by hq-pro when the first run connected it with no sign-in. */
  autoConnected?: boolean;
}

/** Where one app's connect stands in this step. */
export type AppRun =
  | { state: "idle" }
  | { state: "connecting"; via: "browser" | "install" }
  | { state: "checking-docs" }
  | { state: "connected"; how: "auto" | "person"; connectionId: string | null; installationId?: string | null }
  | { state: "undoing"; connectionId: string | null; installationId: string }
  | { state: "failed"; reason: string; retry: boolean }
  | { state: "unsupported" };

export type TileAction =
  /** Catalog app with a sign-in. */
  | "connect"
  /** Slack or Google Workspace: HQ's own providers, connected on the Integrations page. */
  | "integrations"
  /**
   * Slack: HQ has no browser sign-in for it here, so the tile says to connect
   * it later from Integrations and shows no button.
   */
  | "later"
  /** No-sign-in catalog app the person can still press (auto-connect did not run or was undone). */
  | "install"
  /** Not in the catalog; HQ reads the vendor's docs. */
  | "setup"
  /** Needs a key: added later from Integrations (no key is taken here). */
  | "needs-key"
  /** The person is not an owner or admin. */
  | "admin-only"
  /** Not in the catalog and no docs to try. */
  | "not-yet";

export interface ConnectedChip {
  domain: string;
  name: string;
  how: "team" | "auto" | "person";
  connectionId: string | null;
  /** The installation Undo removes; null when it is not known (then there is no Undo). */
  installationId: string | null;
  /** Undo is offered only for an automatic connection whose installation is known. */
  canUndo: boolean;
  undoing: boolean;
}

export interface AppTile {
  domain: string;
  name: string;
  kind: FoundAppKind;
  native: NativeProvider | null;
  entryId: string | null;
  docsUrl: string | null;
  action: TileAction;
  run: AppRun;
  /** One short line under the name. */
  note: string;
}

export interface YourAppsView {
  connected: ConnectedChip[];
  ready: AppTile[];
  notInHq: AppTile[];
  /** Names of found apps HQ does not offer, in table order. */
  alsoFound: string[];
  /** Installed apps and servers no signature knew (counted, never named). */
  unmatched: number;
  /** Apps found in total (every group plus the unmatched count). */
  foundCount: number;
}

export interface YourAppsInput {
  found: readonly FoundApp[];
  unmatched: number;
  /** The catalog lookup, by domain; missing or null means not in the catalog. */
  catalog: Readonly<Record<string, CatalogMatch | null>> | null;
  connections: readonly StepConnection[];
  /** Installation ids by connection id, from the company's list. */
  installations?: Readonly<Record<string, string>>;
  /** Owner or admin of the company: may install, sign in and discover. */
  canManage: boolean;
  runs: Readonly<Record<string, AppRun>>;
  /** The "where it was found" line for an app (see `evidenceLine`). */
  evidence: (app: FoundApp) => string;
}

/** Kinds first shown, in this order: note takers, then project tools. */
const KIND_ORDER: readonly FoundAppKind[] = ["Meetings", "Work", "Knowledge", "Comms", "Design", "Data", "Analytics", "Dev", "Payments", "Other"];

export const YOUR_APPS_COPY = {
  kicker: "Your apps",
  lead: "Connect your",
  em: "work apps.",
  connect: "Connect",
  install: "Connect",
  setup: "Set up with HQ",
  retry: "Try again",
  waiting: "Waiting",
  connecting: "Connecting",
  checking: "Checking",
  notYet: "Not yet",
  undo: "Undo",
  continue: "Continue",
  inBrowser: "In your browser",
  readingGuide: "Reading its guide",
  failed: "Didn't connect",
  cantYet: "HQ can't connect it yet",
  needsKey: "Needs a key. Add it later from Integrations.",
  later: "Connect later in Integrations",
  adminOnly: "An admin can connect this",
  groupConnected: "Connected",
  groupReady: "Ready to connect",
  groupReadyNote: "One sign-in each",
  groupNotInHq: "Not in HQ yet",
  groupNotInHqNote: "HQ can try from their setup guides",
  groupAlso: "Also on this computer",
  alsoTail: "HQ doesn't connect to these.",
  team: "team",
  noSignIn: "no sign-in",
  you: "you",
  statusTail: "You can connect more later from Integrations.",
} as const;

/** The line under the title. `foundCount` 0 is the "nothing found" copy. */
export function yourAppsLead(foundCount: number, assistant: string, hostNoun: string): string {
  const name = assistant.trim() || "your assistant";
  if (foundCount <= 0) return `We didn't find work apps on this ${hostNoun}. These are the ones teams connect most.`;
  const apps = foundCount === 1 ? "1 work app" : `${foundCount} work apps`;
  return `We found ${apps} on this ${hostNoun}. Connect any you want ${name} to use.`;
}

/** The status line above Continue. */
export function yourAppsStatus(connected: number, company: string): string {
  const where = company.trim() || "your company";
  if (connected <= 0) return `Nothing connected yet. You can connect apps later from Integrations.`;
  return `${connected} connected to ${where}. ${YOUR_APPS_COPY.statusTail}`;
}

/** Domain labels that never name an app on their own. */
const GENERIC_LABELS = new Set(["api", "app", "apps", "mcp", "www", "docs", "developers", "developer", "knowledge-mcp", "global"]);

/**
 * The provider slug a domain stands for: its first label that names
 * something ("linear" for linear.app), or the last one when every label
 * before it is generic ("aws" for api.aws).
 */
function providerSlug(domain: string): string | null {
  const labels = domain.split(".").filter(Boolean);
  const named = labels.slice(0, -1).find((l) => !GENERIC_LABELS.has(l));
  if (named) return named;
  const last = labels.at(-1);
  return labels.length > 1 && last && !GENERIC_LABELS.has(last) ? last : null;
}

function sameApp(connection: StepConnection, app: FoundApp): boolean {
  if (app.native) return connection.provider === app.native;
  const d = connection.domain;
  if (!d) {
    const slug = providerSlug(app.domain);
    return slug !== null && connection.provider === slug;
  }
  return d === app.domain || d.endsWith(`.${app.domain}`) || app.domain.endsWith(`.${d}`);
}

function sortTiles(tiles: AppTile[]): AppTile[] {
  const rank = (t: AppTile): number => KIND_ORDER.indexOf(t.kind);
  return tiles
    .map((tile, i) => ({ tile, i }))
    .sort((a, b) => rank(a.tile) - rank(b.tile) || a.i - b.i)
    .map(({ tile }) => tile);
}

function runNote(run: AppRun, fallback: string): string {
  switch (run.state) {
    case "connecting":
      return run.via === "browser" ? YOUR_APPS_COPY.inBrowser : fallback;
    case "checking-docs":
      return YOUR_APPS_COPY.readingGuide;
    case "failed":
      return run.reason.trim() || YOUR_APPS_COPY.failed;
    case "unsupported":
      return YOUR_APPS_COPY.cantYet;
    default:
      return fallback;
  }
}

/** Group what was found into the view. */
export function yourAppsView(input: YourAppsInput): YourAppsView {
  const connected: ConnectedChip[] = [];
  const ready: AppTile[] = [];
  const notInHq: AppTile[] = [];
  const alsoFound: string[] = [];
  for (const app of input.found) {
    if (app.excluded) {
      alsoFound.push(app.name);
      continue;
    }
    const run = input.runs[app.domain] ?? { state: "idle" };
    if (run.state === "connected" || run.state === "undoing") {
      const installationId = run.state === "undoing" ? run.installationId : (run.installationId ?? null);
      connected.push({
        domain: app.domain,
        name: app.name,
        how: run.state === "connected" ? run.how : "auto",
        connectionId: run.connectionId,
        installationId,
        canUndo: run.state === "undoing" || (run.how === "auto" && installationId !== null),
        undoing: run.state === "undoing",
      });
      continue;
    }
    const existing = input.connections.find((c) => sameApp(c, app));
    if (existing) {
      const installationId = input.installations?.[existing.id] ?? null;
      connected.push({
        domain: app.domain,
        name: app.name,
        how: existing.autoConnected ? "auto" : "team",
        connectionId: existing.id,
        installationId,
        // An earlier first run's automatic connection can be undone by an owner or admin.
        canUndo: existing.autoConnected === true && input.canManage && installationId !== null,
        undoing: false,
      });
      continue;
    }
    const match = input.catalog?.[app.domain] ?? null;
    const base = {
      domain: app.domain,
      name: match?.name?.trim() || app.name,
      kind: app.kind,
      native: app.native,
      entryId: match?.entryId ?? null,
      docsUrl: app.docsUrl,
      run,
    };
    const where = input.evidence(app);
    if (app.native || match) {
      let action: TileAction;
      if (!input.canManage) action = "admin-only";
      else if (app.native === "slack") action = "later";
      else if (app.native) action = "integrations";
      else if (match?.authClass === "key") action = "needs-key";
      else if (match?.authClass === "none") action = "install";
      else action = "connect";
      const note =
        action === "admin-only"
          ? YOUR_APPS_COPY.adminOnly
          : action === "needs-key"
            ? YOUR_APPS_COPY.needsKey
            : action === "later"
              ? YOUR_APPS_COPY.later
              : where;
      ready.push({ ...base, action, note: runNote(run, note) });
      continue;
    }
    const action: TileAction = run.state === "unsupported" || !app.docsUrl ? "not-yet" : input.canManage ? "setup" : "admin-only";
    const note =
      action === "not-yet" ? YOUR_APPS_COPY.cantYet : action === "admin-only" ? YOUR_APPS_COPY.adminOnly : app.kind === "Other" ? where : app.kind;
    notInHq.push({ ...base, action, note: runNote(run, note) });
  }
  const unmatched = Math.max(0, Math.floor(input.unmatched));
  return {
    connected,
    ready: sortTiles(ready),
    notInHq: sortTiles(notInHq),
    alsoFound,
    unmatched,
    foundCount: input.found.length + unmatched,
  };
}

/**
 * The apps to connect with no sign-in as the step opens: owner or admin
 * only, catalog `authClass: "none"`, not connected yet, not undone in this
 * step, never a native provider, and not already running, connected or
 * failed in this step (so a Retry never installs twice). Nothing that needs
 * a credential is here.
 */
export function autoConnectPlan(
  input: Pick<YourAppsInput, "found" | "catalog" | "connections" | "canManage"> & { runs?: Readonly<Record<string, AppRun>> },
  undone: ReadonlySet<string>,
): { domain: string; entryId: string }[] {
  if (!input.canManage || !input.catalog) return [];
  const plan: { domain: string; entryId: string }[] = [];
  for (const app of input.found) {
    if (app.excluded || app.native || undone.has(app.domain)) continue;
    const run = input.runs?.[app.domain];
    if (run && run.state !== "idle") continue;
    const match = input.catalog[app.domain];
    if (!match || match.authClass !== "none" || !match.entryId) continue;
    if (input.connections.some((c) => sameApp(c, app))) continue;
    plan.push({ domain: app.domain, entryId: match.entryId });
  }
  return plan;
}

/**
 * A browser sign-in is under way: a Connect waiting in the browser, or a
 * docs setup (which can end in a sign-in). One at a time, so other sign-ins
 * wait for it.
 */
export function signInRunning(view: Pick<YourAppsView, "ready" | "notInHq">): boolean {
  return [...view.ready, ...view.notInHq].some(
    (t) => (t.run.state === "connecting" && t.run.via === "browser") || t.run.state === "checking-docs",
  );
}

/** The tile's next press opens a browser sign-in (Connect, Set up, or their Try again). */
export function opensSignIn(tile: Pick<AppTile, "action">): boolean {
  return tile.action === "connect" || tile.action === "setup";
}

/** How many apps the step shows as connected (for the status line and the Done summary). */
export function connectedCount(view: YourAppsView): number {
  return view.connected.filter((c) => !c.undoing).length;
}

/** Tiles shown before "Show all" in a group. */
export const READY_SHOWN = 4;
export const NOT_IN_HQ_SHOWN = 4;
/** "Find an app" appears above the groups past this many actionable tiles. */
export const FILTER_AFTER = 12;

/** Apps shown when nothing was found: note takers and project tools first. */
export const FALLBACK_APPS_MAX = 6;

/**
 * "Nothing found" (the scan was skipped, found nothing HQ knows, or this
 * computer has no scan): the signature table's note takers and project tools
 * that the catalog has, as if found, so the step still offers the common ones.
 */
export function fallbackFoundApps(catalog: Readonly<Record<string, CatalogMatch | null>> | null): FoundApp[] {
  if (!catalog) return [];
  const out: FoundApp[] = [];
  for (const kind of ["Meetings", "Work"] as const) {
    for (const s of APP_SIGNATURES) {
      if (out.length >= FALLBACK_APPS_MAX) return out;
      if (s.kind !== kind || s.exclude || s.native || !catalog[s.domain]) continue;
      out.push({ domain: s.domain, name: s.name, kind: s.kind, evidence: { app: false, tools: [] }, docsUrl: null, native: null, excluded: false });
    }
  }
  return out;
}

/** The handoff for "Your apps": its first note taker and project tool, and the rest. */
export function yourAppsHandoff(view: YourAppsView, kinds: Readonly<Record<string, FoundAppKind>>): {
  notes: { name: string; domain: string } | null;
  projects: { name: string; domain: string } | null;
  others: { name: string; domain: string }[];
} {
  const live = view.connected.filter((c) => !c.undoing).map((c) => ({ name: c.name, domain: c.domain, kind: kinds[c.domain] }));
  const notes = live.find((c) => c.kind === "Meetings") ?? null;
  const projects = live.find((c) => c.kind === "Work") ?? null;
  const strip = (c: { name: string; domain: string }) => ({ name: c.name, domain: c.domain });
  return {
    notes: notes ? strip(notes) : null,
    projects: projects ? strip(projects) : null,
    others: live.filter((c) => c !== notes && c !== projects).map(strip),
  };
}

/**
 * The consent sentence "Bring in your context" adds when the scan also lists
 * the work apps (owner default): "It also lists the work apps on this Mac by
 * name, never their passwords or keys, so you can connect them next."
 */
export function yourAppsConsentLine(hostNoun: string): string {
  const where = hostNoun === "Mac" || hostNoun === "PC" ? `this ${hostNoun}` : "this computer";
  return `It also lists the work apps on ${where} by name, never their passwords or keys, so you can connect them next.`;
}
