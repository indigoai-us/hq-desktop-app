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
    type SetupRosterStatus,
  } from "./setup-channel";
  import { SETUP_HERO_ART } from "./setup-welcome-art";
  import { SETUP_RESOURCE_GLYPHS } from "./setup-resource-glyphs";
  import SetupRunCard from "./SetupRunCard.svelte";
  import SetupConnectStep from "./SetupConnectStep.svelte";
  import SetupButton from "./SetupButton.svelte";
  import { SETUP_RUN_STEPS } from "./setup-run";
  import type { SetupAgent } from "./setup-agent.svelte";
  import { SETUP_BOT_COPY, setupBotActionLabel, type SetupBotLauncher } from "./setup-bot";
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
    agent = null,
    onopensessiondetails,
    setupBot = null,
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
  /** The bot could not be made: the scripted run takes over from the next click. */
  let scriptedFallback = $state(false);

  const runLabel = $derived(
    setupBot && !scriptedFallback ? setupBotActionLabel(setupBot) : SETUP_RUN_LABEL,
  );
  /** Hero body in bot mode — setup is a conversation now, not a wizard. */
  const heroBody = $derived(
    setupBot && !scriptedFallback && !rosterLoading
      ? setupBot.existing
        ? SETUP_BOT_COPY.bodyExisting
        : SETUP_BOT_COPY.body
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
      botError = err instanceof Error ? err.message : String(err);
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
      <div class="hero-actions" role="group" aria-label="Set up this Mac">
        <SetupButton
          variant="primary"
          data-testid="setup-run"
          disabled={botBusy ||
            Boolean(agent?.busy) ||
            (!setupBot && !agent?.api && !onopensessions && (!canLaunch || launching !== null))}
          aria-busy={botBusy || Boolean(agent?.busy) || (!onopensessions && launching === "claude")}
          onclick={runSetup}
        >
          {botBusy || agent?.busy ? SETUP_BOT_COPY.starting : runLabel}
        </SetupButton>
      </div>
      {#if botError}
        <!-- The bot could not be created: say why, offer another go, and
             keep the old scripted run one click away. -->
        <div class="bot-failure" data-testid="setup-bot-failure">
          <p class="launch-error" role="alert" data-testid="setup-bot-error">{botError}</p>
          <div class="hero-actions" role="group" aria-label="Setup bot recovery">
            <SetupButton data-testid="setup-bot-retry" disabled={botBusy} onclick={() => void runSetupBot()}>
              {SETUP_BOT_COPY.retry}
            </SetupButton>
            <SetupButton
              variant="quiet"
              data-testid="setup-bot-fallback"
              disabled={Boolean(agent?.busy)}
              onclick={useScriptedSetup}
            >
              {SETUP_BOT_COPY.fallback}
            </SetupButton>
          </div>
        </div>
      {/if}
      {/if}
      {#if !onopensessions && launchErrors.claude}
        <p class="launch-error" role="alert">{launchErrors.claude}</p>
      {/if}
      {#if agent?.error && agent.mode === "idle"}
        <p class="launch-error" role="alert" data-testid="setup-run-start-error">{agent?.error}</p>
      {/if}

      {#if setupBot}
        <!-- Setup bot mode: #welcome is just this banner. The bot does the
             rest in its DM, so the only other thing here is where to learn HQ. -->
        <div class="bot-resources" data-testid="setup-resources">
          {@render resourceList()}
        </div>
      {:else}
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
    margin-top: 18px;
  }
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
  /* Learn-HQ rows live inside the dark hero now: keep them legible on it. */
  .bot-resources .resources,
  .advanced-body .resources {
    margin-top: 4px;
    border-top: 1px solid rgba(255, 255, 255, 0.14);
  }
  .bot-resources .resource-link,
  .bot-resources .resource-title,
  .advanced-body .resource-link,
  .advanced-body .resource-title {
    color: #ffffff;
  }
  .bot-resources .resource-desc,
  .bot-resources .eyebrow--muted,
  .bot-resources .resource-glyph,
  .advanced-body .resource-desc,
  .advanced-body .eyebrow--muted,
  .advanced-body .support-note {
    color: rgba(255, 255, 255, 0.66);
  }
  .advanced-body .support-note {
    font-size: 12px;
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
    /* Buttons live on the wallpaper, so they are image-relative (white on
       dark), not theme-relative — the same in light and dark shells. */
    --setup-btn-fg: #fff;
    --setup-btn-line: rgba(255, 255, 255, 0.6);
    --setup-btn-primary-bg: #fff;
    --setup-btn-primary-fg: #111;
    --setup-btn-muted: rgba(255, 255, 255, 0.8);
    --setup-btn-hover: rgba(255, 255, 255, 0.14);
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
    gap: 8px;
    margin: 0;
    font-size: var(--text-base, 13px);
    line-height: 1.4;
    color: rgba(255, 255, 255, 0.85);
  }

  .steps-preview {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    margin: 10px 0 0;
    padding: 0;
    list-style: none;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.78);
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
    border: 1px solid rgba(255, 255, 255, 0.45);
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
    .resource-glyph,
    .resource-title,
    .resource-arrow {
      transition: none;
    }
  }
</style>
