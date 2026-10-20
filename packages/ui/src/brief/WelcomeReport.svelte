<script module lang="ts">
  export const WELCOME_REPORT_LOADING = "Your welcome report is loading";
  export const WELCOME_REPORT_NEEDS_ASSISTANT = "Your assistant writes your welcome report";
  export const WELCOME_REPORT_SETUP_LABEL = "Set up your assistant";
</script>

<script lang="ts">
  /**
   * The welcome report (US-009): where a new person lands when the visual
   * first run closes. One loading card with a progress bar until the brief
   * job's report is ready, then the Daily Brief page (`children`). With no
   * assistant yet there is no job to wait for, so the card offers the way to
   * set one up instead of a spinner. Same backdrop and type scale as the
   * decision takeover and BriefDawn, so the handoff never shows an empty pane.
   *
   * "Connect your AI apps" (with the suggested integrations under it) is a
   * brief card inside the report: the Daily Brief shows it after its action
   * cards (read from the welcome-ai-apps context set here), and while the
   * report is held, loading or waiting on setup it sits under that card.
   * The card remounts when the report turns ready; its connect session (the
   * owner's, or one kept here) keeps the scan and the sign-ins across that.
   */
  import { onDestroy, untrack, type Snippet } from "svelte";
  import type { YourAppsHost } from "../chat/first-run/your-apps-host.js";
  import type { FoundWorkApps } from "@hq/platform";
  import BriefConnectApps from "./BriefConnectApps.svelte";
  import BriefOpenTool from "./BriefOpenTool.svelte";
  import BriefRise from "./BriefRise.svelte";
  import type { BriefOpenToolAction } from "./brief-open-tool.js";
  import { riseMinHeight, welcomeRiseSources, type RiseCompany, type RiseLayout } from "./brief-rise.js";
  import { setWelcomeAiApps, type WelcomeAiApps, type WelcomeOpenHarness } from "./welcome-ai-apps.js";
  import { WelcomeConnectSession } from "./welcome-connect-session.svelte.js";

  interface Props {
    /** The report is ready: the brief page replaces the loading card. */
    ready: boolean;
    /** The job's progress (0 to 1) while it runs; null shows a moving bar. */
    progress?: number | null;
    /** The suggested integrations' inputs; null leaves that group out (flag off or no host). */
    connect?: {
      host: YourAppsHost;
      /** The company the apps connect to; null still shows the suggestions and offers a new company first. */
      company: { uid: string; name: string } | null;
      onopenintegrations?: (companyUid: string) => void;
      /** With no company: opens the new-company flow; resolves with its uid, or null when closed. */
      onnewcompany?: (() => Promise<string | null>) | null;
    } | null;
    /** The owner's connect session; without one the report keeps its own while mounted. */
    session?: WelcomeConnectSession | null;
    /** No assistant to write the report yet: the card offers setting one up. */
    onsetup?: (() => void) | null;
    /**
     * Who made the report. Still accepted from the shell and not drawn:
     * nothing sits above the brief (US-019).
     */
    madeBy?: { name: string; onmeet: () => void };
    /** The "Connect your AI apps" card inputs; null leaves it out. */
    aiApps?: {
      detect: () => Promise<FoundWorkApps | null>;
      cli: { claudeCode: boolean; codex: boolean };
      /** Connector id whose local HQ Anywhere install is on. Copy stays on every row. */
      anywhereOnId?: string | null;
      /** Opens HQ's AI apps settings from the card; null leaves that link out. */
      onopenaiapps?: (() => void) | null;
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
    /** Opens HQ in the harness a welcome action names; null shows no such button. */
    openHarness?: WelcomeOpenHarness | null;
    /** Companies in this brief. None is a getting-started rise, never a company gate. */
    companies?: readonly RiseCompany[];
    /** Frozen rise time for stills. Absent: the sunrise runs while the brief builds. */
    elapsed?: number | null;
    /**
     * The app theme (the shell passes it from its appearance setting). The
     * sunrise stays dark in both; the setup and held cards and the brief
     * follow this. Null reads the root's forced theme, else dark.
     */
    theme?: "dark" | "light" | null;
    children: Snippet;
  }
  let {
    ready,
    progress = null,
    connect = null,
    onsetup = null,
    aiApps = null,
    session: given = null,
    blocked = null,
    openTool = null,
    openHarness = null,
    companies = [],
    elapsed = null,
    theme = null,
    children,
  }: Props = $props();

  const local = untrack(() => given) ? null : new WelcomeConnectSession();
  onDestroy(() => local?.dispose());
  const session = $derived(given ?? (local as WelcomeConnectSession));

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

  const riseSources = $derived(welcomeRiseSources(companies));
  /** The count line the rise has on screen. */
  let riseCount = $state<string | null>(null);
  /** The last count the rise showed before the brief, so the brief says the same thing. Only when the rise ran here. */
  let runStats = $state<string | null>(null);
  $effect(() => {
    if (rising) runStats = riseCount;
  });
  /** The connect section's inputs: one scan for the AI apps and the suggested integrations. */
  const connectApps = $derived.by((): WelcomeAiApps | null => {
    if (!aiApps && !connect) return null;
    const host = connect?.host;
    return {
      detect: aiApps?.detect ?? (() => (host ? host.detect() : Promise.resolve(null))),
      cli: aiApps?.cli ?? { claudeCode: false, codex: false },
      anywhereOnId: aiApps?.anywhereOnId ?? null,
      onopenaiapps: aiApps?.onopenaiapps ?? null,
      suggest: connect
        ? {
            host: connect.host,
            company: connect.company,
            onopenintegrations: connect.onopenintegrations,
            onnewcompany: connect.onnewcompany ?? null,
          }
        : null,
      session,
      runStats,
    };
  });
  /** How many welcome editions show the open action themselves; while one does, the report's bar stays out. */
  let openToolClaims = $state(0);
  setWelcomeAiApps({
    get current() {
      return connectApps;
    },
    get openTool() {
      return openTool;
    },
    get openHarness() {
      return openHarness;
    },
    claimOpenTool() {
      untrack(() => (openToolClaims += 1));
      let held = true;
      return () => {
        if (held) untrack(() => (openToolClaims -= 1));
        held = false;
      };
    },
  });

  const pct = $derived(progress == null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100));
  const rising = $derived(!ready && !onsetup && !blocked);

  /** Keeps the sunrise up for the cross-fade after the report is ready. The loading test id is gone at once. */
  let holdRise = $state(false);
  $effect(() => {
    if (rising) {
      holdRise = true;
      return;
    }
    if (!holdRise) return;
    const timer = setTimeout(() => {
      holdRise = false;
    }, 600);
    return () => clearTimeout(timer);
  });

  /** Where the rise put its invite slot and how tall its progress block is, at the current size. */
  let riseGeo = $state<RiseLayout | null>(null);
  /** The open bar under the rise and the connect strip in its invite slot. */
  let footHeight = $state(0);
  let connectHeight = $state(0);
  const riseFoot = $derived(rising ? footHeight : 0);
  /** Below this the page scrolls instead of the strip, the progress and the bar overlapping. */
  const riseFloor = $derived(riseMinHeight(connectHeight + (riseGeo?.readout ?? 0) + riseFoot));
  /**
   * The floor the page uses, a frame after the content sets it. The heights it comes from are measured
   * inside the stage, so resizing the stage in the same frame leaves the stage's own resize undelivered
   * (WebKit reports a ResizeObserver loop when the strip's rows arrive or a font loads).
   */
  let appliedFloor = $state(riseMinHeight(0));
  $effect(() => {
    const next = riseFloor;
    const frame = requestAnimationFrame(() => {
      appliedFloor = next;
    });
    return () => cancelAnimationFrame(frame);
  });
