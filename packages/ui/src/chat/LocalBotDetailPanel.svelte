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
    localBotOfflineNotice,
    localBotPresence,
    localBotRuntimeLabel,
  } from "./local-bots.js";
  import "./tokens.css";
  import "./chat-tokens.css";

  interface Props {
    bot: LocalBotRow;
    adapter: Pick<PlatformAdapter, "bots"> | { bots?: PlatformAdapter["bots"] };
    avatarUrl?: string | null;
    onclose?: () => void;
    /** Fired after a successful Start/Stop/Remove so the host refreshes localBots. */
    onchanged?: () => void | Promise<void>;
  }

  let { bot, adapter, avatarUrl = null, onclose, onchanged }: Props = $props();

  let busy = $state<"start" | "stop" | "remove" | null>(null);
  let actionError = $state<string | null>(null);
  let confirmRemove = $state(false);
  let copied = $state(false);
  let panelEl = $state<HTMLElement | null>(null);

  const presence = $derived(
    localBotPresence([bot], { kind: "dm", personUid: bot.agentUid }) ?? "offline",
  );
  const heartbeat = $derived(lastHeartbeatLabel(bot.lastHeartbeatAt, Date.now()));
  const presenceLine = $derived.by(() => {
    if (presence === "online") return heartbeat ? `Online · ${heartbeat}` : "Online";
    if (bot.processAlive && bot.state !== "failed") {
      return heartbeat ? `Starting up · ${heartbeat}` : "Starting up";
    }
    return heartbeat ? `Offline · ${heartbeat}` : "Offline · never checked in";
  });
  const memoryPath = $derived(`personal/workers/${bot.name}/memory`);
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

    {#if presence !== "online"}
      <p class="ad-desc" data-testid="local-bot-detail-notice">
        {localBotOfflineNotice(bot)}
      </p>
    {/if}

    <dl class="ad-meta">
      <div>
        <dt>Runs with</dt>
        <dd data-testid="local-bot-detail-runtime">{localBotRuntimeLabel(bot.runtime)}</dd>
      </div>
      {#if bot.model}
        <div>
          <dt>Model</dt>
          <dd data-testid="local-bot-detail-model">{bot.model}</dd>
        </div>
      {/if}
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
              disabled={Boolean(busy)}
              onclick={() => void run("stop")}
            >
              {busy === "stop" ? "Stopping…" : "Stop"}
            </button>
          {:else}
            <button
              type="button"
              class="ad-btn"
              data-testid="local-bot-detail-start"
              disabled={Boolean(busy)}
              onclick={() => void run("start")}
            >
              {busy === "start" ? "Starting…" : "Start"}
            </button>
          {/if}
          <button
            type="button"
            class="ad-text-btn danger"
            data-testid="local-bot-detail-remove"
            disabled={Boolean(busy)}
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
