<script lang="ts">
  /**
   * Right-hand profile sheet for one of the user's LOCAL bots (this Mac, the
   * user's own Claude Code / Codex / Grok login). Mirrors AgentDetailPanel's
   * shell and header so a bot reads the same whether it is cloud or local;
   * the body is the local supervisor's truth (presence, heartbeat, runtime,
   * memory folder) and every action shells through adapter.bots.
   *
   * Avatar is read-only here: local bots have no hq-pro profile to save a
   * pack selection against, so the mark renders the monogram/known avatar.
   */
  import type { LocalBotRow, PlatformAdapter } from "@hq/platform";
  import IdentityMark from "./messaging/IdentityMark.svelte";
  import BotKindChip from "./BotKindChip.svelte";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import {
    lastHeartbeatLabel,
    localBotKindLabel,
    localBotOfflineNotice,
    localBotPresence,
    localBotRuntimeLabel,
  } from "./local-bots.js";
  import { botNeedsSignIn, expiredRuntimeOf } from "./runtime-sign-in-again.js";
  import {
    DEFAULT_LOCAL_BOT_EFFORT,
    LOCAL_BOT_SETTINGS,
    effortLabel,
    modelChoicesFor,
    thinksWithLine,
  } from "./local-bot-settings.js";
  import "./tokens.css";
  import "./chat-tokens.css";

  interface Props {
    bot: LocalBotRow;
    adapter: Pick<PlatformAdapter, "bots"> | { bots?: PlatformAdapter["bots"] };
    avatarUrl?: string | null;
    /** Cloud companies the owner is in; `slug` lets a company bot's list narrow the promote targets. */
    companies?: Array<{ uid: string; name: string; slug?: string }>;
    onopenurl?: (url: string) => void;
    onclose?: () => void;
    /** Fired after a successful Start/Stop/Remove so the host refreshes localBots. */
    onchanged?: () => void | Promise<void>;
  }

  let { bot, adapter, avatarUrl = null, companies = [], onopenurl, onclose, onchanged }: Props = $props();

  let busy = $state<"start" | "stop" | "remove" | null>(null);
  let actionError = $state<string | null>(null);
  let confirmRemove = $state(false);
  let copied = $state(false);
  let promotionCompany = $state("");
  let promoting = $state(false);
  let promotionPhase = $state("");
  let promotionError = $state<string | null>(null);
  let pairing = $state<{ url: string; code: string } | null>(null);
  /** A company bot can only be promoted into a company it belongs to; older rows keep every company. */
  const promotionCompanies = $derived.by(() => {
    const own = new Set((bot.companies ?? []).map((c) => c.trim()).filter(Boolean));
    if (own.size === 0) return companies;
    const narrowed = companies.filter((c) => c.slug && own.has(c.slug));
    return narrowed.length ? narrowed : companies;
  });
  const transferBlocked = $derived(Boolean(promotionError?.startsWith("Bot continuity:")));
  const promotionStatus = $derived(pairing ? "Action needed: connect ChatGPT" : promotionPhase === "active" ? "Running in the cloud" : ["imported", "cloud-ready"].includes(promotionPhase) ? "Starting your cloud bot" : "Preparing your bot for the cloud");
  async function promote(): Promise<void> {
    const uid = bot.agentUid;
    if (!adapter.bots?.promote || promoting || !promotionCompany) return;
    promoting = true; promotionError = null;
    try {
      const result = await adapter.bots.promote(bot.name, promotionCompany);
      if (bot.agentUid !== uid) return;
      if (!result.ok) { promotionError = result.message || "Could not continue promotion."; return; }
      const state = result.value.promotion as { agentUid?: string; phase?: string } | undefined;
      if (state?.agentUid !== uid || !state.phase) throw new Error("Promotion returned an unexpected bot identity.");
      promotionPhase = state.phase;
      if (typeof result.value.failure === "string") promotionError = result.value.failure;
      const candidate = result.value.pairing as { url?: string; code?: string } | null;
      pairing = candidate && ["https://auth.openai.com/codex/device", "https://auth.openai.com/device"].includes(candidate.url ?? "") && /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/.test(candidate.code ?? "")
        ? { url: candidate.url!, code: candidate.code! } : null;
      await onchanged?.();
    } catch (error) { if (bot.agentUid === uid) promotionError = error instanceof Error ? error.message : "Could not continue promotion."; }
    finally { if (bot.agentUid === uid) promoting = false; }
  }
  let displayedUid = $state("");
  $effect(() => {
    if (displayedUid !== bot.agentUid) {
      displayedUid = bot.agentUid;
      promotionCompany = bot.promotionHold?.companyUid ?? "";
      promotionPhase = bot.promotionHold ? "pending" : "";
      pairing = null;
      promotionError = null;
      promoting = false;
    } else if (bot.promotionHold && !promotionPhase) {
      promotionCompany = bot.promotionHold.companyUid ?? "";
      promotionPhase = "pending";
    }
  });
  // Provisioning continues while this profile is open. Each call only queues a
  // bounded cloud step; closing the profile stops polling but preserves the hold.
  $effect(() => {
    if (!promotionPhase || promotionPhase === "active" || promoting || promotionError || !promotionCompany) return;
    const timer = window.setTimeout(() => void promote(), 15_000);
    return () => window.clearTimeout(timer);
  });
  let panelEl = $state<HTMLElement | null>(null);

  // What the bot thinks with. Drafts follow the bot until the person edits
  // them; Save applies from the bot's next message (no restart).
  const savedModel = $derived(bot.model?.trim() ?? "");
  const savedEffort = $derived(bot.effort?.trim() || DEFAULT_LOCAL_BOT_EFFORT);
  let draftModel = $state<string | null>(null);
  let draftEffort = $state<string | null>(null);
  let savingSettings = $state(false);
  let settingsNote = $state<string | null>(null);
  const modelValue = $derived(draftModel ?? savedModel);
  const effortValue = $derived(draftEffort ?? savedEffort);
  const settingsDirty = $derived(modelValue !== savedModel || effortValue !== savedEffort);
  const modelChoices = $derived(modelChoicesFor(bot));
  const effortChoices = $derived(LOCAL_BOT_SETTINGS[bot.runtime].efforts);

  async function saveSettings(): Promise<void> {
    const api = adapter.bots;
    if (!api?.configure || savingSettings || promoting || promotionPhase || !settingsDirty) return;
    savingSettings = true;
    settingsNote = null;
    actionError = null;
    try {
      const result = await api.configure(bot.name, {
        ...(modelValue !== savedModel ? { model: modelValue || null } : {}),
        // Picking the default level resets it, so a later change of default applies.
        ...(effortValue !== savedEffort ? { effort: effortValue === DEFAULT_LOCAL_BOT_EFFORT ? null : effortValue } : {}),
      });
      if (!result.ok) {
        actionError = result.message || `Could not change what ${bot.name} thinks with.`;
        return;
      }
      await onchanged?.();
      draftModel = null;
      draftEffort = null;
      settingsNote = "Saved. Applies from its next message.";
    } catch (error) {
      actionError = error instanceof Error ? error.message : `Could not change what ${bot.name} thinks with.`;
    } finally {
      savingSettings = false;
    }
  }

  const presence = $derived(
    localBotPresence([bot], { kind: "dm", personUid: bot.agentUid }) ?? "offline",
  );
  const heartbeat = $derived(lastHeartbeatLabel(bot.lastHeartbeatAt, Date.now()));
  const presenceLine = $derived.by(() => {
    if (botNeedsSignIn(bot)) return `Needs sign-in · ${localBotRuntimeLabel(expiredRuntimeOf(bot))}`;
    if (presence === "online") return heartbeat ? `Online · ${heartbeat}` : "Online";
    if (bot.processAlive && bot.state !== "failed") {
      return heartbeat ? `Starting up · ${heartbeat}` : "Starting up";
    }
    return heartbeat ? `Offline · ${heartbeat}` : "Offline · never checked in";
  });
  const memoryPath = $derived(bot.memoryDir?.trim() || `personal/workers/${bot.name}/memory`);
  const startedFrom = $derived(
    bot.workerId ? `${bot.workerId}${bot.companySlug ? ` · ${bot.companySlug}` : ""}` : null,
  );

  async function run(verb: "start" | "stop" | "remove"): Promise<void> {
    const api = adapter.bots;
    if (!api || busy) return;
    busy = verb;
    actionError = null;
    try {
      const result = await api[verb](bot.name);
      if (!result.ok) {
        actionError = result.message || `Could not ${verb} ${bot.name}.`;
        return;
      }
      await onchanged?.();
      if (verb === "remove") onclose?.();
    } catch (error) {
      actionError = error instanceof Error ? error.message : `Could not ${verb} ${bot.name}.`;
    } finally {
      busy = null;
    }
  }

  async function copyUid(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(bot.agentUid);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      /* clipboard unavailable — the uid is still selectable text */
    }
  }
