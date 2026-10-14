/**
 * Note taker and Project management (visual first run, slice 5): two screens
 * with one pattern. Each lists the integrations catalog's apps of one kind
 * for the company picked on "Your team", connects one inline, or skips.
 *
 * The catalog (`GET /v1/integrations/factory/catalog`, the same read as the
 * company Integrations page) has NO category field. The apps are sorted into
 * the two screens on this side, with the presentation categories the
 * Integrations page already uses (`deriveCategory`: "Meetings" for note
 * takers, "Work" for project management).
 *
 * Pure: the catalog filter, the screen copy, and the one-connect-at-a-time
 * runner. The host starts the connect (OAuth in the browser, or an install
 * for an app that needs no sign-in, as the bot connection cards do) and
 * answers once the company's connection list shows it.
 */

import type { IntegrationCatalogEntry } from "@hq/platform";

import { deriveCategory } from "../../company/files-connect/integration-apps.js";
import type { FirstRunAppHandoff } from "./visual-first-run.js";

export type FirstRunAppKind = "notes" | "projects";

/** The `deriveCategory` value each screen lists. */
export const APP_KIND_CATEGORY: Record<FirstRunAppKind, string> = {
  notes: "Meetings",
  projects: "Work",
};

export interface FirstRunApp {
  /** Normalized website domain: the handle for connect and for the logo. */
  domain: string;
  name: string;
  description: string;
  entryId: string | null;
  /** "key" apps need a pasted access key, which this screen does not take. */
  authClass: "none" | "oauth" | "key" | null;
}

/** Apps shown before the rest wait behind "Show more". The card never scrolls. */
export const APPS_SHOWN_MAX = 6;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function domainOf(raw: string): string | null {
  const domain = raw
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain) ? domain : null;
}

/** The catalog answer's entries, as the server sends them; [] for anything else. */
export function catalogEntries(json: unknown): IntegrationCatalogEntry[] {
  const root = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  const entries = Array.isArray(root?.entries) ? root.entries : Array.isArray(json) ? json : [];
  return entries.filter((e): e is IntegrationCatalogEntry => !!e && typeof e === "object");
}

/**
 * The catalog's apps for one screen: filtered by category on this side (the
 * catalog has none), one per domain, the ones that connect without a key
 * first, then by name.
 */
export function appsForKind(entries: readonly IntegrationCatalogEntry[], kind: FirstRunAppKind): FirstRunApp[] {
  const want = APP_KIND_CATEGORY[kind];
  const seen = new Set<string>();
  const apps: FirstRunApp[] = [];
  for (const entry of entries) {
    const domain = domainOf(text(entry.domain));
    const name = text(entry.name) || (domain ? domain.split(".")[0]! : "");
    if (!domain || !name || seen.has(domain)) continue;
    if (deriveCategory(domain, name) !== want) continue;
    seen.add(domain);
    const auth = entry.authClass;
    apps.push({
      domain,
      name,
      description: text(entry.description),
      entryId: text(entry.entryId) || null,
      authClass: auth === "none" || auth === "oauth" || auth === "key" ? auth : null,
    });
  }
  const rank = (app: FirstRunApp): number => (app.authClass === "key" ? 1 : 0);
  return apps.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export interface AppStepCopy {
  kicker: string;
  lead: string;
  em: string;
  copy: string;
  empty: string;
}

export function appStepCopy(kind: FirstRunAppKind, assistant: string, company: string): AppStepCopy {
  const name = assistant.trim() || "your assistant";
  const where = company.trim() || "your company";
  return kind === "notes"
    ? {
        kicker: "Note taker",
        lead: "Bring in your",
        em: "meeting notes.",
        copy: `Connect the app that takes your meeting notes, so ${name} can use what was said. It connects to ${where}.`,
        empty: "No note taker apps are in the catalog yet. You can skip this and connect one later.",
      }
    : {
        kicker: "Project management",
        lead: "Connect your",
        em: "project tracker.",
        copy: `Connect where ${where} tracks its work, so ${name} can see projects and tasks.`,
        empty: "No project management apps are in the catalog yet. You can skip this and connect one later.",
      };
}

export const APP_COPY = {
  connect: "Connect",
  connecting: "Connecting…",
  waiting: "Finish in your browser…",
  connected: "Connected",
  needsKey: "Needs an access key. Connect it later from Integrations.",
  loading: "Loading apps…",
  skip: "Skip",
  showMore: "Show more",
} as const;

/** The Done summary line for one screen. */
export function appSummary(app: FirstRunAppHandoff | null | undefined, passed: boolean): string {
  if (app) return `${app.name}, connected`;
  return passed ? "Skipped" : "Not set up";
}

// ── the catalog read ───────────────────────────────────────────────────────

export type AppCatalogResult =
  | { ok: true; apps: FirstRunApp[]; connected: readonly string[] }
  | { ok: false; reason: string; retry: boolean };

/** Where the screen's list stands. */
export type AppCatalogState = { state: "loading" } | (AppCatalogResult & { state: "loaded" });

// ── one connect at a time ──────────────────────────────────────────────────

export type AppConnectResult = { ok: true } | { ok: false; reason: string; retry: boolean };

/** Where connecting stands, as the screen shows it. */
export type AppConnectState =
  | { state: "idle" }
  | { state: "connecting"; domain: string }
  | { state: "connected"; app: FirstRunApp }
  | { state: "failed"; domain: string; reason: string; retry: boolean };

export interface AppConnectRunner {
  /**
   * Connect `app`. While one runs every press does nothing, and nothing runs
   * once an app is connected: one app per screen.
   */
  connect(app: FirstRunApp): void;
  /** Connect the failed app again. */
  retry(): void;
  current(): AppConnectState;
}

export const APP_CONNECT_FAILURE = "Could not connect that app. Try again.";

/**
 * `run` resolves once the app is connected (the host waits for the
 * connection list to show it) or fails. `onchange` gets "connecting"
 * synchronously, on the same frame as the press. The screen never waits on
 * it: Next and Skip stay live while it runs.
 */
export function createAppConnectRunner(
  run: (app: FirstRunApp) => Promise<AppConnectResult>,
  onchange: (state: AppConnectState) => void,
): AppConnectRunner {
  let state: AppConnectState = { state: "idle" };
  let lastApp: FirstRunApp | null = null;
  const set = (next: AppConnectState): void => {
    state = next;
    onchange(next);
  };
  function connect(app: FirstRunApp): void {
    if (state.state === "connecting" || state.state === "connected") return;
    if (app.authClass === "key") return;
    lastApp = app;
    set({ state: "connecting", domain: app.domain });
    void Promise.resolve()
      .then(() => run(app))
      .then(
        (result) =>
          set(
            result.ok
              ? { state: "connected", app }
              : { state: "failed", domain: app.domain, reason: result.reason, retry: result.retry },
          ),
        (err: unknown) => {
          console.warn("[hq-desktop] first-run app connect threw:", err);
          set({ state: "failed", domain: app.domain, reason: APP_CONNECT_FAILURE, retry: true });
        },
      );
  }
  return {
    connect,
    retry() {
      if (state.state === "failed" && lastApp) {
        const app = lastApp;
        set({ state: "idle" });
        connect(app);
      }
    },
    current: () => state,
  };
}
