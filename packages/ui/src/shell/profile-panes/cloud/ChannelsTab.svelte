<script lang="ts">
  import type { AgentControlChannel, AgentControlChannelKind } from "@hq/platform";
  import RailIcon from "../../../common/button/RailIcon.svelte";
  import { companyAgentsUrl } from "../../../common/hq-console.js";
  import ControlDialog from "./ControlDialog.svelte";
  import type { CloudTabProps } from "./cloud-bot-tabs.js";
  import { CHANNEL_LABEL, channelsFromPayload, controlError } from "./agent-control-model.js";

  let { uid, control, view, offline, onview, onoffline, onconnect = null, onopenurl = null }: CloudTabProps = $props();

  let pending = $state<AgentControlChannelKind | null>(null);
  let error = $state<string | null>(null);
  let connecting = $state<AgentControlChannelKind | null>(null);

  const CONNECTABLE: readonly AgentControlChannelKind[] = ["slack", "telegram"];

  function stateOf(ch: AgentControlChannel): { tone: "ok" | "error" | "idle"; text: string } {
    if (ch.detail === "pending_restart") return { tone: "idle", text: "Applies when the bot restarts" };
    if (ch.status === "error") return { tone: "error", text: ch.detail ?? "Needs attention" };
    if (ch.status === "connected") return { tone: ch.enabled ? "ok" : "idle", text: ch.enabled ? (ch.detail ?? "On") : "Off" };
    return { tone: "idle", text: "Not connected" };
  }

  async function toggle(ch: AgentControlChannel): Promise<void> {
    if (pending) return;
    const want = !ch.enabled;
    pending = ch.kind;
    error = null;
    const res = await control.updateChannel(uid, ch.kind, { enabled: want });
    if (!res.ok) {
      pending = null;
      const e = controlError(res);
      if (e.offline) onoffline();
      error = e.message;
      return;
    }
    const listed = await control.listChannels(uid);
    pending = null;
    const channels = listed.ok ? channelsFromPayload(listed.value) : view.channels;
    onview({ channels });
    const after = channels.find((c) => c.kind === ch.kind);
    if (!listed.ok || after?.enabled !== want) error = "The bot did not confirm the change. Check again in a moment.";
  }

  function startConnect(kind: AgentControlChannelKind): void {
    connecting = null;
    onconnect?.(kind);
  }
</script>

<section class="cp-section" data-testid="cloud-channels">
  <div class="cp-head"><span class="cp-label">Where this bot talks</span></div>
  <ul class="cp-rows">
    {#each view.channels as ch (ch.kind)}
      {@const st = stateOf(ch)}
      <li class="cp-row" data-testid="cloud-channel-row" data-kind={ch.kind}>
        <div class="cp-row-main">
          <span class="cp-row-title">{CHANNEL_LABEL[ch.kind]}</span>
          <span class="cp-state" data-tone={st.tone} data-testid="cloud-channel-state">{st.text}</span>
        </div>
        <div class="cp-row-side">
          {#if pending === ch.kind}<span class="cp-spin" aria-label="Saving"></span>{/if}
          {#if ch.status === "not_connected" && CONNECTABLE.includes(ch.kind)}
            <button type="button" class="cp-btn" data-testid="cloud-channel-connect" onclick={() => (connecting = ch.kind)}><RailIcon name="plug" />Connect</button>
          {:else if ch.status !== "not_connected" || ch.kind === "hq"}
            <button
              type="button"
              class="cp-switch"
              role="switch"
              aria-checked={ch.enabled}
              aria-label="{CHANNEL_LABEL[ch.kind]} {ch.enabled ? 'on' : 'off'}"
              data-testid="cloud-channel-toggle"
              disabled={pending !== null || offline}
              onclick={() => void toggle(ch)}
            ></button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
  {#if error}<p class="cp-error" role="alert" data-testid="cloud-channels-error">{error}</p>{/if}
</section>

{#if connecting}
  {@const kind = connecting}
  <ControlDialog title="Connect {CHANNEL_LABEL[kind]}" subtitle={view.agent.displayName} testid="cloud-channel-dialog" onclose={() => (connecting = null)}>
    {#if kind === "slack" && onconnect}
      <p class="cp-muted">HQ walks you through it: approve the bot in Slack, then paste one token from Slack's site. The bot connects on its own after that.</p>
    {:else if kind === "slack"}
      <p class="cp-muted">Open this bot's conversation and use its Slack card to connect. The setup runs there.</p>
    {:else}
      <p class="cp-muted">Telegram is set up from the HQ console for now. Once it is connected, you can turn it on and off here.</p>
    {/if}
    {#snippet footer()}
      <span class="cp-grow"></span>
      <button type="button" class="cp-btn quiet" onclick={() => (connecting = null)}><RailIcon name="x" />Cancel</button>
      {#if kind === "slack" && onconnect}
        <button type="button" class="cp-btn primary" data-testid="cloud-channel-start" onclick={() => startConnect(kind)}><RailIcon name="plug" />Start Slack setup</button>
      {:else if kind === "telegram" && onopenurl}
        <button type="button" class="cp-btn primary" data-testid="cloud-channel-console" onclick={() => { onopenurl?.(companyAgentsUrl(null)); connecting = null; }}><RailIcon name="external" />Open HQ console</button>
      {/if}
    {/snippet}
  </ControlDialog>
{/if}
