<script lang="ts">
  /**
   * SetupChannelIntro — the welcome experience at the top of the synthetic
   * #setup support channel in the live desktop shell: a wallpaper hero with
   * the three launch actions (Claude Code / Codex / Grok Build), then ghost
   * rows for the getting-started guide, the free book, the weekly onboarding
   * training, and the docs, closed by the support note.
   *
   * REUSE, do not reimplement: launch paths live in
   * `createLaunchActions` (settings/launch-actions.ts) — the same cascade
   * the title-bar Launch menu uses, with `/setup` prefilled from
   * `SETUP_LAUNCH_COMMANDS`. The HQ folder path comes from
   * `settings.getSetupStatus`. Copy + links come from `setup-channel.ts`
   * (shared with the classic messaging surface); art from
   * `setup-welcome-art.ts`. The live message thread + composer below this
   * header are the shell's standard ChannelConversation pipeline with
   * channelId "setup" — this component owns only the intro. Lifecycle cards
   * (`create_company`, `companies_summary`) render in that conversation.
   * Do not group #setup by threadKey or invent per-company threads here.
   *
   * External links never navigate the webview: every resource row calls
   * `onopenurl` (host → system browser) and cancels the anchor default.
   *
   * NATIVE SETUP RUN: with a host `setupRun` API (apps/sync provides one on
   * `extraPages.sessions`), Run Setup drives `/setup` inside this hero — a
   * four-step card (`SetupRunCard`), the agent's latest plain sentence, and
   * each question as a native card — instead of opening the Sessions page.
   * Interpretation lives in `setup-run.ts`; the run is remembered in
   * localStorage so a relaunch offers "Continue setup (N of 4)".
   */
  import { onMount } from "svelte";
  import type { SettingsApi, ShellApi } from "@hq/platform";
  import {
    createLaunchActions,
    type LaunchKey,
  } from "../settings/launch-actions";
  import {
    SETUP_ADVANCED_LABEL,
    SETUP_ADVANCED_TOOLS_NOTE,
    SETUP_DEEP_LINK_PROMPT,
    SETUP_HOSTED_AGENT_NOTE,
    SETUP_LAUNCH_COMMANDS,
    SETUP_RESOURCES,
    SETUP_RUN_LABEL,
    SETUP_ROSTER_FAILED,
    SETUP_SUPPORT_NOTE,
    setupCompanies,
    setupCompanyActionLabel,
    setupHeroFor,
    setupRosterLoading,
    type SetupResourceKind,
    type SetupRosterStatus,
  } from "./setup-channel";
  import { SETUP_HERO_ART } from "./setup-welcome-art";
  import SetupRunCard, { type SetupRunCardMode } from "./SetupRunCard.svelte";
  import {
    clearSetupRunRecord,
    interpretSetupRun,
    loadSetupRunRecord,
    saveSetupRunRecord,
    type SetupRunApi,
    type SetupRunPermissionDecision,
    type SetupRunSnapshot,
  } from "./setup-run";
  import type { EntryPointResult } from "./lifecycle-entry-points";
  import type { Workspace } from "./workspaces";

  interface Props {
    /** Platform seam slices (see @hq/platform PlatformAdapter). */
    settings: Pick<SettingsApi, "getSetupStatus">;
    shell: Pick<
      ShellApi,
      | "detectAiTools"
      | "openClaudeCodeLink"
      | "launchClaudeCode"
      | "launchCodexWorkspace"
      | "launchCliInTerminal"
    >;
    /** Open an external URL via the host (system browser). */
    onopenurl?: (url: string) => void;
    /** Present only when the host provides in-app Sessions. Opens a draft, never sends. */
    onopensessions?: () => void;
    /**
     * The shell's company roster. When it holds any company (whatever its
     * sync state), the hero leads with "Open <Company>" / "Continue setup for
     * <Company>" instead of the create-a-company prompt.
     */
    companies?: readonly Workspace[] | null;
    /** Open (or continue setting up) one of the roster's companies. */
    onopencompany?: (company: Workspace) => void;
    /**
     * Secondary "Create another company" entry point, shown only next to an
     * existing company. Same host callback the sidebar uses; a failure reason
     * renders inline where the control was.
     */
    oncreatecompany?: (() => Promise<EntryPointResult>) | null;
    /**
     * Where the shell is in loading `companies` for this session. While
     * `loading` (and no company is known yet) the hero shows a quiet
     * "Loading your workspace…" line instead of the create prompt; `failed`
     * adds a one-line retry under the create prompt. Omitted = ready.
     */
    rosterStatus?: SetupRosterStatus | null;
    /** Re-run the roster fetch after a `failed` status. */
    onretryroster?: () => void;
    /**
     * Fired when setup is started from this pane (Run Setup or one of the
     * advanced launches). The shell records it so later boots land in the
     * company channel instead of #welcome.
     */
    onsetupstarted?: () => void;
    /**
     * Host-provided guided run (see `SetupRunApi`). When present, Run Setup
     * runs `/setup` natively inside this hero — stepper, one-line status,
     * questions as cards — instead of opening the Sessions page. The Sessions
     * page is still the fallback when the host's preflight says the provider
     * or HQ on this Mac is not ready (its Connect / self-heal UI lives there).
     */
    setupRun?: SetupRunApi | null;
    /** "Show details": open the underlying session on the Sessions page. */
    onopensessiondetails?: (sessionId: string) => void;
    /**
     * Fired once the native run reaches its finish. The shell records it so
     * later boots land in the company channel instead of #welcome.
     */
    onsetupfinished?: () => void;
  }

  let {
    settings,
    shell,
    onopenurl,
    onopensessions,
    companies = null,
    onopencompany,
    oncreatecompany = null,
    rosterStatus = null,
    onretryroster,
    onsetupstarted,
    setupRun = null,
    onopensessiondetails,
    onsetupfinished,
  }: Props = $props();

  const rosterCompanies = $derived(setupCompanies(companies));
  const hasCompany = $derived(rosterCompanies.length > 0);
  const rosterLoading = $derived(setupRosterLoading(companies, rosterStatus));
  const rosterFailed = $derived(rosterStatus === "failed" && !hasCompany);
  const hero = $derived(setupHeroFor(companies, rosterStatus));

  let createAnotherBusy = $state(false);
  let createAnotherError = $state<string | null>(null);

  async function createAnotherCompany(): Promise<void> {
    if (!oncreatecompany || createAnotherBusy) return;
    createAnotherBusy = true;
    createAnotherError = null;
    try {
      const result = await oncreatecompany();
      if (!result.ok) createAnotherError = result.reason;
    } catch (err) {
      createAnotherError = err instanceof Error ? err.message : String(err);
    } finally {
      createAnotherBusy = false;
    }
  }

  let hqFolderPath = $state("");
  let launching = $state<LaunchKey | null>(null);
  let launchErrors = $state<Partial<Record<LaunchKey, string>>>({});

  const canLaunch = $derived(hqFolderPath.trim().length > 0);

  /**
   * Same cascade as the title-bar Launch menu, with `/setup` prefilled.
   * Recreated when the folder lands so the first click sees a real path.
   */
  const launchActions = $derived(
    createLaunchActions({
      shell,
      hqFolderPath,
      prompt: SETUP_LAUNCH_COMMANDS.claude.prompt,
      // The deep link cannot carry `/setup`: Claude Desktop scans skills
      // before a link-opened folder is trusted, so HQ's project skill is not
      // registered in that session.
      deepLinkPrompt: SETUP_DEEP_LINK_PROMPT,
    }),
  );

  onMount(async () => {
    const res = await settings.getSetupStatus();
    if (res.ok) {
      const status = res.value as { hqFolderPath?: string } | null;
      hqFolderPath = status?.hqFolderPath?.trim() ?? "";
    }
  });

  function setLaunchError(key: LaunchKey, message: string | null): void {
    launchErrors = { ...launchErrors, [key]: message ?? undefined };
  }

  /**
   * The one primary action. With a host guided-run API, `/setup` runs right
   * here in the hero. Otherwise open the host's Sessions draft with `/setup`
   * prefilled; hosts without in-app Sessions fall back to Claude Code.
   */
  function runSetup(): void {
    if (setupRun) {
      void startNativeRun();
      return;
    }
    openSessionsForSetup();
  }

  function openSessionsForSetup(): void {
    if (onopensessions) {
      onsetupstarted?.();
      onopensessions();
      return;
    }
    // runLaunch reports onsetupstarted itself.
    void runLaunch("claude");
  }

  // --- native setup run ------------------------------------------------------

  type RunMode = "idle" | "starting" | SetupRunCardMode;
  let runMode = $state<RunMode>("idle");
  let runSessionId = $state<string | null>(null);
  let runSnapshot = $state<SetupRunSnapshot | null>(null);
  let runResumeStep = $state(0);
  let runBusy = $state(false);
  let runError = $state<string | null>(null);
  let runFinished = false;
  let unsubscribeRun: (() => void) | null = null;

  const runState = $derived(
    runSnapshot
      ? interpretSetupRun(runSnapshot.events, runSnapshot.phase, runSnapshot.resolvedRequestIds ?? [])
      : null,
  );
  const runActive = $derived(Boolean(setupRun) && runMode !== "idle");

  // A relaunch mid-run lands here with the session id remembered.
  if (setupRun) {
    const record = loadSetupRunRecord();
    if (record) {
      runSessionId = record.sessionId;
      runResumeStep = record.step;
      runMode = "resume";
    }
  }

  function watchRun(sessionId: string): void {
    if (!setupRun) return;
    unsubscribeRun?.();
    unsubscribeRun = setupRun.subscribe(sessionId, (snapshot) => {
      if (snapshot.sessionId !== runSessionId) return;
      runSnapshot = snapshot;
    });
  }

  // Keep the resume record current, and finish / stop with the session.
  $effect(() => {
    const state = runState;
    const sessionId = runSessionId;
    if (!state || !sessionId || runMode !== "live") return;
    if (state.done) {
      if (!runFinished) {
        runFinished = true;
        clearSetupRunRecord();
        onsetupfinished?.();
      }
      return;
    }
    if (state.ended) {
      clearSetupRunRecord();
      return;
    }
    saveSetupRunRecord({ sessionId, step: state.step });
  });

  $effect(() => () => unsubscribeRun?.());

  async function startNativeRun(): Promise<void> {
    if (!setupRun || runBusy) return;
    runBusy = true;
    runError = null;
    try {
      const readiness = await setupRun.preflight();
      if (readiness !== "ready") {
        // The Sessions page owns Connect / self-heal; never duplicate it here.
        openSessionsForSetup();
        return;
      }
      runMode = "starting";
      const sessionId = await setupRun.start(SETUP_LAUNCH_COMMANDS.claude.prompt);
      runFinished = false;
      runSessionId = sessionId;
      runSnapshot = { sessionId, events: [], phase: "starting" };
      saveSetupRunRecord({ sessionId, step: 0 });
      watchRun(sessionId);
      runMode = "live";
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
      if (runMode === "starting") runMode = "idle";
    } finally {
      runBusy = false;
    }
  }

  async function continueRun(): Promise<void> {
    if (!setupRun || runBusy || !runSessionId) return;
    runBusy = true;
    runError = null;
    try {
      const attached = await setupRun.attach(runSessionId);
      if (!attached) {
        clearSetupRunRecord();
        runMode = "stopped";
        return;
      }
      runFinished = false;
      watchRun(runSessionId);
      runMode = "live";
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
    } finally {
      runBusy = false;
    }
  }

  function runAgain(): void {
    unsubscribeRun?.();
    unsubscribeRun = null;
    runSnapshot = null;
    runSessionId = null;
    runMode = "idle";
    void startNativeRun();
  }

  async function withRun(action: () => Promise<void>): Promise<void> {
    if (!setupRun || runBusy) return;
    runBusy = true;
    runError = null;
    try {
      await action();
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
    } finally {
      runBusy = false;
    }
  }

  function answerChoice(requestId: string, questionId: string, values: string[]): void {
    const sessionId = runSessionId;
    if (!sessionId) return;
    void withRun(() => setupRun!.answerQuestion(sessionId, requestId, [{ questionId, values }]));
  }

  function answerPermission(requestId: string, decision: SetupRunPermissionDecision): void {
    const sessionId = runSessionId;
    if (!sessionId) return;
    void withRun(() => setupRun!.respondPermission(sessionId, requestId, decision));
  }

  function answerText(text: string): void {
    const sessionId = runSessionId;
    if (!sessionId) return;
    void withRun(() => setupRun!.send(sessionId, text));
  }

  function showRunDetails(): void {
    if (runSessionId) onopensessiondetails?.(runSessionId);
  }

  async function runLaunch(key: LaunchKey): Promise<void> {
    if (!canLaunch || launching) return;
    onsetupstarted?.();
    setLaunchError(key, null);
    launching = key;
    try {
      const error =
        key === "claude"
          ? await launchActions.launchClaude()
          : key === "codex"
            ? await launchActions.launchCodex()
            : await launchActions.launchGrok();
      if (error) setLaunchError(key, error);
    } finally {
      launching = null;
    }
  }

  const LAUNCHES: readonly {
    key: LaunchKey;
    label: string;
    primary: boolean;
  }[] = [
    { key: "claude", label: "Open setup in Claude Code", primary: false },
    { key: "codex", label: "Open setup in Codex", primary: false },
    { key: "grok", label: "Open setup in Grok Build", primary: false },
  ];

  function openResourceLink(event: MouseEvent, href: string): void {
    event.preventDefault();
    if (!/^https?:/i.test(href)) return;
    onopenurl?.(href);
  }

  /** Inline stroke glyphs per resource kind (no emoji in product UI). */
  const GLYPHS: Record<SetupResourceKind, string> = {
    guide:
      '<circle cx="8" cy="8" r="6.25"/><path d="M10.6 5.4 9.2 9.2 5.4 10.6 6.8 6.8z"/>',
    book: '<path d="M2.75 3.25h4.1c.9 0 1.65.55 1.9 1.35.25-.8 1-1.35 1.9-1.35h4.1v9.5h-4.35c-.75 0-1.4.45-1.65 1.1-.25-.65-.9-1.1-1.65-1.1H2.75z"/><path d="M8.75 4.6v9.15"/>',
    training:
      '<rect x="2.25" y="3.25" width="11.5" height="10.5"/><path d="M2.25 6.75h11.5M5.25 1.75v3M10.75 1.75v3"/>',
    docs: '<path d="M4 1.75h5.25L12.5 5v9.25H4z"/><path d="M9 1.75V5h3.5M6 8.25h4M6 10.75h4"/>',
  };
