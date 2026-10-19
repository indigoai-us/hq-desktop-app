<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { AgentsApi } from '@hq/platform';
  import { dismissable } from '../../common/dismissable.js';
  let { uid, agents, onclose, onchanged }: { uid: string; agents: AgentsApi; onclose: () => void; onchanged: () => Promise<void> } = $props();
  let address = $state('');
  let localPart = $state('');
  let ready = $state(false);
  let busy = $state(false);
  let confirm = $state(false);
  let error = $state('');
  let gone = false;
  const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
  const valid = $derived(/^[a-z0-9][a-z0-9-]{0,62}$/.test(localPart));
  function close() { if (!busy) onclose(); }
  async function read() {
    busy = true; error = ''; ready = false;
    try {
      const r = await agents.getStatus(uid);
      if (gone) return;
      if (!r.ok) { error = 'Could not read email status. Check your bot access and try again.'; return; }
      const value = record(record(record(record(r.value).agent ?? r.value).channels).email).address;
      address = typeof value === 'string' ? value : ''; localPart = address.split('@')[0]; ready = true;
    } catch { if (!gone) error = 'Could not read email status. Try again.'; }
    finally { if (!gone) busy = false; }
  }
  async function save(kind: 'connect' | 'rename' | 'disconnect') {
    if (busy) return;
    busy = true; error = '';
    try {
      const r = kind === 'connect' ? await agents.connectEmail!(uid) : kind === 'rename' ? await agents.updateEmailAddress!(uid, localPart) : await agents.disconnectEmail!(uid);
      if (gone) return;
      if (!r.ok) {
        error = r.status === 409 ? 'This address is unavailable or the connection changed. Refresh and try again.' : r.status === 404 ? 'Email setup is not enabled on this server.' : r.status === 403 ? 'You need owner or admin access to manage email.' : 'Could not save the email change. Try again.';
        return;
      }
      confirm = false;
      await read(); await onchanged();
    } catch { if (!gone) error = 'Could not save the email change. Refresh before trying again.'; }
    finally { if (!gone) busy = false; }
  }
  onMount(() => { void read(); });
  onDestroy(() => { gone = true; });
</script>
<div class="overlay"><div class="dialog" role="dialog" aria-modal="true" aria-label="Email settings" tabindex="-1" use:dismissable={{ onclose: close, outside: true }}>
  <header><h3>Email</h3><button disabled={busy} onclick={close}>Close</button></header>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if !ready}<p>{busy ? 'Checking email…' : 'Email status unavailable.'}</p><button disabled={busy} onclick={read}>Refresh</button>
  {:else if address}
    <p>Connected · {address}</p>
    <label>Email name<input bind:value={localPart} disabled={busy} autocomplete="off" /></label><p>@{address.split('@')[1]}</p>
    <p>Renaming changes where people send mail to this bot.</p>
    <button class="primary" disabled={busy || !valid || localPart === address.split('@')[0]} onclick={() => save('rename')}>Save address</button>
    {#if confirm}<p>Disconnect email? This bot will stop receiving messages at this address.</p><button disabled={busy} onclick={() => confirm = false}>Cancel</button><button disabled={busy} onclick={() => save('disconnect')}>Confirm disconnect</button>
    {:else}<button disabled={busy} onclick={() => confirm = true}>Disconnect email</button>{/if}
  {:else}<p>Give this bot an HQ email address using your company’s configured email domain.</p><button class="primary" disabled={busy} onclick={() => save('connect')}>Connect email</button>{/if}
  {#if busy && ready}<p role="status">Saving changes…</p>{/if}
</div></div>
<style>
  .overlay { position:fixed; inset:0; z-index:100; background:rgb(0 0 0/.55); display:grid; place-items:center; padding:16px; }.dialog { box-sizing:border-box; width:min(440px,100%); max-height:calc(100dvh - 32px); overflow:auto; padding:20px; border:1px solid var(--v4-control-border,var(--line)); border-radius:18px; background:var(--v4-secondary-sidebar,var(--side-bg)); color:var(--v4-text-1); font:400 13px/20px var(--font-ui); } header { display:flex; align-items:center; justify-content:space-between; gap:12px; } h3 { font:500 13px/20px var(--font-ui); margin:0; } p { color:var(--v4-text-3); margin:12px 0; } label { display:grid; gap:6px; } input { padding:9px 10px; background:var(--v4-control-bg); color:var(--v4-text-1); border:1px solid var(--v4-control-border,var(--line)); border-radius:8px; font:inherit; min-width:0; } button { padding:6px 12px; border:1px solid var(--v4-control-border,var(--line)); border-radius:999px; background:transparent; color:var(--v4-text-1); cursor:pointer; font:inherit; margin:4px 4px 4px 0; } button:disabled { opacity:.45; cursor:default; }.primary { background:var(--v4-primary-bg); color:var(--v4-primary-fg); } button:focus-visible,input:focus-visible { outline:2px solid var(--v4-text-2); outline-offset:2px; }
</style>
