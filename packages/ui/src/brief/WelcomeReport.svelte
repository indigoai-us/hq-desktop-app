<script module lang="ts">
  export const WELCOME_REPORT_LOADING = "Your welcome report is loading";
  export const WELCOME_REPORT_NEEDS_ASSISTANT = "Your assistant writes your welcome report";
  export const WELCOME_REPORT_SETUP_LABEL = "Set up your assistant";
</script>

<script lang="ts">
  /**
   * The welcome report (US-009): where a new person lands when the visual
   * first run closes. First the card that connects the apps the launch scan
   * found (when there is one), then the report itself: one loading card with
   * a progress bar until the brief job's report is ready, then the Daily
   * Brief page (`children`). With no assistant yet there is no job to wait
   * for, so the card offers the way to set one up instead of a spinner.
   * Same backdrop and type scale as the decision
   * takeover and BriefDawn, so the handoff never shows an empty pane.
   */
  import type { Snippet } from "svelte";
  import WelcomeConnectCard, { type WelcomeConnectMemory } from "../chat/first-run/WelcomeConnectCard.svelte";
  import type { YourAppsHost } from "../chat/first-run/your-apps-host.js";
  import type { FoundWorkApps } from "@hq/platform";
  import ConnectAiAppsCard from "./ConnectAiAppsCard.svelte";
  import BriefOpenTool from "./BriefOpenTool.svelte";
  import type { BriefOpenToolAction } from "./brief-open-tool.js";
  import { assistantNameInSentence } from "./brief-action-cards.js";

  interface Props {
    /** The report is ready: the brief page replaces the loading card. */
    ready: boolean;
    /** The job's progress (0 to 1) while it runs; null shows a moving bar. */
    progress?: number | null;
    /** The connect card's inputs; null leaves it out (flag off, no host or no company). */
    connect?: {
      host: YourAppsHost;
      company: { uid: string; name: string };
      assistantName: string;
      onopenintegrations?: (companyUid: string) => void;
      /** The card's per-company memory, kept across remounts. */
      memory?: WelcomeConnectMemory;
    } | null;
    /** No assistant to write the report yet: the card offers setting one up. */
    onsetup?: (() => void) | null;
    /**
     * Who made the report: the assistant and a way to open its DM. Left out
     * (no assistant, or no landed report on screen), the line is not shown.
     */
    madeBy?: { name: string; onmeet: () => void };
    /** The "Connect your AI apps" card inputs; null leaves it out. */
    aiApps?: {
      detect: () => Promise<FoundWorkApps | null>;
      cli: { claudeCode: boolean; codex: boolean };
      /** Connector id whose HQ install succeeded. That row has no Copy prompt. */
      installedId?: string | null;
    } | null;
    /**
     * The job is held back until the assistant can take it (not running, no
     * model connected): the brief check's own sentence and fix button, under
     * the report's heading, so the page still says the report is coming.
     */
    blocked?: { message: string; label: string; onfix: () => Promise<string | null> | void } | null;
    /**
     * Opens the coding tool chosen with Continue. Null on Skip and on any
     * welcome report that did not prepare a tool.
     */
    openTool?: BriefOpenToolAction | null;
    children: Snippet;
  }
  let { ready, progress = null, connect = null, onsetup = null, madeBy, aiApps = null, blocked = null, openTool = null, children }: Props = $props();

  /** What the fix said when it could not finish (the brief page's own copy), as on the run bar. */
  let fixError = $state<string | null>(null);
  let fixing = $state(false);
  async function runFix(): Promise<void> {
    if (!blocked || fixing) return;
    fixing = true;
    fixError = null;
    try {
      fixError = (await blocked.onfix()) ?? null;
    } catch (err) {
      console.warn("[welcome-report] fix failed", err);
      fixError = "Something went wrong.";
    } finally {
      fixing = false;
    }
  }

  const pct = $derived(progress == null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100));
</script>