</script>

<aside
  bind:this={panelEl}
  class="agent-panel"
  aria-label={`${bot.name} bot`}
  data-testid="local-bot-detail"
  data-bot={bot.name}
  tabindex="-1"
>
  <header class="ad-head">
    <span class="ad-title">Bot</span>
    <button
      type="button"
      class="ad-close"
      data-testid="local-bot-detail-close"
      aria-label="Close bot"
      onclick={() => onclose?.()}
    >
      ×
    </button>
  </header>

  <div class="ad-body">
    <div class="ad-identity">
      <IdentityMark
        kind="agent"
        label={bot.name}
        agentUid={bot.agentUid}
        {avatarUrl}
        online={presence === "online"}
        size="regular"
      />
      <div class="ad-identity-copy">
        <h2 class="ad-name" data-testid="local-bot-detail-name">
          {bot.name}
          <BotKindChip kind="local" runtime={bot.runtime} size="md" variant="label" />
        </h2>
        <p class="ad-status" data-testid="local-bot-detail-presence" data-presence={presence}>
          {presenceLine}
        </p>
      </div>
    </div>

    {#if botNeedsSignIn(bot)}
      <p class="ad-desc" data-testid="local-bot-detail-notice">
        {localBotRuntimeLabel(expiredRuntimeOf(bot))} needs you to sign in again before {bot.name} can keep
        working. Open its conversation to sign in.
      </p>
    {:else if presence !== "online"}
      <p class="ad-desc" data-testid="local-bot-detail-notice">
        {localBotOfflineNotice(bot)}
      </p>
    {/if}

    <dl class="ad-meta">
      <div>
        <dt>Runs with</dt>
        <dd data-testid="local-bot-detail-runtime">{localBotRuntimeLabel(bot.runtime)}</dd>
      </div>
      <div>
        <dt>Thinks with</dt>
        <dd data-testid="local-bot-detail-model">{thinksWithLine({ runtime: bot.runtime, model: bot.model, effort: savedEffort })}</dd>
      </div>
      {#if startedFrom}
        <div>
          <dt>Started from</dt>
          <dd data-testid="local-bot-detail-worker">{startedFrom}</dd>
        </div>
      {/if}
      <div>
        <dt>Memory</dt>
        <dd>
          <code class="ad-path" data-testid="local-bot-detail-memory">{memoryPath}</code>
        </dd>
      </div>
      <div>
        <dt>Runs on</dt>
        <dd>This Mac{bot.daemonInstalled ? " · starts at login" : ""}</dd>
      </div>
      {#if localBotKindLabel(bot)}
        <div>
          <dt>Kind</dt>
          <dd data-testid="local-bot-detail-kind">{localBotKindLabel(bot)}</dd>
        </div>
      {/if}
      <div>
        <dt>UID</dt>
        <dd>
          <button
            type="button"
            class="ad-uid"
            data-testid="local-bot-detail-uid"
            title="Copy uid"
            onclick={() => void copyUid()}
          >
            {bot.agentUid}
            <span class="ad-uid-hint">{copied ? "copied" : "copy"}</span>
          </button>
        </dd>
      </div>
    </dl>

    {#if adapter.bots?.configure}
      <section class="ad-section" data-testid="local-bot-detail-settings">
        <h3 class="ad-kicker">Model and thinking</h3>
        <label class="ad-field">
          <span>Model</span>
          <select
            data-testid="local-bot-detail-model-select"
            value={modelValue}
            disabled={savingSettings || promoting || Boolean(promotionPhase)}
            onchange={(event) => {
              draftModel = (event.currentTarget as HTMLSelectElement).value;
              settingsNote = null;
            }}
          >
            {#each modelChoices as choice (choice.value)}
              <option value={choice.value}>{choice.label}</option>
            {/each}
          </select>
        </label>
        <label class="ad-field">
          <span>Thinking</span>
          <select
            data-testid="local-bot-detail-effort-select"
            value={effortValue}
            disabled={savingSettings || promoting || Boolean(promotionPhase)}
            onchange={(event) => {
              draftEffort = (event.currentTarget as HTMLSelectElement).value;
              settingsNote = null;
            }}
          >
            {#each effortChoices as level (level)}
              <option value={level}>{effortLabel(level)}</option>
            {/each}
          </select>
        </label>
        <div class="ad-danger-row">
          <button
            type="button"
            class="ad-btn"
            data-testid="local-bot-detail-settings-save"
            disabled={!settingsDirty || savingSettings}
            onclick={() => void saveSettings()}
          >
            {savingSettings ? "Saving…" : "Save"}
          </button>
          {#if settingsNote}
            <span class="ad-muted" role="status" data-testid="local-bot-detail-settings-note">{settingsNote}</span>
          {/if}
        </div>
      </section>
    {/if}

    {#if bot.kind === "personal"}
      <section class="ad-section" data-testid="local-bot-promotion-personal">
        <h3 class="ad-kicker">Cloud hosting</h3>
        <p class="ad-muted">Personal bots stay on this Mac.</p>
      </section>
    {:else if adapter.bots?.promote && promotionCompanies.length}
      <section class="ad-section" data-testid="local-bot-promotion">
        <h3 class="ad-kicker">Cloud hosting</h3>
        <p class="ad-muted">Your bot keeps its identity, conversation, skills, and memory. We prepare its cloud computer, ask you to connect ChatGPT, then move this conversation over.</p>
        <label class="ad-field"><span>Company</span>
          <select value={promotionCompany} onchange={(event) => { promotionCompany = event.currentTarget.value; }} disabled={promoting || Boolean(promotionPhase)} aria-label="Promotion company">
            <option value="">Choose company</option>
            {#each promotionCompanies as company (company.uid)}<option value={company.uid}>{company.name}</option>{/each}
          </select>
        </label>
        {#if promotionPhase || promoting}
          <p role="status"><strong>{promotionError ? "Promotion paused" : promotionStatus}</strong></p>
        {/if}
        {#if pairing}
          <p class="ad-muted">Open the sign-in page and enter <strong>{pairing.code}</strong>. Sign in with the ChatGPT subscription you want this cloud bot to use. Return here afterward; we will continue automatically.</p>
          <button class="ad-btn" onclick={() => onopenurl?.(pairing!.url)} disabled={!onopenurl}>Connect ChatGPT</button>
        {/if}
        {#if promotionPhase === "active"}
          <p role="status">Promoted. Continue in this conversation.</p>
        {:else}
          <button class="ad-btn" disabled={promoting || !promotionCompany || Boolean(busy)} onclick={() => void promote()}>
            {promoting ? "Preparing cloud promotion…" : promotionError ? "Retry promotion" : promotionPhase ? "Check progress" : "Promote to cloud"}
          </button>
          {#if promotionError}
            <div role="alert" data-testid="local-bot-promotion-error">
              <p>{transferBlocked ? "HQ could not prepare this bot’s files for transfer. This requires an HQ update; retrying the same version will not fix it." : "This step did not finish. Retry promotion to continue from the saved step."}</p>
              <details><summary>Technical details</summary><p class="ad-error">{promotionError}</p></details>
            </div>
          {/if}
          {#if promotionPhase}<p class="ad-muted">{promotionError ? "Your bot has not moved to the cloud. Its local run is paused and its files are still on this Mac." : "Keep this profile open while we finish. Your local bot is paused so only one copy can answer."}</p>{/if}
        {/if}
      </section>
    {/if}

    <section class="ad-section" data-testid="local-bot-detail-actions">
      <h3 class="ad-kicker">Manage</h3>
      {#if !adapter.bots}
        <p class="ad-muted">Start, stop, and remove this bot from the HQ desktop app on its Mac.</p>
      {:else}
        <div class="ad-danger-row">
          {#if bot.processAlive}
            <button
              type="button"
              class="ad-btn"
              data-testid="local-bot-detail-stop"
              disabled={Boolean(busy) || promoting || Boolean(promotionPhase)}
              onclick={() => void run("stop")}
            >
              {busy === "stop" ? "Stopping…" : "Stop"}
            </button>
          {:else}
            <button
              type="button"
              class="ad-btn"
              data-testid="local-bot-detail-start"
              disabled={Boolean(busy) || promoting || Boolean(promotionPhase)}
              onclick={() => void run("start")}
            >
              {busy === "start" ? "Starting…" : "Start"}
            </button>
          {/if}
          <button
            type="button"
            class="ad-text-btn danger"
            data-testid="local-bot-detail-remove"
            disabled={Boolean(busy) || promoting || Boolean(promotionPhase)}
            onclick={() => (confirmRemove = true)}
          >
            {busy === "remove" ? "Removing…" : "Remove"}
          </button>
        </div>
      {/if}
      {#if actionError}
        <p class="ad-error" data-testid="local-bot-detail-error">{actionError}</p>
      {/if}
    </section>
  </div>
</aside>

<ConfirmDialog
  open={confirmRemove}
  title="Remove this bot?"
  message={`Stops ${bot.name}, uninstalls its login item, and removes it from HQ. Its memory folder stays on disk.`}
  confirmLabel="Remove"
  danger
  onconfirm={() => {
    confirmRemove = false;
    void run("remove");
  }}
  oncancel={() => (confirmRemove = false)}
/>

<style>
  .agent-panel {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    background: var(--v4-ground, #161618);
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui);
    outline: none;
  }

  .ad-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 0 auto;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line);
  }

  .ad-title {
    color: var(--t1);
    font-size: 13px;
    font-weight: 600;
  }

  .ad-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .ad-close:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .ad-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px 16px 28px;
  }

  .ad-identity {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .ad-identity-copy {
    min-width: 0;
  }

  .ad-name {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0;
    color: var(--t1);
    font-size: 16px;
    font-weight: 650;
    line-height: 1.3;
  }

  .ad-status {
    margin: 2px 0 0;
    color: var(--t3);
    font: 500 10px/1.3 var(--font-mono, ui-monospace, Menlo, monospace);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .ad-status[data-presence="online"] {
    color: var(--v4-ok, #42d77d);
  }

  .ad-desc {
    margin: 0;
    color: var(--t2);
    font-size: 13px;
    line-height: 1.45;
  }

  .ad-meta {
    display: grid;
    gap: 8px;
    margin: 0;
  }

  .ad-meta div {
    min-width: 0;
  }

  .ad-meta dt,
  .ad-kicker {
    color: var(--t3);
    font: 500 10px/1.2 var(--font-mono, ui-monospace, Menlo, monospace);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .ad-meta dd {
    margin: 2px 0 0;
    color: var(--t1);
    font-size: 13px;
  }

  .ad-path {
    display: inline-block;
    max-width: 100%;
    overflow-wrap: anywhere;
    color: var(--t2);
    font: 12px/1.4 var(--font-mono, ui-monospace, Menlo, monospace);
  }

  .ad-uid {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--t2);
    font: 12px/1.4 var(--font-mono, ui-monospace, Menlo, monospace);
    cursor: pointer;
    overflow-wrap: anywhere;
    text-align: left;
  }

  .ad-uid-hint {
    color: var(--t3);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .ad-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }

  .ad-kicker {
    margin: 0;
  }

  .ad-muted {
    margin: 0;
    color: var(--t3);
    font-size: 12px;
  }

  .ad-btn,
  .ad-text-btn {
    appearance: none;
    -webkit-appearance: none;
    padding: 6px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .ad-btn {
    border-color: var(--line);
  }

  .ad-text-btn {
    padding: 4px 0;
    color: var(--t2);
  }

  .ad-btn:disabled,
  .ad-text-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .ad-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--t2);
    font-size: 12px;
  }

  .ad-field select {
    min-width: 0;
    max-width: 60%;
    padding: 4px 6px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 12px;
  }

  .ad-field select:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
  }

  .ad-danger-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  .ad-error {
    margin: 0;
    color: var(--t2);
    font-size: 12px;
  }

  .ad-close:focus-visible,
  .ad-uid:focus-visible,
  .ad-btn:focus-visible,
  .ad-text-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
  }
</style>
