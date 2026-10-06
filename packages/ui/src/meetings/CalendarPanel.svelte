<!--
  Calendars popover body (US-042, scene meetings-calendar). Loaded through
  meetings-toolbar-lazy. Google uses the existing in-app OAuth path;
  Microsoft has no backend connect yet, so its button says so.
-->
<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import { meetingsStore } from "./meetings-store.svelte";
  import { syncedAgo } from "./meeting-link";
  import {
    connectGoogleCalendar,
    disconnectCalendarAccount,
    type OpenExternal,
  } from "./meeting-calendar-actions";

  interface Props {
    openExternal?: OpenExternal;
    onclose?: () => void;
  }

  let { openExternal }: Props = $props();

  const accounts = $derived(meetingsStore.accounts.filter((a) => a.accountId));
  const pending = $derived(meetingsStore.connectPending);
  const syncLine = $derived(syncedAgo(meetingsStore.lastSyncedAt, Date.now()));
  const eventCount = $derived(meetingsStore.events.length);
  const primary = $derived(accounts[0] ?? null);
  const emailOf = (a: { accountId: string; email?: string | null }) =>
    a.email || meetingsStore.accountEmailById.get(a.accountId) || "Google account";
</script>

<div class="lbl">Calendars</div>
<div class="row" data-testid="calendar-provider-google">
  <span class="mk">G</span>
  <span class="tx">
    <span class="tt">Google Calendar</span>
    {#if accounts.length}
      {#each accounts as a (a.accountId)}
        <span class="mm">{emailOf(a)} · {syncLine} · {eventCount} events</span>
      {/each}
    {:else}
      <span class="mm">Not connected</span>
    {/if}
  </span>
  <button type="button" class="btn" data-testid="calendar-connect-google" disabled={pending} aria-busy={pending} onclick={() => void connectGoogleCalendar(openExternal)}><RailIcon name="plug" />
    {pending ? "Waiting…" : accounts.length ? "Reconnect" : "Connect"}
  </button>
</div>
<div class="row" data-testid="calendar-provider-microsoft">
  <span class="mk">M</span>
  <span class="tx"><span class="tt">Microsoft Outlook</span><span class="mm">Not connected</span></span>
  <button type="button" class="btn" data-testid="calendar-connect-microsoft" disabled title="Microsoft calendar connect is not available yet"><RailIcon name="plug" />Connect</button>
</div>
<div class="rule"></div>
<button type="button" class="link" data-testid="calendar-connect-another" disabled={pending} onclick={() => void connectGoogleCalendar(openExternal)}><RailIcon name="plug" />Connect another account</button>
{#if primary}
  {#each accounts as a (a.accountId)}
    <button type="button" class="link danger" data-testid="calendar-disconnect" disabled={meetingsStore.disconnectPendingByAccountId.has(a.accountId)} onclick={() => void disconnectCalendarAccount(a.accountId, emailOf(a))}><RailIcon name="x" />Disconnect {emailOf(a)}</button>
  {/each}
{/if}
<p class="note">Meetings reads events and video links only. Disconnecting removes upcoming events from this list; recaps stay.</p>

<style>
  .lbl { font-size: 13px; font-weight: 500; line-height: 17px; color: var(--t2); margin: 0 0 8px; }
  .row { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 6px 0; }
  .mk { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; background: var(--v4-control-bg, var(--hover)); font-size: 13px; color: var(--t2); }
  .tx { min-width: 0; }
  .tt { display: block; font-size: 13px; color: var(--t1); }
  .mm { display: block; font-size: 13px; color: var(--t3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn { height: var(--hq-btn-h); padding: 0 var(--hq-btn-pad-inline); border: 1px solid var(--panel-border, var(--line)); border-radius: 6px; background: transparent; color: var(--t1); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn:disabled, .link:disabled { color: var(--t3); cursor: default; }
  .rule { height: 1px; background: var(--line); margin: 8px 0; }
  .link { display: block; width: 100%; min-height: 28px; padding: 4px 0; border: 0; background: transparent; color: var(--t1); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
  .link.danger { color: var(--popover-danger, var(--v4-error)); }
  .note { margin: 6px 0 0; font-size: 13px; line-height: 1.45; color: var(--t3); }
</style>