</script>

<section
  class="setup-intro"
  aria-label="Getting started with HQ Desktop"
  data-testid="setup-channel-intro"
  data-setup-threads="none"
  data-setup-has-company={hasCompany ? "true" : "false"}
  data-setup-run={runActive ? runMode : "idle"}
  data-setup-roster-status={rosterStatus ?? "ready"}
>
  <div class="hero" data-testid="setup-hero">
    <img
      class="hero-art hero-art--light"
      src={SETUP_HERO_ART.light}
      alt=""
      aria-hidden="true"
      decoding="async"
      draggable="false"
    />
    <img
      class="hero-art hero-art--dark"
      src={SETUP_HERO_ART.dark}
      alt=""
      aria-hidden="true"
      decoding="async"
      draggable="false"
    />
    <div class="hero-scrim" aria-hidden="true"></div>
    {#if runActive && runMode !== "idle"}
      <div class="hero-copy hero-copy--run">
        <SetupRunCard
          mode={runMode === "starting" ? "live" : runMode}
          run={runState}
          resumeStep={runResumeStep}
          busy={runBusy || runMode === "starting"}
          error={runError}
          onanswer={answerChoice}
          onpermission={answerPermission}
          onsend={answerText}
          onshowdetails={onopensessiondetails && runSessionId ? showRunDetails : undefined}
          oncontinue={() => void continueRun()}
          onrunagain={runAgain}
        />
      </div>
    {:else}
    <div class="hero-copy">
      <span class="eyebrow">{hero.eyebrow}</span>
      <h2 class="hero-title">{hero.title}</h2>
      {#if rosterLoading}
        <p
          class="hero-body roster-loading"
          role="status"
          aria-live="polite"
          data-testid="setup-roster-loading"
        >
          {hero.body}
        </p>
      {:else}
        <p class="hero-body">{hero.body}</p>
      {/if}
      {#if rosterFailed}
        <p class="roster-failed" role="alert" data-testid="setup-roster-failed">
          <span>{SETUP_ROSTER_FAILED.body}</span>
          {#if onretryroster}
            <button
              type="button"
              class="quiet-btn"
              data-testid="setup-roster-retry"
              onclick={() => onretryroster?.()}
            >
              {SETUP_ROSTER_FAILED.retry}
            </button>
          {/if}
        </p>
      {/if}

      <div class="hero-actions" role="group" aria-label="Set up this Mac">
        <button
          type="button"
          class="launch-btn primary"
          data-testid="setup-run"
          disabled={runBusy || (!setupRun && !onopensessions && (!canLaunch || launching !== null))}
          aria-busy={runBusy || (!onopensessions && launching === "claude")}
          onclick={runSetup}
        >
          {runBusy ? "Starting…" : SETUP_RUN_LABEL}
        </button>
      </div>
      {#if !onopensessions && launchErrors.claude}
        <p class="launch-error" role="alert">{launchErrors.claude}</p>
      {/if}
      {#if runError && runMode === "idle"}
        <p class="launch-error" role="alert" data-testid="setup-run-start-error">{runError}</p>
      {/if}

      <details class="advanced" data-testid="setup-advanced">
        <summary>{SETUP_ADVANCED_LABEL}</summary>
        <div class="advanced-body">
          <p>{SETUP_ADVANCED_TOOLS_NOTE}</p>
          <div class="hero-actions" role="group" aria-label="Open setup in a separate tool">
            {#each LAUNCHES as launch (launch.key)}
              <div class="setup-action">
                <button
                  type="button"
                  class="launch-btn"
                  data-testid={`setup-launch-${launch.key}`}
                  disabled={!canLaunch || launching !== null}
                  aria-busy={launching === launch.key}
                  onclick={() => void runLaunch(launch.key)}
                >
                  {launching === launch.key ? "Opening…" : launch.label}
                </button>
                {#if launchErrors[launch.key]}
                  <p class="launch-error" role="alert">
                    {launchErrors[launch.key]}
                  </p>
                {/if}
              </div>
            {/each}
          </div>

          {#if hasCompany}
            <div
              class="hero-actions company-actions"
              role="group"
              aria-label="Your companies"
              data-testid="setup-company-actions"
            >
              {#each rosterCompanies as company (company.cloudUid ?? company.slug)}
                <button
                  type="button"
                  class="launch-btn"
                  data-testid={`setup-open-company-${company.slug}`}
                  data-company-uid={company.cloudUid ?? ""}
                  onclick={() => onopencompany?.(company)}
                >
                  {setupCompanyActionLabel(company)}
                </button>
              {/each}
            </div>
            {#if oncreatecompany}
              <div class="setup-action">
                <button
                  type="button"
                  class="quiet-btn"
                  data-testid="setup-create-another-company"
                  aria-busy={createAnotherBusy}
                  disabled={createAnotherBusy}
                  onclick={() => void createAnotherCompany()}
                >
                  {createAnotherBusy ? "Opening…" : "Create another company"}
                </button>
                {#if createAnotherError}
                  <p
                    class="launch-error"
                    role="alert"
                    data-testid="setup-create-another-company-error"
                  >
                    {createAnotherError}
                  </p>
                {/if}
              </div>
            {/if}
          {/if}

          <p data-testid="setup-hosted-agent-guidance">{SETUP_HOSTED_AGENT_NOTE}</p>
        </div>
      </details>
    </div>
    {/if}
  </div>

  <ul class="resources" aria-label="Learn HQ">
    {#each SETUP_RESOURCES as resource (resource.id)}
      <li class="resource">
        <a
          class="resource-link"
          href={resource.href}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`setup-resource-${resource.id}`}
          onclick={(event) => openResourceLink(event, resource.href)}
        >
          <svg
            class="resource-glyph"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            {@html GLYPHS[resource.kind]}
          </svg>
          <span class="resource-text">
            <span class="eyebrow eyebrow--muted">{resource.eyebrow}</span>
            <span class="resource-title">{resource.title}</span>
            <span class="resource-desc">{resource.description}</span>
          </span>
          <svg
            class="resource-arrow"
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M4.5 11.5 11.5 4.5M6 4.5h5.5V10" />
          </svg>
        </a>
      </li>
    {/each}
  </ul>

  <p class="support-note" data-testid="setup-support-note">
    {SETUP_SUPPORT_NOTE}
  </p>
</section>

<style>
  .advanced {
    margin-top: 14px;
    font-size: 13px;
  }
  .advanced summary {
    cursor: pointer;
    width: fit-content;
    color: rgba(255, 255, 255, 0.72);
    font-size: 12px;
    letter-spacing: 0.02em;
  }
  .advanced summary:hover {
    color: #ffffff;
  }
  .advanced-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 10px;
  }
  .advanced-body p {
    margin: 0;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.72);
  }
  .setup-intro {
    flex: 0 0 auto;
    overflow: visible;
    width: 100%;
    max-width: 760px;
    padding: var(--space-2, 8px) 0 var(--space-3, 12px);
    margin-bottom: var(--space-3, 12px);
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 16px);
    border-bottom: 1px solid var(--border);
  }

  /* ---- Hero ------------------------------------------------------------ */

  .hero {
    position: relative;
    isolation: isolate;
    overflow: hidden;
    min-height: 248px;
    /* Wallpaper panels are always dark; the eyebrow/title sit on white. The
       fallback color covers the frame before the art decodes. */
    background: #0a0b0d;
    color: #ffffff;
  }

  .hero-art {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    /* Aim the crop at the clean sky band, keeping the moon in frame. */
    object-position: center 28%;
    user-select: none;
    pointer-events: none;
  }

  /* Light shell shows the brighter monoliths piece; dark shows the aurora.
     Mirrors the chat-tokens.css theme cascade (force-theme wins over OS). */
  .hero-art--dark {
    display: none;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-force-theme="light"])) .hero-art--dark {
      display: block;
    }

    :global(:root:not([data-force-theme="light"])) .hero-art--light {
      display: none;
    }
  }

  :global(:root[data-force-theme="dark"]) .hero-art--dark {
    display: block;
  }

  :global(:root[data-force-theme="dark"]) .hero-art--light {
    display: none;
  }

  .hero-scrim {
    position: absolute;
    inset: 0;
    z-index: 1;
    background:
      linear-gradient(
        180deg,
        rgba(6, 6, 6, 0.08) 0%,
        rgba(6, 6, 6, 0.42) 48%,
        rgba(6, 6, 6, 0.86) 100%
      ),
      linear-gradient(90deg, rgba(6, 6, 6, 0.55) 0%, rgba(6, 6, 6, 0) 70%);
  }

  .hero-copy {
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 8px);
    padding: var(--space-6, 24px) var(--space-5, 20px) var(--space-5, 20px);
    min-height: 248px;
    justify-content: flex-end;
  }

  .hero-copy--run {
    justify-content: flex-end;
  }

  .eyebrow {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: var(--text-micro, 11px);
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.62);
  }

  .hero-title {
    margin: 0;
    max-width: 22ch;
    font-size: var(--type-detail, 24px);
    font-weight: 500;
    line-height: 1.15;
    letter-spacing: -0.012em;
    color: #ffffff;
  }

  .hero-body {
    margin: 0;
    max-width: 52ch;
    font-size: var(--text-base, 13px);
    line-height: 1.55;
    color: rgba(255, 255, 255, 0.74);
  }

  .roster-loading {
    color: rgba(255, 255, 255, 0.62);
  }

  .roster-failed {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: var(--text-base, 13px);
    line-height: 1.4;
    color: rgba(255, 255, 255, 0.85);
  }

  .hero-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-2, 8px);
    margin-top: var(--space-2, 8px);
  }

  .setup-action {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-width: 100%;
  }

  /* Buttons live on the wallpaper, so they are image-relative (white on
     dark), not theme-relative — the same in light and dark shells. */
  .launch-btn {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    min-height: 30px;
    padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.38);
    border-radius: 0;
    background: rgba(6, 6, 6, 0.28);
    color: #ffffff;
    font: inherit;
    font-size: var(--text-base, 13px);
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    transition:
      background 140ms ease,
      color 140ms ease,
      border-color 140ms ease;
  }

  .launch-btn:hover:not(:disabled) {
    border-color: rgba(255, 255, 255, 0.7);
    background: rgba(255, 255, 255, 0.12);
  }

  .launch-btn.primary {
    border-color: #ffffff;
    background: #ffffff;
    color: #0a0b0d;
  }

  .launch-btn.primary:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.9);
    border-color: rgba(255, 255, 255, 0.9);
  }

  .launch-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .company-actions {
    margin-top: var(--space-3, 12px);
  }

  /* Secondary affordance beside an existing company: text-only, no chrome. */
  .quiet-btn {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    min-height: 24px;
    padding: 0;
    border: 0;
    background: transparent;
    color: rgba(255, 255, 255, 0.72);
    font: inherit;
    font-size: var(--text-base, 13px);
    text-decoration: underline;
    text-underline-offset: 0.16em;
    cursor: pointer;
  }

  .quiet-btn:hover:not(:disabled) {
    color: #ffffff;
  }

  .quiet-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .quiet-btn:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 2px;
  }

  .launch-btn:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 2px;
  }

  .launch-error {
    margin: 0;
    max-width: 22rem;
    font-size: var(--text-base, 13px);
    line-height: 1.4;
    color: rgba(255, 255, 255, 0.85);
  }

  /* ---- Resources (ghost rows, no card chrome) ------------------------- */

  .resources {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    column-gap: var(--space-6, 24px);
  }

  .resource {
    border-top: 1px solid var(--border);
  }

  .resource-link {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) 14px;
    align-items: start;
    gap: var(--space-3, 12px);
    padding: var(--space-3, 12px) 0 var(--space-4, 16px);
    color: var(--fg);
    text-decoration: none;
  }

  .resource-glyph {
    margin-top: 2px;
    color: var(--muted);
    transition: color 140ms ease;
  }

  .resource-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .eyebrow--muted {
    color: var(--muted-2);
  }

  .resource-title {
    font-size: var(--text-base, 13px);
    font-weight: 500;
    line-height: 1.35;
    color: var(--fg);
    text-decoration: underline;
    text-decoration-color: transparent;
    text-underline-offset: 0.16em;
    transition: text-decoration-color 140ms ease;
  }

  .resource-desc {
    font-size: var(--text-base, 13px);
    line-height: 1.5;
    color: var(--muted);
  }

  .resource-arrow {
    margin-top: 3px;
    color: var(--muted-2);
    transition:
      color 140ms ease,
      transform 160ms ease;
  }

  .resource-link:hover .resource-title,
  .resource-link:focus-visible .resource-title {
    text-decoration-color: currentColor;
  }

  .resource-link:hover .resource-glyph,
  .resource-link:hover .resource-arrow,
  .resource-link:focus-visible .resource-arrow {
    color: var(--fg);
  }

  .resource-link:hover .resource-arrow {
    transform: translate(1px, -1px);
  }

  .resource-link:focus-visible {
    outline: 2px solid var(--fg);
    outline-offset: 2px;
  }

  /* ---- Support note --------------------------------------------------- */

  .support-note {
    margin: 0;
    padding-top: var(--space-3, 12px);
    border-top: 1px solid var(--border);
    font-size: var(--text-base, 13px);
    line-height: 1.5;
    color: var(--muted-2);
  }

  @media (prefers-reduced-motion: reduce) {
    .launch-btn,
    .resource-glyph,
    .resource-title,
    .resource-arrow {
      transition: none;
    }
  }
</style>