</script>

<div
  class="welcome"
  class:rising
  data-testid="welcome-report"
  data-theme={theme === "light" || theme === "dark" ? theme : undefined}
  style:min-height={rising ? `max(100%, ${appliedFloor}px)` : undefined}
  style:--rise-pad={riseGeo ? `${riseGeo.pad}px` : undefined}
  style:--rise-invite-top={riseGeo ? `${riseGeo.inviteTop}px` : undefined}
>
  <!-- Nothing sits above the sunrise or the brief (US-019): while the report loads the open action follows the
       sunrise, the welcome edition carries its own, and a brief without one gets the bar under it. -->
  {#if ready}
    <div class="report reveal" data-testid="welcome-report-ready">
      {@render children()}
      {#if openTool && !openToolClaims}
        <BriefOpenTool label={openTool.label} detail={openTool.detail} busy={openTool.busy} error={openTool.error} onopen={openTool.onopen} />
      {/if}
    </div>
  {/if}
  {#if rising || holdRise}
    <section class="rise-hold" class:out={!rising} data-testid={rising ? "welcome-report-loading" : undefined} aria-busy={rising ? "true" : undefined}>
      <BriefRise
        sources={riseSources}
        {companies}
        {elapsed}
        {theme}
        readyAt={null}
        foot={riseFoot}
        bind:geometry={riseGeo}
        bind:count={riseCount}
        meter={rising ? { now: pct, label: WELCOME_REPORT_LOADING } : null}
      />
    </section>
  {/if}
  {#if !ready}
    {#if onsetup}
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
    {/if}
    <!-- After the rise or the setup card: nothing sits above the brief's own status. -->
    {#if openTool}
      <div class="after-rise" data-testid="welcome-report-open-tool" bind:clientHeight={footHeight}>
        <BriefOpenTool label={openTool.label} detail={openTool.detail} busy={openTool.busy} error={openTool.error} onopen={openTool.onopen} />
      </div>
    {/if}
    <!-- Under the status, outside its branches, so a status change (loading to held) keeps a Connect in progress. -->
    {#if connectApps}
      <div class="held-connect" data-testid="welcome-report-connect" bind:clientHeight={connectHeight}>
        <BriefConnectApps
          detect={connectApps.detect}
          cli={connectApps.cli}
          suggest={connectApps.suggest}
          session={connectApps.session}
          anywhereOnId={connectApps.anywhereOnId ?? null}
          quiet={rising}
          theme={rising ? "dark" : theme}
        />
      </div>
    {/if}
  {/if}
</div>

<style>
  .welcome {
    position: relative;
    min-height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px;
    background: var(--b-bg, #0d0d0f);
    font-family: var(--font-ui, "Geist", system-ui, sans-serif);
    color: var(--b-t1, rgba(255, 255, 255, 0.95));
  }
  /* Light app theme: the Daily Brief's own light ground and ink (brief.css), so the report matches the brief it turns into. */
  .welcome[data-theme="light"] {
    --b-bg: #ebebee;
    --b-card: #fff;
    --b-t1: rgba(17, 17, 17, 0.92);
    --b-t2: rgba(17, 17, 17, 0.66);
  }
  .welcome[data-theme="light"]:not(.rising) {
    --open-tool-detail: rgba(17, 17, 17, 0.66);
  }
  /* The sunrise stays dark in both themes: its open bar keeps the dark ink. */
  .welcome.rising {
    --b-bg: #1b1b1e;
    --open-tool-detail: rgba(255, 255, 255, 0.62);
  }
  /* The open action under the sunrise keeps the rise's side inset. */
  .after-rise {
    padding: 20px var(--rise-pad, 52px) 28px;
  }
  /* The stage fills the window; below the rise's floor (min-height set inline from its content) the page scrolls. */
  .welcome.rising {
    position: relative;
    gap: 0;
    padding: 0;
    min-height: max(100%, 560px);
  }
  .rise-hold {
    position: relative;
    flex: 1;
    min-height: 560px;
  }
  /* While rising the stage fills the whole report, so the open bar under it sits on the sky, not on a plain strip. */
  .welcome.rising .rise-hold {
    position: absolute;
    inset: 0;
    min-height: 0;
  }
  .welcome.rising .after-rise {
    position: relative;
    z-index: 4;
    margin-top: auto;
  }
  .rise-hold.out {
    position: absolute;
    inset: 0;
    z-index: 2;
    min-height: 0;
    pointer-events: none;
    animation: rise-out 0.6s ease both;
  }
  @keyframes rise-out {
    from { opacity: 1; }
    to { opacity: 0; }
  }
  /* The invite slot BriefRise reports at this size: over the sea, under the headline. */
  .welcome.rising .held-connect {
    position: absolute;
    left: var(--rise-pad, 52px);
    top: var(--rise-invite-top, 300px);
    z-index: 4;
    width: min(485px, calc(100% - 2 * var(--rise-pad, 52px)));
  }
  .report.reveal {
    animation: brief-in 0.6s ease both;
  }
  @keyframes brief-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  /* The card brings its own top margin for the brief body; the column gap spaces it here. */
  .held-connect :global([data-testid="connect-ai-apps-card"]) {
    margin-top: 0;
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
  @media (prefers-reduced-motion: reduce) {
    .report.reveal, .rise-hold.out { animation: none; }
  }
</style>
