<script lang="ts">
  /**
   * Step B — Where does it run? Local (this Mac, free, the user's own
   * runtime login) or Cloud (company-hosted, always on). Local shows runtime
   * pills with sign-in state and an inline Sign in; Cloud shows the company
   * picker. Cloud is hidden entirely when no company can take a bot — unless
   * `cloudAlwaysShown` (agents.desktop-agent-creation), where it stays on
   * screen, disabled, with the reason and the fix.
   *
   * "Who is it for?" used to live here and now sits on the details step, next
   * to the name it affects — see DetailsStep.
   */
  import { initialsFor } from "../sidebar-model.js";
  import { LOCAL_BOT_RUNTIMES } from "../local-bots.js";
  import { hostComputerNoun, subscribeHostComputerNoun } from "@hq/platform";
  import { onMount } from "svelte";
  import RuntimeSignIn, { type RuntimeSignInApi } from "./RuntimeSignIn.svelte";
  import { runtimeIsReady, type BotHome, type BotRuntime, type CreateBotDraft } from "./create-bot-model.js";
  import {
    dedupeSearchedDirs,
    runtimeCanSignIn,
    runtimeChipSuffix,
    runtimeFooter,
    runtimeStatusOf,
    type RuntimeStatus,
  } from "./runtime-status.js";
  import InstallChoice from "../../install-choice/InstallChoice.svelte";
  import type {
    AiTools,
    AssistantId,
    CodingTool,
    InstallOutcome,
  } from "../../install-choice/install-choice.js";
  import type { CloudUnavailableCopy } from "@hq/agents";
  import "./create-bot.css";

  interface Props {
    draft: CreateBotDraft;
    canLocal: boolean;
    canCloud: boolean;
    /** Show the Cloud card even when it cannot be used (flag on). */
    cloudAlwaysShown?: boolean;
    /** Why Cloud cannot be used, and the fix. Rendered on the disabled card. */
    cloudBlocked?: CloudUnavailableCopy | null;
    /** Per-company reasons; those companies are disabled in the picker. */
    companyBlocks?: Record<string, CloudUnavailableCopy>;
    runtimeReady: Record<string, boolean> | null;
    /**
     * Per-runtime state, when the host has it. `runtimeReady` alone cannot
     * tell a CLI that is not installed from one that could not be checked, and
     * both used to be labelled "not signed in" with a Sign in that goes
     * nowhere. Absent → the boolean's old behaviour.
     */
    runtimeStatus?: Record<string, RuntimeStatus> | null;
    companies: ReadonlyArray<{ companyUid: string; label: string; iconUrl?: string | null }>;
    disabled?: boolean;
    onpatch: (patch: Partial<CreateBotDraft>) => void;
    /** Inline browser sign-in; when absent the host handles `onsignin`. */
    signInApi?: RuntimeSignInApi | null;
    /** The user asked to sign in to a runtime (no inline API available). */
    onsignin?: (runtime: BotRuntime) => void | Promise<void>;
    /** The inline sign-in connected — the host should refresh readiness. */
    onsignedin?: (runtime: BotRuntime) => void | Promise<void>;
    /** Re-run the runtime check (after installing, or a failed probe). */
    onrecheck?: () => void | Promise<void>;
    pollMs?: number;
    /**
     * Live AiTools payload (`detect_ai_tools` on the host). Needed by the
     * install-choice panel to know whether Claude Desktop or the ChatGPT
     * desktop app is available on this computer. `null` while the probe is
     * in flight; the panel renders a neutral "Checking…" line then.
     */
    aiTools?: AiTools | null;
    /**
     * Fixed HQ folder path — passed to `claude://code/new?folder=` when the
     * "Set up with Claude" button dispatches. Optional; the URL builder
     * simply omits `folder` when not set.
     */
    hqFolderPath?: string;
    /**
     * Open one of the assistant desktop apps with the install prompt
     * pre-filled. The URL is already a validated `claude://` or `codex://`
     * deep link. The wizard host wires this to `open_claude_code_link` /
     * `open_codex_deep_link` via the install-guide adapter.
     */
    onopenassistant?: (
      assistant: AssistantId,
      url: string,
    ) => Promise<InstallOutcome>;
    /**
     * Run HQ's own one-click installer (fallback when neither assistant
     * app is here). Wired to the same `install_claude_code` / `install_codex`
     * commands the setup assistant uses.
     */
    onassistedinstall?: (tool: CodingTool) => Promise<InstallOutcome>;
    /**
     * Ask the host to (re-)probe `detect_ai_tools`. Called on mount so the
     * check is lazy — it runs when the wizard actually needs it, not on
     * every app open. The parent updates `aiTools` when the probe lands;
     * `null` while it is in flight leaves InstallChoice's neutral
     * "Checking…" line on screen with the retry ("Check again") still
     * clickable, so the wizard is never blocked.
     */
    onrequestaitools?: () => void;
  }

  let {
    draft,
    canLocal,
    canCloud,
    cloudAlwaysShown = false,
    cloudBlocked = null,
    companyBlocks = {},
    runtimeReady,
    runtimeStatus = null,
    companies,
    disabled = false,
    onpatch,
    signInApi = null,
    onsignin,
    onsignedin,
    onrecheck,
    pollMs = 1500,
    aiTools = null,
    hqFolderPath = "",
    onopenassistant,
    onassistedinstall,
    onrequestaitools,
  }: Props = $props();

  // Lazy probe: only the wizard's own mount triggers `detect_ai_tools`,
  // never the app's boot. Fires exactly once per open — the parent's
  // `onrecheck` handles subsequent retries.
  onMount(() => {
    if (aiTools == null) onrequestaitools?.();
  });

  /** Runtime whose inline sign-in is open. */
  let signingIn = $state<BotRuntime | null>(null);
  /** True while a Check again / Try again is in flight. */
  let rechecking = $state(false);

  /**
   * The plain-language name for the host machine ("Mac", "PC", or
   * "computer"). The Windows test persona read "on this computer" here
   * because `apps/sync` does not inject `__HQ_HOST_OS__` synchronously (the
   * way `apps/work` does), so the first render sees an unresolved probe.
   * Subscribe to the shared helper: the initial read still lands
   * synchronously (so a resolved probe never flashes a neutral noun), and
   * once the OS plugin lands the subscription flips this value from
   * "computer" to "Mac" / "PC" and the whole panel updates.
   */
  let hostNoun = $state(hostComputerNoun());
  onMount(() => subscribeHostComputerNoun((next) => (hostNoun = next)));
  const draftStatus = $derived(runtimeStatusOf(runtimeStatus, draft.runtime));
  const draftLabel = $derived(LOCAL_BOT_RUNTIMES.find((r) => r.id === draft.runtime)?.label ?? draft.runtime);
  const footer = $derived(runtimeFooter(draftStatus, draftLabel, draft.runtime, Boolean(signInApi || onsignin), hostNoun));

  async function recheck(): Promise<void> {
    if (rechecking || !onrecheck) return;
    rechecking = true;
    try {
      await onrecheck();
    } finally {
      rechecking = false;
    }
  }

  function pickHome(home: BotHome): void {
    if (disabled) return;
    if (home === "local" && !canLocal) return;
    if (home === "cloud" && !canCloud) return;
    onpatch({ home });
  }

  function pickRuntime(runtime: BotRuntime): void {
    if (disabled) return;
    onpatch({ home: "local", runtime });
  }

  async function requestSignIn(runtime: BotRuntime): Promise<void> {
    if (disabled) return;
    // Never open a sign-in for a runtime whose binary was not found: it cannot
    // succeed, and the modal sits on "Opening … sign-in…" for ever.
    if (!runtimeCanSignIn(runtimeStatusOf(runtimeStatus, runtime))) return;
    onpatch({ home: "local", runtime });
    if (signInApi) {
      signingIn = runtime;
      return;
    }
    await onsignin?.(runtime);
  }

  async function connected(runtime: BotRuntime): Promise<void> {
    await onsignedin?.(runtime);
    signingIn = null;
  }

  function onHomeKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const next: BotHome = draft.home === "local" ? "cloud" : "local";
    if (next === "cloud" && !canCloud) return;
    if (next === "local" && !canLocal) return;
    pickHome(next);
    (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-home="${next}"]`)?.focus();
  }

  function onCompanyKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(
      (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
    );
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? buttons[(at + 1) % buttons.length] : buttons[(at - 1 + buttons.length) % buttons.length];
    event.preventDefault();
    next?.focus();
  }
</script>

<div class="cb-step" data-testid="create-bot-home-step">
  <div class="cb-cards home-cards" role="radiogroup" aria-label="Where does it run?" data-testid="chat-bot-where" tabindex="-1" onkeydown={onHomeKey}>
    <button
      type="button"
      class="cb-card home-card"
      role="radio"
      aria-checked={draft.home === "local"}
      data-testid="chat-bot-where-local"
      data-home="local"
      disabled={disabled || !canLocal}
      tabindex={draft.home === "local" ? 0 : -1}
      onclick={() => pickHome("local")}
    >
      <span class="cb-card-row">
        <span class="cb-card-title">Local</span>
        <span class="cb-card-meta">Free</span>
      </span>
      <span class="cb-card-sub">
        {canLocal
          ? `Runs on this ${hostNoun} with your own login. Works while this ${hostNoun} is on. Message it from your phone.`
          : `Bots can't run on this ${hostNoun}.`}
      </span>
    </button>
    {#if canCloud || cloudAlwaysShown}
      <button
        type="button"
        class="cb-card home-card"
        role="radio"
        aria-checked={draft.home === "cloud"}
        data-testid="chat-bot-where-cloud"
        data-home="cloud"
        data-unavailable={canCloud ? undefined : "true"}
        disabled={disabled || !canCloud}
        tabindex={draft.home === "cloud" ? 0 : -1}
        onclick={() => pickHome("cloud")}
      >
        <span class="cb-card-row">
          <span class="cb-card-title">Cloud</span>
          <span class="cb-card-meta">Company credits</span>
        </span>
        <span class="cb-card-sub">
          {#if canCloud}
            Always on, hosted by {companies.length === 1 ? companies[0]?.label : "your company"}. Runs even when this {hostNoun} is off.
          {:else}
            <span data-testid="chat-bot-where-cloud-reason">{cloudBlocked?.reason ?? "Cloud bots aren't available right now."}</span>
          {/if}
        </span>
      </button>
    {/if}
  </div>
  {#if cloudAlwaysShown && !canCloud && cloudBlocked?.fix?.kind === "checkout"}
    <!-- Outside the disabled card so the link stays clickable. -->
    <p class="cb-help cloud-fix">
      <a class="cb-pill-link" href={cloudBlocked.fix.url} target="_blank" rel="noopener noreferrer" data-testid="chat-bot-where-cloud-fix">{cloudBlocked.fix.label}</a>
    </p>
  {/if}

  {#if draft.home === "local" && canLocal}
    <div class="cb-field">
      <span class="cb-label" id="create-bot-runtime-label">Thinks with</span>
      <div class="cb-pills" role="radiogroup" aria-labelledby="create-bot-runtime-label">
        {#each LOCAL_BOT_RUNTIMES as rt (rt.id)}
          {@const status = runtimeStatusOf(runtimeStatus, rt.id)}
          {@const ready = status ? status.state === "signedIn" : runtimeIsReady(runtimeReady, rt.id)}
          {@const suffix = status ? runtimeChipSuffix(status) : ready ? "" : " · not signed in"}
          <button
            type="button"
            class="cb-pill"
            role="radio"
            aria-checked={draft.runtime === rt.id}
            data-testid={`chat-bot-runtime-${rt.id}`}
            data-ready={ready}
            data-runtime-state={status?.state ?? (ready ? "signedIn" : "signedOut")}
            disabled={disabled}
            onclick={() => pickRuntime(rt.id)}
          >
            <span class="cb-pill-dot" class:ready aria-hidden="true"></span>
            {rt.label}{suffix}
          </button>
        {/each}
      </div>
      {#if signingIn && signInApi}
        <RuntimeSignIn runtime={signingIn} api={signInApi} {pollMs} onconnected={connected} oncancel={() => (signingIn = null)} />
      {:else if draftStatus && draftStatus.state === "notInstalled" && draft.runtime !== "grok" && onopenassistant && onassistedinstall && onrecheck}
        <!--
          Operator-directed replacement for the old "Install it from
          claude.ai/download, or run npm i -g @anthropic-ai/claude-code"
          footer. The person never sees a terminal command; instead, when a
          coding assistant desktop app is on this computer, HQ offers a
          button that opens it with an install prompt already pre-filled.
          Falls back to HQ's own one-click installer when no assistant app
          is here. Kept alongside "Check again" per repo policy
          `hq-desktop-app-failed-state-assisted-recovery-preserve-retry`.
        -->
        <InstallChoice
          tool={draft.runtime === "codex" ? "codex" : "claude"}
          tools={aiTools}
          noun={hostNoun}
          hqFolder={hqFolderPath}
          searched={draftStatus.searched}
          disabled={disabled}
          onopenassistant={onopenassistant}
          oninstall={(tool) => onassistedinstall(tool)}
          onrecheck={async () => {
            onrequestaitools?.();
            await onrecheck();
          }}
        />
      {:else if draftStatus}
        <p
          class="cb-help"
          class:ok={draftStatus.state === "signedIn"}
          class:error={footer.isError}
          data-testid="chat-bot-runtime-help"
          data-runtime-state={draftStatus.state}
        >
          {footer.text}
          {#if footer.action === "signin"}
            <button type="button" class="cb-pill-link" data-testid="chat-bot-runtime-signin" disabled={disabled} onclick={() => void requestSignIn(draft.runtime)}>{footer.actionLabel}</button>
          {:else if footer.action === "retry" && onrecheck}
            <button type="button" class="cb-pill-link" data-testid="chat-bot-runtime-recheck" disabled={disabled || rechecking} onclick={() => void recheck()}>{rechecking ? "Checking…" : footer.actionLabel}</button>
          {/if}
        </p>
        {#if draftStatus.state === "notInstalled" && draftStatus.searched && draftStatus.searched.length > 0}
          <!--
            Defence in depth: dedupe again at render time. A repeated key in
            this each block throws `svelte.dev/e/each_key_duplicate` and
            replaces the wizard with the app's error boundary — the exact
            crash a Windows persona hit on this screen. The Rust side
            already dedupes and `parseRuntimeStatus` dedupes at the parse
            boundary, but a UI list of plain strings must not be able to
            crash the app no matter where a repeat comes from.
          -->
          <details class="cb-help searched" data-testid="chat-bot-runtime-searched">
            <summary>Where HQ looked</summary>
            <ul>
              {#each dedupeSearchedDirs(draftStatus.searched) as dir (dir)}
                <li>{dir}</li>
              {/each}
            </ul>
          </details>
        {/if}
      {:else if !runtimeIsReady(runtimeReady, draft.runtime)}
        <p class="cb-help" data-testid="chat-bot-runtime-help" data-runtime-state="signedOut">
          {draftLabel} is not signed in on this {hostNoun}.
          {#if signInApi || onsignin}
            <button type="button" class="cb-pill-link" data-testid="chat-bot-runtime-signin" disabled={disabled} onclick={() => void requestSignIn(draft.runtime)}>Sign in</button>
          {:else}
            Sign in under Settings → AI tools, or pick another.
          {/if}
        </p>
      {:else}
        <p class="cb-help ok" data-testid="chat-bot-runtime-help" data-runtime-state="signedIn">Signed in on this {hostNoun} - the bot uses your own {draftLabel} plan.</p>
      {/if}
    </div>

  {:else if draft.home === "cloud" && canCloud}
    {#if companies.length > 1}
      <div class="cb-field">
        <span class="cb-label" id="create-bot-company-label">Company</span>
        <div
          class="company-picker"
          role="listbox"
          aria-labelledby="create-bot-company-label"
          aria-label="Add a bot to which company?"
          data-testid="chat-create-agent-picker"
          tabindex="-1"
          onkeydown={onCompanyKey}
        >
          {#each companies as company (company.companyUid)}
            {@const block = companyBlocks[company.companyUid]}
            <button
              type="button"
              class="cb-card company-row"
              role="option"
              aria-selected={draft.companyUid === company.companyUid}
              data-testid="chat-create-agent-company"
              data-company={company.companyUid}
              title={block?.reason}
              disabled={disabled || !!block}
              onclick={() => onpatch({ home: "cloud", companyUid: company.companyUid })}
            >
              <span class="company-tile" aria-hidden="true">
                {#if company.iconUrl}
                  <img src={company.iconUrl} alt="" />
                {:else}
                  {initialsFor(company.label)}
                {/if}
              </span>
              <span class="cb-card-title">{company.label}</span>
              {#if block}
                <span class="cb-card-sub" data-testid="chat-create-agent-company-reason">{block.reason}</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}
    <p class="cb-help">Hosted by {companies.find((c) => c.companyUid === draft.companyUid)?.label ?? "the company"} and always on. You name it on the next step; it gets its own channel once it is set up.</p>
  {/if}
</div>

<style>
  .cb-help.error {
    color: var(--v4-error, #d9534f);
  }
  .cb-help.searched {
    margin-top: 4px;
  }
  .cb-help.searched summary {
    cursor: pointer;
  }
  .cb-help.searched ul {
    margin: 4px 0 0;
    padding-left: 18px;
    line-height: 1.5;
  }
  .cloud-fix {
    text-align: right;
  }
  .home-cards {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
  .home-card {
    min-height: 92px;
  }
  .company-picker {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .company-row {
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
  }
  .company-tile {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: var(--v4-control-faint, rgba(127, 127, 127, 0.12));
    color: var(--t2);
    font-size: 10px;
    font-weight: 600;
    overflow: hidden;
    flex: 0 0 auto;
  }
  .company-tile img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
