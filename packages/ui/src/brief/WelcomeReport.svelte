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
    children: Snippet;
  }
  let { ready, progress = null, connect = null, onsetup = null, children }: Props = $props();

  const pct = $derived(progress == null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100));
</script>

<div class="welcome" data-testid="welcome-report">
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
  {#if ready}
    <div class="report" data-testid="welcome-report-ready">
      {@render children()}
    </div>
  {:else if onsetup}
    <section class="card loading" data-testid="welcome-report-setup">
      <h2>{WELCOME_REPORT_NEEDS_ASSISTANT}</h2>
      <button type="button" class="cta" onclick={onsetup} data-testid="welcome-report-setup-button">{WELCOME_REPORT_SETUP_LABEL}</button>
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
        <span class="fill" class:indeterminate={pct === null} style:width={pct === null ? null : `${pct}%`}></span>
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
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 2px;
    background: var(--b-sun, #ffb580);
    transition: width 0.4s ease;
  }
  .fill.indeterminate {
    width: 30%;
    animation: slide 1.4s ease-in-out infinite;
  }
  @keyframes slide {
    from { left: -30%; }
    to { left: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    .fill.indeterminate { animation: none; left: 0; width: 100%; opacity: 0.4; }
  }
</style>