<div class="welcome" data-testid="welcome-report">
  {#if openTool}
    <BriefOpenTool label={openTool.label} detail={openTool.detail} busy={openTool.busy} error={openTool.error} onopen={openTool.onopen} />
  {/if}
  {#if connect}
    {#key connect.company.uid}
      <WelcomeConnectCard
        host={connect.host}
        company={connect.company}
        assistantName={connect.assistantName}
        onopenintegrations={connect.onopenintegrations}
        memory={connect.memory}
      />
    {/key}
  {/if}
  {#if aiApps}
    <ConnectAiAppsCard detect={aiApps.detect} cli={aiApps.cli} installedId={aiApps.installedId ?? null} />
  {/if}
  {#if ready}
    <div class="report" data-testid="welcome-report-ready">
      {#if madeBy}
        <p class="made-by" data-testid="welcome-report-made-by">
          <span>{madeBy.name} made this report.</span>
          <button type="button" data-testid="welcome-report-meet" onclick={() => madeBy.onmeet()}>Meet {assistantNameInSentence(madeBy.name)}</button>
        </p>
      {/if}
      {@render children()}
    </div>
  {:else if onsetup}
    <section class="card loading" data-testid="welcome-report-setup">
      <h2>{WELCOME_REPORT_NEEDS_ASSISTANT}</h2>
      <button type="button" class="cta" onclick={onsetup} data-testid="welcome-report-setup-button">{WELCOME_REPORT_SETUP_LABEL}</button>
    </section>
  {:else if blocked}
    <section class="card loading" data-testid="welcome-report-blocked">
      <h2>{WELCOME_REPORT_NEEDS_ASSISTANT}</h2>
      <p class="reason">{blocked.message}</p>
      <button type="button" class="cta" onclick={runFix} disabled={fixing} data-testid="welcome-report-blocked-fix">{blocked.label}</button>
      {#if fixError}<p class="reason" data-testid="welcome-report-blocked-error">{fixError}</p>{/if}
    </section>
  {:else}
    <section class="card loading" data-testid="welcome-report-loading" aria-busy="true">
      <h2>{WELCOME_REPORT_LOADING}</h2>
      <div
        class="bar"
        role="progressbar"
        aria-label={WELCOME_REPORT_LOADING}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <span class="fill" class:indeterminate={pct === null} style:--fill={pct === null ? null : pct / 100}></span>
      </div>
    </section>
  {/if}
</div>

<style>
  .welcome {
    min-height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px;
    background: var(--b-bg, #1b1b1e);
    font-family: var(--font-ui, "Geist", system-ui, sans-serif);
    color: var(--b-t1, rgba(255, 255, 255, 0.95));
  }
  .report {
    flex: 1;
    min-height: 0;
  }
  .made-by {
    margin: 0 0 12px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.72);
  }
  .made-by button {
    font: inherit;
    font-size: 12px;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.06);
    color: inherit;
    cursor: pointer;
    transition: opacity 120ms cubic-bezier(0.25, 1, 0.5, 1);
  }
  .made-by button:active {
    opacity: 0.7;
  }
  .card {
    border-radius: var(--b-r, 22px);
    background: var(--b-card, #222226);
  }
  .loading {
    padding: 48px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    text-align: center;
  }
  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--b-t1, rgba(255, 255, 255, 0.95));
  }
  .reason {
    margin: 0;
    font-size: 13px;
    color: var(--b-t2, rgba(255, 255, 255, 0.6));
  }
  .cta {
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    border: 0;
    border-radius: 999px;
    padding: 8px 18px;
    cursor: pointer;
    color: var(--b-bg, #1b1b1e);
    background: var(--b-sun, #ffb580);
  }
  .bar {
    position: relative;
    width: min(360px, 80%);
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    background: var(--b-line, rgba(255, 255, 255, 0.07));
  }
  /* Fill ratio via --fill (0..1) + scaleX, as ProjectRow.svelte does, so
     the bar moves on the compositor; the track clips + rounds it. */
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: 100%;
    border-radius: 2px;
    background: var(--b-sun, #ffb580);
    transform: scaleX(var(--fill, 0));
    transform-origin: left center;
    transition: transform 0.4s ease;
  }
  /* A 30%-wide bar sliding across: translateX is relative to its own width,
     so -100% starts it just off the left edge and 333% just off the right. */
  .fill.indeterminate {
    width: 30%;
    transform: translateX(-100%);
    animation: slide 1.4s ease-in-out infinite;
  }
  @keyframes slide {
    from { transform: translateX(-100%); }
    to { transform: translateX(333%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .fill.indeterminate { animation: none; transform: none; width: 100%; opacity: 0.4; }
    .made-by button { transition: none; }
  }
</style>
