<!--
  OWNER-R3: Invite notetaker on an upcoming meeting with a link, or its
  status and Remove notetaker once one is scheduled. Uses the existing
  meetings-store inviteBot and cancelBot actions.
-->
<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import type { MeetingEvent, ScheduledBot } from "./meetings-model";
  import { meetingsStore } from "./meetings-store.svelte";
  import { notetakerStatus } from "./notetaker-invite";

  interface Props {
    event: MeetingEvent;
    bot?: ScheduledBot;
    /** The meeting's link; without one there is nothing to send the notetaker to. */
    url: string;
  }

  let { event, bot, url }: Props = $props();

  let failed = $state<string | null>(null);
  let lastAction = $state<"invite" | "remove">("invite");
  const status = $derived(notetakerStatus(bot));
  const pending = $derived(meetingsStore.pendingActionsByEventId.has(event.id));

  async function run(action: "invite" | "remove"): Promise<void> {
    if (pending) return;
    lastAction = action;
    failed = null;
    const result = action === "invite" ? await meetingsStore.inviteBot(event) : await meetingsStore.cancelBot(event);
    if (result?.kind === "warn") {
      failed = result.text || (action === "invite" ? "Couldn't invite the notetaker." : "Couldn't remove the notetaker.");
    }
  }
</script>

<span class="nt" data-testid="meeting-notetaker" data-state={pending ? "pending" : failed ? "failed" : status.action}>
  {#if failed}
    <span class="msg" role="alert" data-testid="meeting-notetaker-failed">{failed}</span>
    <button type="button" class="btn" data-testid="meeting-notetaker-retry" onclick={() => void run(lastAction)}><RailIcon name="refresh" />Try again</button>
  {:else if status.action === "invite"}
    <button
      type="button"
      class="btn"
      data-testid="meeting-notetaker-invite"
      disabled={!url || pending}
      aria-busy={pending}
      title={url ? "Sends the notetaker to record and transcribe this meeting" : "This meeting has no link to send the notetaker to"}
      onclick={() => void run("invite")}
    ><RailIcon name="user-plus" />{pending ? "Inviting…" : "Invite notetaker"}</button>
  {:else}
    <span class="msg" data-testid="meeting-notetaker-status">{status.label}</span>
    {#if status.action === "remove"}
      <button type="button" class="btn" data-testid="meeting-notetaker-remove" disabled={pending} aria-busy={pending} onclick={() => void run("remove")}><RailIcon name="trash" />{pending ? "Removing…" : "Remove notetaker"}</button>
    {/if}
  {/if}
</span>

<style>
  .nt { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  .msg { color: var(--t2); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .btn { height: var(--hq-btn-h); padding: 0 var(--hq-btn-pad-inline); border: 1px solid var(--panel-border, var(--line)); border-radius: 6px; background: transparent; color: var(--t1); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn:disabled { color: var(--t3); cursor: default; }
</style>
