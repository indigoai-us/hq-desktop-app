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
  /** The section's per-company memory, kept across remounts. */
  memory?: WelcomeConnectMemory;
}

export interface WelcomeAiApps {
  /** The launch scan (names only), shared by both groups. */
  detect: () => Promise<FoundWorkApps | null>;
  /** Claude Code and the Codex CLI, as the launch detection found them. */
  cli: { claudeCode: boolean; codex: boolean };
  /** The suggested integrations; null leaves the group out (flag off or no host). */
  suggest?: WelcomeSuggest | null;
}

const KEY = Symbol("welcome-ai-apps");

/** Read through `current`, so a change in the report's inputs reaches the brief. */
export function setWelcomeAiApps(source: { readonly current: WelcomeAiApps | null }): void {
  setContext(KEY, source);
}

export function getWelcomeAiApps(): { readonly current: WelcomeAiApps | null } | undefined {
  return getContext(KEY);
}
