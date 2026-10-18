<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { AgentsApi, PlatformAdapter, ManagedBotChannel } from '@hq/platform';
  import { dismissable } from '../../common/dismissable.js';
  import { startVisibleInterval } from '../../common/visible-interval.js';
  import { HQ_CONSOLE_BASE } from '../../common/hq-console.js';
  import { memberKindFromUid } from '../../company/team-telemetry.js';

  let { uid, name, channel, companyUid, agents, adapter, onclose, onchanged, onopenurl }: {
    uid: string; name: string; channel: ManagedBotChannel; companyUid: string | null;
    agents: AgentsApi; adapter: PlatformAdapter | null; onclose: () => void;
    onchanged: () => Promise<void>; onopenurl?: (url: string) => void;
  } = $props();
  type RecordValue = Record<string, unknown>;
  const record = (v: unknown): RecordValue => v && typeof v === 'object' ? v as RecordValue : {};
  const label = $derived(channel === 'telegram' ? 'Telegram' : 'Microsoft Teams');
  let status = $state<RecordValue | null>(null);
  let contacts = $state<RecordValue[]>([]);
  let members = $state<RecordValue[]>([]);
  let busy = $state(false);
  let loading = $state(true);
  let error = $state('');
  let contactsError = $state('');
  let membersError = $state('');
  let mode = $state<'managed' | 'token'>('managed');
  let username = $state('');
  let token = $state('');
  let personUid = $state('');
  let query = $state('');
  let link = $state('');
  let linkKind = $state<'activation' | 'contact'>('activation');
  let expiresAt = $state('');
  let confirm = $state<string | null>(null);
  let gone = false;
  let reading = false;
  let readVersion = 0;
  const configured = $derived(status?.configured === true);
  const canWrite = $derived(!!status && (channel !== 'telegram' || status.eligible !== false));
  const people = $derived(members.filter(m => `${m.personName ?? m.displayName ?? ''} ${m.personEmail ?? ''}`.toLowerCase().includes(query.toLowerCase().trim())));
  const validUsername = $derived(/^[a-zA-Z][a-zA-Z0-9_]{1,28}bot$/i.test(username.trim()));

  function close() { if (!busy) { token = ''; link = ''; onclose(); } }
  function failure(result: unknown): string {
    const r = record(result);
    if (r.status === 401 || r.status === 403) return 'You need owner or admin access, and a bot runtime that supports this channel.';
    if (r.status === 404) return 'This channel service is not available for this bot on the current server.';
    if (r.status === 400) return 'Check the details and try again. The server did not accept them.';
    if (r.status === 409) return 'Connect the channel first, then refresh and try again.';
    return 'The channel service could not complete this request. Please try again.';
  }
  async function refresh() {
    if (reading || busy) return;
    reading = true;
    const version = ++readVersion;
    try {
      const [s, c] = await Promise.all([
        agents.channelStatus!(uid, channel), agents.channelContacts!(uid, channel),
      ]);
      if (gone || version !== readVersion) return;
      status = s.ok ? record(s.value) : null;
      if (!s.ok) error = failure(s);
      contactsError = c.ok ? '' : 'Could not load contacts. Refresh to try again.';
      if (c.ok) contacts = Array.isArray(record(c.value).contacts) ? record(c.value).contacts as RecordValue[] : [];
      if (status?.configured === true && linkKind === 'activation') { link = ''; expiresAt = ''; }
    } catch { if (!gone && version === readVersion) { status = null; error = 'Could not refresh channel status.'; } }
    finally { if (version === readVersion) { reading = false; if (!gone) loading = false; } }
  }
  function trustedLink(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    try {
      const u = new URL(raw, channel === 'teams' && raw.startsWith('/enroll/teams?') ? HQ_CONSOLE_BASE : undefined);
      const hosts = channel === 'telegram' ? ['t.me', 'telegram.me'] : [new URL(HQ_CONSOLE_BASE).hostname];
      if (channel === 'teams' && u.pathname !== '/enroll/teams') return '';
      return u.protocol === 'https:' && !u.username && !u.password && hosts.includes(u.hostname) ? u.href : '';
    } catch { return ''; }
  }
  async function action(kind: 'connect' | 'disconnect' | 'add' | 'remove', person?: string) {
    if (busy) return;
    readVersion++; reading = false;
    busy = true; error = ''; link = ''; expiresAt = '';
    try {
      const result = kind === 'connect' ? await agents.connectTelegram!(uid, mode === 'managed'
        ? { managed: true, suggestedUsername: username.trim(), suggestedName: name }
        : { token: token.trim() })
        : kind === 'disconnect' ? await agents.disconnectTelegram!(uid)
        : kind === 'add' ? await agents.addChannelContact!(uid, channel, personUid)
        : await agents.removeChannelContact!(uid, channel, person!);
      if (gone) return;
      if (!result.ok) { error = failure(result); return; }
      token = ''; confirm = null;
      const value = record(result.value);
      if (kind === 'add' || (kind === 'connect' && mode === 'managed')) {
        linkKind = kind === 'add' ? 'contact' : 'activation';
        link = trustedLink(value.creationLink ?? value.deepLink ?? value.enrollLink);
        expiresAt = typeof value.expiresAt === 'string' ? value.expiresAt : '';
        if (!link) error = 'The server did not return a supported setup link. Refresh before trying again.';
      }
      busy = false;
      await refresh(); await onchanged();
    } catch { if (!gone) error = 'The request could not be completed. Refresh before trying again.'; }
    finally { if (!gone) busy = false; }
  }
  onMount(() => {
    void refresh();
    if (companyUid && adapter?.company.listCompanyMemberships) {
      void adapter.company.listCompanyMemberships(companyUid).then(r => {
        if (gone) return;
        if (r.ok && Array.isArray(record(r.value).members)) members = (record(r.value).members as RecordValue[]).filter(m => typeof m.personUid === 'string' && memberKindFromUid(m.personUid) === 'human' && (!m.status || m.status === 'active'));
        else membersError = 'Could not load company members.';
      }).catch(() => { if (!gone) membersError = 'Could not load company members.'; });
    } else membersError = 'Company members are unavailable in this view.';
    return startVisibleInterval(() => { void refresh(); }, 15000);
  });
  onDestroy(() => { gone = true; token = ''; link = ''; });
