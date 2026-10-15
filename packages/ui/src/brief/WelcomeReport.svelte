<script module lang="ts">
  export const WELCOME_REPORT_LOADING = "Your welcome report is loading";
</script>

<script lang="ts">
  /**
   * The welcome report (US-009): where a new person lands when the visual
   * first run closes. First the card that connects the apps the launch scan
   * found (when there is one), then the report itself: one loading card with
   * a progress bar until the brief job's report is ready, then the Daily
   * Brief page (`children`). Same backdrop and type scale as the decision
   * takeover and BriefDawn, so the handoff never shows an empty pane.
   */
  import type { Snippet } from "svelte";
  import WelcomeConnectCard from "../chat/first-run/WelcomeConnectCard.svelte";
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
    } | null;
    children: Snippet;
  }
  let { ready, progress = null, connect = null, children }: Props = $props();

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
      />
    {/key}
  {/if}
  {#if ready}
    <div class="report" data-testid="welcome-report-ready">
      {@render children()}
    </div>
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
    background: #1b1b1e;
    font-family: var(--font-ui, "Geist", system-ui, sans-serif);
    color: rgba(255, 255, 255, 0.92);
  }
  .report {
    flex: 1;
    min-height: 0;
  }
  .card {
    border-radius: 22px;
    background: #121216;
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
    color: rgba(255, 255, 255, 0.95);
  }
  .bar {
    position: relative;
    width: min(360px, 80%);
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.1);
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 2px;
    background: #ffb580;
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
