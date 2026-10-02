<script lang="ts">
  /**
   * SetupChannelIntro — the welcome experience at the top of the synthetic
   * #setup support channel in the live desktop shell: a window-ground introduction with
   * the three launch actions (Claude Code / Codex / Grok Build), then ghost
   * rows for the getting-started guide, the free book, the weekly onboarding
   * training, and the docs, closed by the support note.
   *
   * REUSE, do not reimplement: launch paths live in
   * `createLaunchActions` (settings/launch-actions.ts) — the same cascade
   * the title-bar Launch menu uses, with `/setup` prefilled from
   * `SETUP_LAUNCH_COMMANDS`. The HQ folder path comes from
   * `settings.getSetupStatus`. Copy + links come from `setup-channel.ts`
   * (shared with the classic messaging surface). The live message thread + composer below this
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
  import type { AiTools } from "../settings/setup-launch";
  import SetupWelcomeMark from "./SetupWelcomeMark.svelte";
  import {
    dispatchPostReadyAction,
    type SettingsApi,
    type ShellApi,
  } from "@hq/platform";
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
    type SetupRosterStatus,
  } from "./setup-channel";
  import { SETUP_RESOURCE_GLYPHS } from "./setup-resource-glyphs";
  import SetupRunCard from "./SetupRunCard.svelte";
  import SetupConnectStep from "./SetupConnectStep.svelte";
  import SetupButton from "./SetupButton.svelte";
  import { SETUP_RUN_STEPS } from "./setup-run";
  import type { SetupAgent } from "./setup-agent.svelte";
  import {
    setupBotCopy,
    SETUP_BOT_GENERIC_FAILURE,
    isSetupBotNoRuntimeMessage,
    SETUP_ELSEWHERE_COPY,
    setupBotActionLabel,
    type SetupBotLauncher,
  } from "./setup-bot";
  import { hostComputerNoun, subscribeHostComputerNoun } from "@hq/platform";
  import type { EntryPointResult } from "./lifecycle-entry-points";
  import type { Workspace } from "./workspaces";
  import SetupInstallGuide, {
    type CodingTool,
    type InstallOutcome,
    type SignInOptions,
  } from "../settings/SetupInstallGuide.svelte";

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
    /** Opt-in post-ready first real-use action, resolved by the desktop host. */
    readyFirstActionEnabled?: boolean;
    /** Start the native sync path used by the first real-use action. */
    onstartsync?: () => Promise<{ ok: boolean }> | { ok: boolean };
    /**
     * Host-provided guided run (see `SetupRunApi`). When present, Run Setup
     * runs `/setup` natively inside this hero — stepper, one-line status,
     * questions as cards — instead of opening the Sessions page. The Sessions
     * page is still the fallback when the host's preflight says the provider
     * or HQ on this Mac is not ready (its Connect / self-heal UI lives there).
     */
    /**
     * The host's Setup Agent (see `setup-agent.svelte.ts`). With it, Run Setup
     * starts the guided run that talks in this channel; the hero shows its
     * stepper. Without it, Run Setup opens the host's Sessions draft.
     */
    agent?: SetupAgent | null;
    /**
     * SETUP AS A BOT (bots v2, step 3). With a launcher, Run Setup creates a
     * Local bot named `setup` from the core template and opens its DM instead
     * of starting the scripted run; the bot's own welcome message is its first
     * turn. The scripted run stays as the fallback when creating the bot
     * fails, so nobody is ever stuck on this screen.
     */
    setupBot?: SetupBotLauncher | null;
    /**
     * US-005 wiring. When the setup bot cannot start because no coding tool
     * is signed in on this computer, the hero surfaces a guided install path
     * instead of a dead-end error. The host provides real callbacks that
     * drive the Rust `install_claude_code` / `agent_provider_login_start` /
     * `detect_ai_tools` commands and the manual-download fallback URL. HQ
     * never asks for or handles the password itself.
     */
    installGuide?: {
      oninstall(tool: CodingTool): Promise<InstallOutcome>;
      onsignin(tool: CodingTool, options?: SignInOptions): Promise<InstallOutcome>;
      /** Is this tool already signed in? Lets the guide skip to Continue. */
      onstatus?(tool: CodingTool): Promise<boolean>;
      /** Stop a pending sign-in so "Open the sign-in page again" can restart it. */
      oncancelsignin?(tool: CodingTool): Promise<void>;
      onrefresh(): Promise<void>;
      downloadUrlFor(tool: CodingTool): string;
      onopen(url: string): Promise<InstallOutcome> | void;
      /**
       * Optional: open one of the assistant desktop apps with a fixed
       * install prompt pre-filled — the operator-directed shortcut that
       * lets a person set up their coding tool without opening a terminal.
       * Wired via the install-guide adapter to `open_claude_code_link` /
       * `open_codex_deep_link`.
       */
      onopenassistant?(
        assistant: "claude-desktop" | "chatgpt-desktop",
        url: string,
      ): Promise<InstallOutcome>;
    } | null;
    /** "Show details": open the underlying session on the Sessions page. */
    onopensessiondetails?: (sessionId: string) => void;
    /**
     * Fired once the native run reaches its finish. The shell records it so
     * later boots land in the company channel instead of #welcome.
     */
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
    readyFirstActionEnabled = false,
    onstartsync,
    agent = null,
    onopensessiondetails,
    setupBot = null,
    installGuide = null,
  }: Props = $props();

  /**
   * Local AiTools probe for the guided install path. Kept separate from the
   * launch cascade above so a NO_RUNTIME dead-end can surface the guide
   * without the launches also re-probing.
   */
  let installGuideTools = $state<AiTools | null>(null);
  let installGuideProbed = false;

  async function ensureInstallGuideTools(): Promise<void> {
    if (installGuideProbed) return;
    installGuideProbed = true;
    try {
      const res = await shell.detectAiTools();
      installGuideTools = res.ok ? (res.value as unknown as AiTools) : null;
    } catch {
      installGuideTools = null;
    }
  }

  const rosterCompanies = $derived(setupCompanies(companies));
  const hasCompany = $derived(rosterCompanies.length > 0);
  const rosterLoading = $derived(setupRosterLoading(companies, rosterStatus));
  const rosterFailed = $derived(rosterStatus === "failed" && !hasCompany);
  /**
   * The plain-language name for the host machine ("Mac", "PC", or
   * "computer"). Subscribe to the shared helper: the first read still lands
   * synchronously, and if the Tauri OS plugin resolves a moment later (the
   * `apps/sync` webview does not inject `__HQ_HOST_OS__` inline the way
   * `apps/work` does), the "no coding tool" prompt and setup-bot copy under
   * this hero flip from "on this computer" to "on this PC" without any
   * click.
   */
  let hostNoun = $state(hostComputerNoun());
  onMount(() => subscribeHostComputerNoun((next) => (hostNoun = next)));
  const hero = $derived(setupHeroFor(companies, rosterStatus, { noun: hostNoun }));
  const copy = $derived(setupBotCopy({ noun: hostNoun }));

  let createAnotherBusy = $state(false);
  let createAnotherError = $state<string | null>(null);
  let firstActionBusy = $state(false);
  let firstActionError = $state<string | null>(null);
  let firstActionShown = false;

  $effect(() => {
    if (readyFirstActionEnabled && onstartsync && !firstActionShown) {
      firstActionShown = true;
      dispatchPostReadyAction("ready_first_action_shown");
    }
  });

  async function startFirstAction(): Promise<void> {
    if (!onstartsync || firstActionBusy) return;
    firstActionBusy = true;
    firstActionError = null;
    dispatchPostReadyAction("ready_first_action_clicked");
    try {
      const result = await onstartsync();
      if (!result.ok) firstActionError = "Sync could not start. Try again.";
    } catch (err) {
      console.warn("[hq-desktop] ready first action failed:", err);
      firstActionError = "Sync could not start. Try again.";
    } finally {
      firstActionBusy = false;
    }
  }

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
    // Hosts without a settings surface (some shells, tests) just get no folder path.
    const res = await settings?.getSetupStatus?.();
    if (res?.ok) {
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
    if (setupBot && !scriptedFallback) {
      void runSetupBot();
      return;
    }
    if (agent?.api) {
      void startAgent();
      return;
    }
    openSessionsForSetup();
  }

  /** Creating the setup bot, or opening the one that is already here. */
  let botBusy = $state(false);
  let botError = $state<string | null>(null);
  const visibleBotError = $derived(botError ?? setupBot?.error);
  /**
   * No coding tool is signed in and the host can install and sign one in:
   * the install guide owns the next step, so the hero's own Open Setup Agent
   * button and the Retry button (both of which would only fail again) step
   * aside and the guide's Continue takes over once a tool is signed in.
   */
  const showInstallGuide = $derived(
    Boolean(installGuide) && isSetupBotNoRuntimeMessage(visibleBotError),
  );
  /** The bot could not be made: the scripted run takes over from the next click. */
  let scriptedFallback = $state(false);

  const runLabel = $derived(
    setupBot && !scriptedFallback ? setupBotActionLabel(setupBot) : SETUP_RUN_LABEL,
  );
  /** Hero body in bot mode — setup is a conversation now, not a wizard. */
  const heroBody = $derived(
    setupBot && !scriptedFallback && !rosterLoading
      ? setupBot.starting && !setupBot.existing
        ? copy.bodyStarting
        : setupBot.existing
        ? copy.bodyExisting
        : copy.body
      : hero.body,
  );

  async function runSetupBot(): Promise<void> {
    if (!setupBot || botBusy) return;
    botBusy = true;
    botError = null;
    try {
      const result = await setupBot.start();
      if (!result.ok) botError = result.reason;
    } catch (err) {
      // Whatever threw, the person gets a sentence — never a stack, a status
      // line or the API's own words. The raw text stays in the log.
      console.warn("[hq-desktop] setup bot start failed:", err);
      botError = SETUP_BOT_GENERIC_FAILURE;
    } finally {
      botBusy = false;
    }
  }

  /** "Use the step-by-step setup instead": the old scripted run, right now. */
  function useScriptedSetup(): void {
    scriptedFallback = true;
    botError = null;
    if (agent?.api) {
      void startAgent();
      return;
    }
    openSessionsForSetup();
  }

  /** The Setup Agent runs here; only a not-ready host hands off to Sessions. */
  async function startAgent(): Promise<void> {
    if (!agent) return;
    const outcome = await agent.start();
    if (outcome === "needs-sessions-page") openSessionsForSetup();
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

  const runActive = $derived(Boolean(agent?.active));

  function showRunDetails(): void {
    if (agent?.sessionId) onopensessiondetails?.(agent.sessionId);
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

  /** Coding tools found on this Mac; the "set up there instead" panel lists only these. */
  let installedTools = $state<AiTools | null>(null);
  onMount(() => {
    void shell?.detectAiTools?.().then((res) => {
      if (res.ok) installedTools = res.value as unknown as AiTools;
    });
  });
  const installedLaunches = $derived(
    LAUNCHES.filter((launch) =>
      launch.key === "claude"
        ? Boolean(installedTools?.claude_cli || installedTools?.claude_desktop)
        : launch.key === "codex"
          ? Boolean(installedTools?.codex_cli || installedTools?.codex_desktop)
          : Boolean(installedTools?.grok_cli),
    ),
  );


  function openResourceLink(event: MouseEvent, href: string): void {
    event.preventDefault();
    if (!/^https?:/i.test(href)) return;
    onopenurl?.(href);
  }

</script>

<section
  class="setup-intro"
  aria-label="Getting started with HQ Desktop"
  data-testid="setup-channel-intro"
  data-setup-threads="none"
  data-setup-has-company={hasCompany ? "true" : "false"}
  data-setup-run={runActive ? agent!.mode : "idle"}
  data-setup-roster-status={rosterStatus ?? "ready"}
>
  <div class="hero" data-testid="setup-hero">
    {#if !runActive}
      <div class="hero-mark"><SetupWelcomeMark /></div>
    {/if}
    {#if runActive && agent}
      <div class="hero-copy hero-copy--run">
        <SetupRunCard
          variant="steps"
          mode={agent.mode === "starting" ? "live" : agent.mode === "idle" ? "live" : agent.mode}
          run={agent.state}
          resumeStep={agent.resumeStep}
          busy={agent.busy}
          onshowdetails={onopensessiondetails && agent.sessionId && agent.mode !== "done" && !agent.state?.done
            ? showRunDetails
            : undefined}
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
          {heroBody}
        </p>
      {:else}
        <p class="hero-body">{heroBody}</p>
      {/if}
      {#if agent?.api && !setupBot}
        <!-- What the scripted Run Setup will do. The setup bot says this itself. -->
        <ol class="steps-preview" aria-label="Setup steps" data-testid="setup-steps-preview">
          {#each SETUP_RUN_STEPS as step, index (step.id)}
            <li class="steps-preview-step">
              <span class="steps-preview-index" aria-hidden="true">{index + 1}</span>
              <span>{step.label}</span>
            </li>
          {/each}
        </ol>
      {/if}
      {#if rosterFailed}
        <p class="roster-failed" role="alert" data-testid="setup-roster-failed">
          <span>{SETUP_ROSTER_FAILED.body}</span>
          {#if onretryroster}
            <SetupButton
              variant="quiet"
              data-testid="setup-roster-retry"
              onclick={() => onretryroster?.()}
            >
              {SETUP_ROSTER_FAILED.retry}
            </SetupButton>
          {/if}
        </p>
      {/if}

      {#if agent?.api && agent.providers && !agent.providersReady}
        <!-- No signed-in agent on this Mac yet: connect one first. -->
        <SetupConnectStep api={agent.api} providers={agent.providers} onrefresh={() => agent!.refreshProviders(true)} />
      {:else}
      {#if !showInstallGuide}
      {#if readyFirstActionEnabled && onstartsync}
        <div class="hero-actions" role="group" aria-label="Start using HQ">
          <SetupButton
            variant="primary"
            data-testid="ready-first-action"
            disabled={firstActionBusy}
            aria-busy={firstActionBusy}
            onclick={() => void startFirstAction()}
          >
            {firstActionBusy ? "Starting sync…" : "Sync my HQ folder"}
          </SetupButton>
        </div>
        {#if firstActionError}
          <p class="launch-error" role="alert" data-testid="ready-first-action-error">
            {firstActionError}
          </p>
        {/if}
      {/if}
      <div class="hero-actions" role="group" aria-label="Set up this Mac">
        <SetupButton
          variant={readyFirstActionEnabled && onstartsync ? "quiet" : "primary"}
          data-testid="setup-run"
          disabled={botBusy ||
            Boolean(setupBot?.starting && !scriptedFallback) ||
            Boolean(agent?.busy) ||
            (!setupBot && !agent?.api && !onopensessions && (!canLaunch || launching !== null))}
          aria-busy={botBusy || Boolean(agent?.busy) || (!onopensessions && launching === "claude")}
          onclick={runSetup}
        >
          {setupBot?.starting && !scriptedFallback && !botBusy
            ? copy.autoStarting
            : botBusy || agent?.busy
              ? copy.starting
              : runLabel}
        </SetupButton>
      </div>
      {/if}
      {#if visibleBotError}
        <!-- The bot could not be created: say why, offer another go, and
             keep the old scripted run one click away. -->
        <div class="bot-failure" data-testid="setup-bot-failure">
          <p class="launch-error" role="alert" data-testid="setup-bot-error">{visibleBotError}</p>
          {#if installGuide && showInstallGuide}
            <!-- US-005: no coding tool is signed in. Instead of dead-ending
                 the user, offer a guided Install + sign-in path. Continue
                 (shown as soon as a tool is signed in, detected by itself)
                 starts the setup bot, which is what Retry used to do. -->
            {#await ensureInstallGuideTools() then _}
              <SetupInstallGuide
                tools={installGuideTools}
                oninstall={installGuide.oninstall}
                onsignin={installGuide.onsignin}
                onstatus={installGuide.onstatus}
                oncancelsignin={installGuide.oncancelsignin}
                oncontinue={runSetupBot}
                onrefresh={async () => {
                  installGuideProbed = false;
                  await ensureInstallGuideTools();
                  await installGuide.onrefresh();
                }}
                downloadUrlFor={installGuide.downloadUrlFor}
                onopen={installGuide.onopen}
                onopenassistant={installGuide.onopenassistant}
              />
            {/await}
          {/if}
          <div class="hero-actions" role="group" aria-label="Setup bot recovery">
            {#if !showInstallGuide}
              <SetupButton data-testid="setup-bot-retry" disabled={botBusy} onclick={() => void runSetupBot()}>
                {copy.retry}
              </SetupButton>
            {/if}
            <SetupButton
              variant="quiet"
              data-testid="setup-bot-fallback"
              disabled={Boolean(agent?.busy)}
              onclick={useScriptedSetup}
            >
              {copy.fallback}
            </SetupButton>
          </div>
        </div>
      {/if}
      {/if}
      {#if setupBot && !scriptedFallback && installedLaunches.length > 0}
        <!-- The other way through: set up in the coding tool they already use. -->
        <div class="setup-elsewhere" data-testid="setup-elsewhere" role="group" aria-label={SETUP_ELSEWHERE_COPY.title}>
          <h3 class="setup-elsewhere-title">{SETUP_ELSEWHERE_COPY.title}</h3>
          <p class="setup-elsewhere-body">
            {SETUP_ELSEWHERE_COPY.body.split("/setup")[0]}<code>/setup</code>{SETUP_ELSEWHERE_COPY.body.split("/setup").slice(1).join("/setup")}
          </p>
          <div class="hero-actions" role="group" aria-label="Open setup in a coding tool">
            {#each installedLaunches as launch (launch.key)}
              <SetupButton
                data-testid={`setup-elsewhere-${launch.key}`}
                disabled={!canLaunch || launching !== null}
                aria-busy={launching === launch.key}
                onclick={() => void runLaunch(launch.key)}
              >
                {launching === launch.key ? "Opening…" : launch.label}
              </SetupButton>
            {/each}
          </div>
          {#each installedLaunches as launch (launch.key)}
            {#if launchErrors[launch.key]}
              <p class="launch-error" role="alert">{launchErrors[launch.key]}</p>
            {/if}
          {/each}
        </div>
      {/if}
      {#if !onopensessions && launchErrors.claude && !(setupBot && !scriptedFallback)}
        <p class="launch-error" role="alert">{launchErrors.claude}</p>
      {/if}
      {#if agent?.error && agent.mode === "idle"}
        <p class="launch-error" role="alert" data-testid="setup-run-start-error">{agent?.error}</p>
      {/if}

      {#if !setupBot}
      <details class="advanced" data-testid="setup-advanced">
        <summary>{SETUP_ADVANCED_LABEL}</summary>
        <div class="advanced-body">
          <p>{SETUP_ADVANCED_TOOLS_NOTE}</p>
          <div class="hero-actions" role="group" aria-label="Open setup in a separate tool">
            {#each LAUNCHES as launch (launch.key)}
              <div class="setup-action">
                <SetupButton
                  data-testid={`setup-launch-${launch.key}`}
                  disabled={!canLaunch || launching !== null}
                  aria-busy={launching === launch.key}
                  onclick={() => void runLaunch(launch.key)}
                >
                  {launching === launch.key ? "Opening…" : launch.label}
                </SetupButton>
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
                <SetupButton
                  data-testid={`setup-open-company-${company.slug}`}
                  data-company-uid={company.cloudUid ?? ""}
                  onclick={() => onopencompany?.(company)}
                >
                  {setupCompanyActionLabel(company)}
                </SetupButton>
              {/each}
            </div>
            {#if oncreatecompany}
              <div class="setup-action">
                <SetupButton
                  variant="quiet"
                  data-testid="setup-create-another-company"
                  aria-busy={createAnotherBusy}
                  disabled={createAnotherBusy}
                  onclick={() => void createAnotherCompany()}
                >
                  {createAnotherBusy ? "Opening…" : "Create another company"}
                </SetupButton>
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

          {@render resourceList()}
          <p class="support-note" data-testid="setup-support-note">{SETUP_SUPPORT_NOTE}</p>
        </div>
      </details>
      {/if}
    </div>
    {/if}
  </div>
  {#if setupBot && !(runActive && agent)}
    <div class="bot-resources" data-testid="setup-resources">
      {@render resourceList()}
    </div>
  {/if}
</section>

{#snippet resourceList()}
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
            {@html SETUP_RESOURCE_GLYPHS[resource.kind]}
          </svg>
          <span class="resource-text">
            <span class="eyebrow eyebrow--muted">{resource.eyebrow}</span>
            <span class="resource-title">{resource.title}</span>
            <span class="resource-desc">{resource.description}</span>
          </span>
        </a>
      </li>
    {/each}
  </ul>
{/snippet}

<style>
  .bot-resources {
    margin-top: 0;
  }
  .advanced {
    margin-top: 14px;
    font-size: 13px;
  }
  .advanced summary {
    cursor: pointer;
    width: fit-content;
    color: var(--t2);
    font-size: 12px;
    letter-spacing: 0.02em;
  }
  .advanced summary:hover {
    color: var(--t1);
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
    color: var(--t2);
  }
  /* Resources and setup details share the reference canvas ink. */
  .advanced-body .resources {
    margin-top: 4px;
    border-top: 1px solid var(--line);
  }
  .advanced-body .resource-link,
  .advanced-body .resource-title {
    color: var(--t1);
  }
  .advanced-body .resource-desc,
  .advanced-body .eyebrow--muted,
  .advanced-body .support-note {
    color: var(--t3);
  }
  .advanced-body .support-note {
    font-size: 12px;
  }
  .setup-intro {
    container-type: inline-size;
    flex: 0 0 auto;
    overflow: visible;
    width: 100%;
    max-width: none;
    padding: 4px 0 12px;
    margin-bottom: var(--space-3, 12px);
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 16px);
    border-bottom: 0;
    pointer-events: auto;
  }

  .advanced-body .resource-link {
    background: var(--raised);
    border: 1px solid var(--line);
  }
  .resource-link:hover {
    background: var(--btn-bg);
  }
  .advanced-body .resource-link:hover {
    background: var(--hover);
  }

  /* ---- Hero ------------------------------------------------------------ */

  /* The supplied #772 reference places the welcome copy directly on the
     window ground; the current setup actions and state machine stay intact. */
  .hero {
    position: relative;
    color: var(--t1);
    /* Stay visually on the window ground, but keep a 1% fill so a transparent
       WKWebView on macOS 26 still hit-tests the Run Setup control. */
    background: color-mix(in srgb, var(--t1, #111) 1%, transparent);
    pointer-events: auto;
    --setup-btn-fg: var(--t1);
    --setup-btn-line: var(--line2);
    --setup-btn-primary-bg: var(--btn-bg);
    --setup-btn-primary-fg: var(--t1);
    --setup-btn-muted: var(--t2);
    --setup-btn-hover: var(--hover);
  }

  .hero-mark {
    position: absolute;
    top: 20px;
    left: 0;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: var(--ice-tile);
    color: var(--ice-ink);
  }

  .hero-actions :global(.setup-btn) {
    border-radius: 8px;
    min-height: 32px;
    padding-inline: 14px;
  }

  .hero-copy {
    box-sizing: border-box;
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 8px);
    padding: 20px 0 24px 56px;
    border-bottom: 1px solid var(--line);
    justify-content: flex-start;
  }

  .hero-copy--run {
    padding-left: 0;
    justify-content: flex-end;
    min-height: 168px;
    padding-top: var(--space-4, 16px);
  }

  .hero--compact {
    min-height: 168px;
  }


  .eyebrow {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: var(--text-micro, 11px);
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--t3);
  }

  .hero-title {
    margin: 0;
    max-width: none;
    font-size: 20px;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.012em;
    color: var(--t1);
  }

  .hero-body {
    margin: 0;
    max-width: 64ch;
    font-size: var(--text-base, 13px);
    line-height: 1.5;
    color: var(--t2);
  }

  .roster-loading {
    color: var(--t3);
  }

  .roster-failed {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: var(--text-base, 13px);
    line-height: 1.4;
    color: var(--t2);
  }

  .steps-preview {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    margin: 10px 0 0;
    padding: 0;
    list-style: none;
    font-size: 12px;
    color: var(--t2);
  }
  .steps-preview-step {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .steps-preview-index {
    display: inline-flex;
    width: 16px;
    height: 16px;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    border: 1px solid var(--line2);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  /* Action rows: 8px between buttons; the hero-copy gap (8px) plus this
     margin puts 12px between a message and its actions. */
  .hero-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  .advanced-body .hero-actions {
    margin-top: 2px;
  }

  .setup-action {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-width: 100%;
  }
  .setup-action > :global(.setup-btn) {
    align-self: flex-start;
  }

  .company-actions {
    margin-top: var(--space-3, 12px);
  }

  .bot-failure {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .launch-error {
    margin: 0;
    max-width: 22rem;
    font-size: var(--text-base, 13px);
    line-height: 1.4;
    color: var(--t2);
  }

  /* ---- Resource cards ------------------------------------------------ */

  .resources {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: var(--space-6, 24px);

    gap: 10px;
  }

  @container (max-width: 420px) {
    .resources {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .resource {
    border-top: 0;

    min-width: 0;
  }

  .resource-link {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    padding: 16px;
    color: var(--fg);
    text-decoration: none;

    height: 100%;

    box-sizing: border-box;

    border-radius: 10px;

    background: var(--raised);
  }

  .resource-glyph {
    padding: 8px;
    box-sizing: content-box;
    border-radius: 8px;
    background: var(--btn-bg);
    margin-top: 0;
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
    font-size: 13px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--fg);
    text-decoration: underline;
    text-decoration-color: transparent;
    text-underline-offset: 0.16em;
    transition: text-decoration-color 140ms ease;
  }

  .resource-desc {
    font-size: 12px;
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
    padding-top: 16px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted-2);
  }

  @media (prefers-reduced-motion: reduce) {
    .resource-glyph,
    .resource-title,
    .resource-arrow {
      transition: none;
    }
  }
  .setup-elsewhere {
    margin-top: 20px;
    padding: 16px 18px;
    border: 1px solid var(--setup-btn-line, rgba(127, 127, 127, 0.35));
    border-radius: 10px;
    background: rgba(127, 127, 127, 0.08);
    max-width: 560px;
  }
  .setup-elsewhere-title {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
  }
  .setup-elsewhere-body {
    margin: 0 0 12px;
    font-size: 13px;
    line-height: 1.5;
    opacity: 0.9;
  }
  .setup-elsewhere-body code {
    font-family: var(--font-mono, ui-monospace, monospace);
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(127, 127, 127, 0.18);
  }
</style>
