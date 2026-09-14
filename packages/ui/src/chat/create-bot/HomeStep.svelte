<script lang="ts">
  /**
   * Step B — Where does it run? Local (this Mac, free, the user's own
   * runtime login) or Cloud (company-hosted, always on). Local shows runtime
   * pills with sign-in state and an inline Sign in; Cloud shows the company
   * picker. Cloud is hidden entirely when no company can take a bot.
   */
  import { initialsFor } from "../sidebar-model.js";
  import { LOCAL_BOT_RUNTIMES } from "../local-bots.js";
  import RuntimeSignIn, { type RuntimeSignInApi } from "./RuntimeSignIn.svelte";
  import { runtimeIsReady, type BotHome, type BotRuntime, type CreateBotDraft } from "./create-bot-model.js";
  import "./create-bot.css";

  interface Props {
    draft: CreateBotDraft;
    canLocal: boolean;
    canCloud: boolean;
    runtimeReady: Record<string, boolean> | null;
    companies: ReadonlyArray<{ companyUid: string; label: string; iconUrl?: string | null }>;
    disabled?: boolean;
    onpatch: (patch: Partial<CreateBotDraft>) => void;
    /** Inline browser sign-in; when absent the host handles `onsignin`. */
    signInApi?: RuntimeSignInApi | null;
    /** The user asked to sign in to a runtime (no inline API available). */
    onsignin?: (runtime: BotRuntime) => void | Promise<void>;
    /** The inline sign-in connected — the host should refresh readiness. */
    onsignedin?: (runtime: BotRuntime) => void | Promise<void>;
    pollMs?: number;
  }

  let {
    draft,
    canLocal,
    canCloud,
    runtimeReady,
    companies,
    disabled = false,
    onpatch,
    signInApi = null,
    onsignin,
    onsignedin,
    pollMs = 1500,
  }: Props = $props();

  /** Runtime whose inline sign-in is open. */
  let signingIn = $state<BotRuntime | null>(null);

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
          ? "Runs on this Mac with your own login. Works while this computer is on. Message it from your phone."
          : "Bots can't run on this computer."}
      </span>
    </button>
    {#if canCloud}
      <button
        type="button"
        class="cb-card home-card"
        role="radio"
        aria-checked={draft.home === "cloud"}
        data-testid="chat-bot-where-cloud"
        data-home="cloud"
        disabled={disabled}
        tabindex={draft.home === "cloud" ? 0 : -1}
        onclick={() => pickHome("cloud")}
      >
        <span class="cb-card-row">
          <span class="cb-card-title">Cloud</span>
          <span class="cb-card-meta">Company credits</span>
        </span>
        <span class="cb-card-sub">
          Always on, hosted by {companies.length === 1 ? companies[0]?.label : "your company"}. Set up in the company channel.
        </span>
      </button>
    {/if}
  </div>

  {#if draft.home === "local" && canLocal}
    <div class="cb-field">
      <span class="cb-label" id="create-bot-runtime-label">Thinks with</span>
      <div class="cb-pills" role="radiogroup" aria-labelledby="create-bot-runtime-label">
        {#each LOCAL_BOT_RUNTIMES as rt (rt.id)}
          {@const ready = runtimeIsReady(runtimeReady, rt.id)}
          <button
            type="button"
            class="cb-pill"
            role="radio"
            aria-checked={draft.runtime === rt.id}
            data-testid={`chat-bot-runtime-${rt.id}`}
            data-ready={ready}
            disabled={disabled}
            onclick={() => pickRuntime(rt.id)}
          >
            <span class="cb-pill-dot" class:ready aria-hidden="true"></span>
            {rt.label}{ready ? "" : " · not signed in"}
          </button>
        {/each}
      </div>
      {#if signingIn && signInApi}
        <RuntimeSignIn runtime={signingIn} api={signInApi} {pollMs} onconnected={connected} oncancel={() => (signingIn = null)} />
      {:else if !runtimeIsReady(runtimeReady, draft.runtime)}
        <p class="cb-help" data-testid="chat-bot-runtime-help">
          {LOCAL_BOT_RUNTIMES.find((r) => r.id === draft.runtime)?.label} is not signed in on this Mac.
          {#if signInApi || onsignin}
            <button type="button" class="cb-pill-link" data-testid="chat-bot-runtime-signin" disabled={disabled} onclick={() => void requestSignIn(draft.runtime)}>Sign in</button>
          {:else}
            Sign in under Settings → AI tools, or pick another.
          {/if}
        </p>
      {:else}
        <p class="cb-help ok" data-testid="chat-bot-runtime-help">Signed in on this Mac — the bot uses your own {LOCAL_BOT_RUNTIMES.find((r) => r.id === draft.runtime)?.label} plan.</p>
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
            <button
              type="button"
              class="cb-card company-row"
              role="option"
              aria-selected={draft.companyUid === company.companyUid}
              data-testid="chat-create-agent-company"
              data-company={company.companyUid}
              disabled={disabled}
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
            </button>
          {/each}
        </div>
      </div>
    {/if}
    <p class="cb-help">Opens the bot setup step in {companies.find((c) => c.companyUid === draft.companyUid)?.label ?? "the company"}'s channel — name, role, and avatar are chosen there.</p>
  {/if}
</div>

<style>
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
