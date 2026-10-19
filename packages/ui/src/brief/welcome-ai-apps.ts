/**
 * The welcome report hands its "Connect your AI apps" inputs to the brief
 * page it wraps, so the Daily Brief can show the section inside the report
 * body. The brief page is passed in as a snippet, so a context reaches it
 * without threading a prop through BriefRailHost. Outside the welcome report
 * there is no context and the brief shows no section.
 */
import { getContext, setContext } from "svelte";
import type { FoundWorkApps } from "@hq/platform";
import type { YourAppsHost } from "../chat/first-run/your-apps-host.js";
import type { WelcomeConnectSession } from "./welcome-connect-session.svelte.js";
import type { BriefOpenToolAction } from "./brief-open-tool.js";
import type { WelcomeHarnessId } from "./brief-welcome-contract.js";

/**
 * What the connect section did for one company, kept by its owner across
 * remounts: whether the auto-connect ran, and the apps the person undid
 * (never auto-connected again).
 */
export interface WelcomeConnectMemory {
  autoRan: boolean;
  undone: Set<string>;
}

/** The suggested-integrations group's inputs: the "Your apps" host and where the apps connect. */
export interface WelcomeSuggest {
  host: YourAppsHost;
  /** The company the apps connect to; null shows the suggestions and offers a new company first. */
  company: { uid: string; name: string } | null;
  /** "Connect from Integrations" rows open the company's Integrations page. */
  onopenintegrations?: (companyUid: string) => void;
  /**
   * With no company: opens the new-company flow. Resolves with the new
   * company's uid, or null when the person closed it without one.
   */
  onnewcompany?: (() => Promise<string | null>) | null;
}

export interface WelcomeAiApps {
  /** The launch scan (names only), shared by both groups. */
  detect: () => Promise<FoundWorkApps | null>;
  /** Claude Code and the Codex CLI, as the launch detection found them. */
  cli: { claudeCode: boolean; codex: boolean };
  /** Connector id whose local HQ Anywhere install is on. Copy stays on every row. */
  anywhereOnId?: string | null;
  /** The suggested integrations; null leaves the group out (flag off or no host). */
  suggest?: WelcomeSuggest | null;
  /** The owner's connect session: the scan, the runs and the memory, kept across remounts. */
  session?: WelcomeConnectSession | null;
  /** The count line the report's sunrise reveal ends on, carried into the welcome edition. */
  runStats?: string | null;
}

/**
 * The company the report's apps connect to: the tenant, else the most
 * recently used company, else the only one, else the first in the roster.
 * Null only when there is no company at all, the one case that asks for a
 * new company first.
 */
export function welcomeAppsCompanyFor<T extends { uid: string }>(
  roster: readonly T[],
  tenantId: string | null,
  recentIds: readonly string[],
): T | null {
  const byUid = (uid: string | null): T | undefined => (uid ? roster.find((co) => co.uid === uid) : undefined);
  const tenant = byUid(tenantId);
  if (tenant) return tenant;
  for (const uid of recentIds) {
    const recent = byUid(uid);
    if (recent) return recent;
  }
  return roster[0] ?? null;
}

/**
 * Opens HQ in the harness a welcome action names, with the action's prompt.
 * Never the tool picked at Continue and never the brief's saved engine.
 */
export interface WelcomeOpenHarness {
  /** The harnesses this host can open; an action naming another one shows no button. */
  harnesses: readonly WelcomeHarnessId[];
  /** Resolves with a plain line when the harness could not open, else null. */
  open(harness: WelcomeHarnessId, prompt: string): Promise<string | null>;
}

const KEY = Symbol("welcome-ai-apps");

/** What the welcome report shares with the brief inside it. Read through getters, so a change reaches the brief. */
export interface WelcomeAiAppsSource {
  readonly current: WelcomeAiApps | null;
  /** The report's "Open <tool>" action, for the edition's open-in-harness component. */
  readonly openTool?: BriefOpenToolAction | null;
  /** Opens HQ in a named harness, for the edition's "Open HQ in <harness>" action. */
  readonly openHarness?: WelcomeOpenHarness | null;
  /**
   * The edition shows the open action itself, so the report drops its own
   * bar. Returns the release, called when the edition no longer shows it.
   */
  claimOpenTool?: () => () => void;
}

export function setWelcomeAiApps(source: WelcomeAiAppsSource): void {
  setContext(KEY, source);
}

export function getWelcomeAiApps(): WelcomeAiAppsSource | undefined {
  return getContext(KEY);
}