</script>

<div class="overlay">
  <div class="dialog" role="dialog" aria-modal="true" aria-label={`${label} settings`} tabindex="-1" use:dismissable={{ onclose: close, outside: true }}>
    <header><div><h3>{label}</h3><p>{name}</p></div><button aria-label="Close channel settings" disabled={busy} onclick={close}>Close</button></header>
    <div class="status"><span>{loading ? 'Checking connection…' : channel === 'teams' ? 'Contact access' : configured ? 'Connected' : 'Not connected'}</span><button disabled={busy || loading} onclick={() => { error = ''; void refresh(); }}>Refresh</button></div>
    {#if error}<p role="alert" class="notice">{error}</p>{/if}
    {#if status?.eligible === false}<p class="notice">{typeof status.reason === 'string' ? status.reason : 'This bot runtime does not support Telegram.'}</p>{/if}
    {#if channel === 'telegram' && !configured && !loading}
      <fieldset disabled={busy || !canWrite}>
        <legend>Connect your bot</legend>
        <div class="options"><button aria-pressed={mode === 'managed'} onclick={() => { mode = 'managed'; token = ''; }}>Create a bot</button><button aria-pressed={mode === 'token'} onclick={() => mode = 'token'}>Use an existing bot</button></div>
        {#if mode === 'managed'}
          <label>Bot username<input bind:value={username} placeholder="your_team_bot" autocomplete="off" /></label>
          <p>Use letters, numbers and underscores, ending in “bot”. Finish creating the bot in Telegram.</p>
        {:else}
          <label>BotFather token<input type="password" bind:value={token} autocomplete="new-password" placeholder="Paste your bot token" /></label>
          <p>Your token is sent securely to HQ and is never saved in this panel.</p>
        {/if}
        <button class="primary" disabled={!!link || (mode === 'managed' ? !validUsername : !token.trim())} onclick={() => action('connect')}>{busy ? 'Connecting…' : mode === 'managed' ? 'Continue in Telegram' : 'Connect Telegram'}</button>
      </fieldset>
    {/if}
    {#if channel === 'teams'}<p class="notice">Uses your company’s existing Microsoft Teams app. Add a company member below to link their Teams account to this bot.</p>{/if}
    {#if link}<div class="notice" role="status"><p>{linkKind === 'activation' ? 'Finish setup in Telegram, then refresh this panel.' : 'Share this single-use link with the selected member to connect their account.'}</p>{#if expiresAt}<p>Expires {new Date(expiresAt).toLocaleString()}</p>{/if}<input aria-label="Setup link" readonly value={link} /><button disabled={!onopenurl} onclick={() => onopenurl?.(link)}>Open setup link</button></div>{/if}
    {#if configured || channel === 'teams'}
      <section class="contacts"><h3>People with access</h3>
        {#if contactsError}<p role="alert">{contactsError}</p>{:else if contacts.length === 0}<p>No linked contacts yet.</p>{/if}
        {#each contacts as contact (String(contact.personUid))}<div class="contact"><span>{String(contact.displayName ?? contact.email ?? contact.personUid)}</span><button disabled={busy} onclick={() => confirm = String(contact.personUid)}>Remove</button></div>{/each}
        <fieldset disabled={busy || !canWrite}><legend>Add a company member</legend>
          <input aria-label="Search company members" bind:value={query} placeholder="Search people…" />
          <div class="people">{#each people as member (String(member.personUid))}<button class:selected={personUid === member.personUid} aria-pressed={personUid === member.personUid} onclick={() => { personUid = String(member.personUid); link = ''; }}>{String(member.personName ?? member.displayName ?? member.personEmail ?? member.personUid)}</button>{/each}</div>
          {#if membersError}<p>{membersError}</p>{:else if people.length === 0}<p>No matching members.</p>{/if}
          <button class="primary" disabled={!personUid} onclick={() => action('add')}>Create connection link</button>
        </fieldset>
      </section>
    {/if}
    {#if confirm}<div class="notice" role="alert"><p>{confirm === 'disconnect' ? 'Disconnect Telegram? The bot will stop receiving Telegram messages. You can reconnect later.' : 'Remove this person’s channel access? They will need a new connection link to return.'}</p><div class="options"><button disabled={busy} onclick={() => confirm = null}>Cancel</button><button disabled={busy} onclick={() => confirm === 'disconnect' ? action('disconnect') : action('remove', confirm!)}>Confirm {confirm === 'disconnect' ? 'disconnect' : 'remove'}</button></div></div>{/if}
    {#if channel === 'telegram' && configured && agents.disconnectTelegram}<footer><button disabled={busy} onclick={() => confirm = 'disconnect'}>Disconnect Telegram</button></footer>{/if}
    {#if busy}<p role="status">Saving changes…</p>{/if}
  </div>
</div>

<style>
  .overlay { position:fixed; inset:0; z-index:100; background:rgb(0 0 0/.55); display:grid; place-items:center; padding:16px; }
  .dialog { box-sizing:border-box; width:min(480px,100%); max-height:calc(100dvh - 32px); overflow:auto; padding:20px; border:1px solid var(--v4-control-border,var(--line)); border-radius:18px; background:var(--v4-secondary-sidebar,var(--side-bg)); color:var(--v4-text-1); font:400 13px/20px var(--font-ui); }
  header,.status,.contact,.options { display:flex; align-items:center; gap:8px; justify-content:space-between; } header>div,.contact>span { flex:1; min-width:0; } h3 { margin:0; font:500 13px/20px var(--font-ui); } p { margin:6px 0; color:var(--v4-text-3); } .status { margin-top:14px; } fieldset { border:0; padding:0; margin:16px 0 0; display:grid; gap:10px; min-width:0; } legend { padding:0 0 10px; font-weight:500; } label { display:grid; gap:6px; } input { box-sizing:border-box; min-width:0; width:100%; padding:9px 10px; border:1px solid var(--v4-control-border,var(--line)); border-radius:8px; background:var(--v4-control-bg); color:var(--v4-text-1); font:inherit; } button { cursor:pointer; font:inherit; color:var(--v4-text-1); padding:6px 12px; border:1px solid var(--v4-control-border,var(--line)); border-radius:999px; background:transparent; } button:hover:not(:disabled),button[aria-pressed=true] { background:var(--v4-hover); } button:disabled { opacity:.45; cursor:default; } .primary { background:var(--v4-primary-bg); color:var(--v4-primary-fg); } .notice { border:1px solid var(--v4-control-border,var(--line)); border-radius:10px; padding:12px; margin-top:12px; display:grid; gap:8px; } .contacts { border-top:1px solid var(--v4-rowline,var(--line)); margin-top:16px; padding-top:16px; } .contact { padding:8px 0; } .people { display:grid; gap:6px; max-height:160px; overflow:auto; } .people button { text-align:left; } footer { margin-top:16px; } button:focus-visible,input:focus-visible { outline:2px solid var(--v4-text-2); outline-offset:2px; }
</style>
