<script lang="ts">
  // Create-channel sheet (US-018). An OVERLAY inside MessagesShell (mirrors
  // ComposeMessage): a dimmed backdrop + centered sheet capturing:
  //   • name      — required, rendered with a leading # affordance
  //   • scope     — Personal, or one of the caller's companies (the company
  //                 picker reuses the same source as RecipientPicker:
  //                 meetings_list_memberships)
  //   • invites   — optional initial members, added one at a time via the same
  //                 RecipientPicker the roster uses
  //
  // On success the parent is handed the created Channel so it can drop it into
  // the rail (under Personal or the right company header) and open it.
  import { invoke } from '@tauri-apps/api/core';
  import { untrack } from 'svelte';
  import RecipientPicker from './RecipientPicker.svelte';
  import type { SelectedRecipient } from '../../lib/recipientPicker';
  import type { Channel } from '../../lib/channels';

  interface Props {
    onclose: () => void;
    oncreated: (channel: Channel) => void;
    // Optional preset scope (e.g. the user clicked "+ New channel" under a
    // company header). `companyUid` null → personal.
    presetCompanyUid?: string | null;
    // Group-DM mode: an unnamed, participant-keyed channel. Hides the name +
    // scope pickers and requires ≥2 invitees (the caller is the 3rd, added
    // server-side). Submits via `create_group_dm`.
    isGroupDm?: boolean;
  }

  let { onclose, oncreated, presetCompanyUid = null, isGroupDm = false }: Props = $props();

  interface MembershipRow {
    companyUid: string;
    companyName: string | null;
    role: string | null;
    status: string;
  }

  type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

  // "personal" or a companyUid.
  let scopeValue = $state<string>(
    untrack(() => presetCompanyUid ?? 'personal'),
  );
  let name = $state('');
  let companies = $state<{ companyUid: string; companyName: string | null }[]>([]);
  let companiesStatus = $state<LoadStatus>('idle');

  // Initial invites — accumulated as the user picks them.
  let invitePick = $state<SelectedRecipient | null>(null);
  let invites = $state<SelectedRecipient[]>([]);

  let creating = $state(false);
  let createError = $state<string | null>(null);

  const isPersonal = $derived(scopeValue === 'personal');
  const scopesLoading = $derived(companiesStatus === 'idle' || companiesStatus === 'loading');
  const scopesFailed = $derived(companiesStatus === 'error');
  const hasTrustedScopes = $derived(companies.length > 0);
  const scopesReady = $derived(
    isGroupDm || companiesStatus === 'ready' || hasTrustedScopes,
  );

  // A group DM needs ≥2 other people (caller is the 3rd); a named channel needs
  // a name. Either way, not while a create is already in flight.
  const canCreate = $derived(
    !creating
      && scopesReady
      && (isGroupDm ? invites.length >= 2 : name.trim().length > 0),
  );

  async function loadCompanies(): Promise<void> {
    if (companiesStatus === 'loading') return;
    companiesStatus = 'loading';
    try {
      const list = await invoke<MembershipRow[]>('meetings_list_memberships');
      const nextCompanies = (list ?? [])
        .filter((m) => m.status === 'active')
        .map((m) => ({ companyUid: m.companyUid, companyName: m.companyName }));
      companies = nextCompanies;
      companiesStatus = 'ready';
      if (
        scopeValue !== 'personal'
        && !nextCompanies.some((company) => company.companyUid === scopeValue)
      ) {
        scopeValue = 'personal';
      }
    } catch (err) {
      console.error('create-channel: meetings_list_memberships failed', err);
      // Preserve the last trusted scope list so a refresh failure never
      // silently collapses the selector to Personal-only.
      companiesStatus = 'error';
    }
  }

  function addInvite(r: SelectedRecipient | null): void {
    if (!r) return;
    const uid = r.personUid?.trim();
    if (!uid) return; // Only HQ-account people can be channel members.
    if (invites.some((i) => i.personUid === uid)) {
      invitePick = null;
      return;
    }
    invites = [...invites, r];
    invitePick = null;
  }

  function removeInvite(uid: string | undefined): void {
    invites = invites.filter((i) => i.personUid !== uid);
  }

  function inviteLabel(r: SelectedRecipient): string {
    return r.displayName?.trim() || r.email;
  }

  async function create(): Promise<void> {
    if (!canCreate) return;
    creating = true;
    createError = null;
    try {
      const participantUids = invites
        .map((i) => i.personUid)
        .filter((u): u is string => !!u);
      const channel = isGroupDm
        ? await invoke<Channel>('create_group_dm', { participants: participantUids })
        : await invoke<Channel>('create_channel', {
            name: name.trim(),
            scope: isPersonal ? 'personal' : 'company',
            companyUid: isPersonal ? null : scopeValue,
            invite: participantUids,
          });
      oncreated(channel);
    } catch (err) {
      const fallback = isGroupDm
        ? 'Could not create the group'
        : 'Could not create the channel';
      createError = typeof err === 'string' ? err : fallback;
      console.error('create-channel: create failed', err);
    } finally {
      creating = false;
    }
  }

  function requestClose(): void {
    if (!creating) onclose();
  }

  function onNameKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canCreate) void create();
    }
  }

  function onBackdropKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') requestClose();
  }

  $effect(() => {
    if (!isGroupDm) untrack(() => void loadCompanies());
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="create-backdrop" onclick={requestClose} onkeydown={onBackdropKeydown} role="presentation">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="create-sheet"
    role="dialog"
    aria-modal="true"
    aria-label={isGroupDm ? 'New group DM' : 'New channel'}
    aria-busy={creating}
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={onBackdropKeydown}
  >
    <header class="create-header">
      <h2>{isGroupDm ? 'New group DM' : 'New channel'}</h2>
      <button
        class="create-close"
        type="button"
        onclick={requestClose}
        aria-label="Close"
        disabled={creating}
      >×</button>
    </header>

    {#if !isGroupDm}
      <div class="create-field">
        <span class="create-label" id="channel-name-label">Name</span>
        <div class="name-input-wrap">
          <span class="name-hash" aria-hidden="true">#</span>
          <input
            class="name-input"
            type="text"
            bind:value={name}
            onkeydown={onNameKeydown}
            placeholder="general"
            aria-labelledby="channel-name-label"
            autocomplete="off"
            spellcheck="false"
            disabled={creating}
          />
        </div>
      </div>

      <div class="create-field">
        <span class="create-label" id="channel-scope-label">Scope</span>
        <div class="scope-control" aria-busy={scopesLoading}>
          {#if !hasTrustedScopes && scopesLoading}
            <p class="scope-status" id="channel-scope-status" role="status">
              Loading available scopes…
            </p>
          {:else if !hasTrustedScopes && scopesFailed}
            <div class="scope-status scope-error" id="channel-scope-status" role="alert">
              <span>Company scopes couldn’t be loaded.</span>
              <button
                class="scope-retry"
                type="button"
                onclick={() => void loadCompanies()}
                disabled={scopesLoading || creating}
              >
                {scopesLoading ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          {:else}
            <select
              class="scope-select"
              bind:value={scopeValue}
              aria-labelledby="channel-scope-label"
              aria-describedby="channel-scope-hint channel-scope-status"
              disabled={creating}
            >
              <option value="personal">Personal</option>
              {#each companies as co (co.companyUid)}
                <!-- Never surface the raw cmp_… UID as a user-facing label. -->
                <option value={co.companyUid}>{co.companyName?.trim() || 'Company'}</option>
              {/each}
            </select>
            <p class="scope-hint" id="channel-scope-hint">
              {isPersonal
                ? 'A personal channel — only people you invite can see it.'
                : 'A company channel — discoverable by your teammates.'}
            </p>
            {#if scopesFailed}
              <div class="scope-status scope-error" id="channel-scope-status" role="alert">
                <span>Couldn’t refresh scopes. Showing saved options.</span>
                <button
                  class="scope-retry"
                  type="button"
                  onclick={() => void loadCompanies()}
                  disabled={scopesLoading || creating}
                >
                  {scopesLoading ? 'Retrying…' : 'Retry'}
                </button>
              </div>
            {:else if scopesLoading}
              <p class="scope-status" id="channel-scope-status" role="status">
                Refreshing available scopes…
              </p>
            {/if}
          {/if}
        </div>
      </div>
    {/if}

    <div class="create-field">
      <span class="create-label">
        {#if isGroupDm}People{:else}Invite people <span class="optional">(optional)</span>{/if}
      </span>
      {#if isGroupDm}
        <p class="scope-hint">Add at least 2 people — you're all in one thread.</p>
      {/if}
      <RecipientPicker
        bind:selected={invitePick}
        onselect={(r) => addInvite(r)}
        placeholder="Add someone…"
        disabled={creating}
      />
      {#if invites.length > 0}
        <ul class="invite-chips">
          {#each invites as i (i.personUid)}
            <li class="invite-chip">
              <span class="invite-chip-name">{inviteLabel(i)}</span>
              <button
                class="invite-chip-remove"
                type="button"
                onclick={() => removeInvite(i.personUid)}
                aria-label={`Remove ${inviteLabel(i)}`}
                disabled={creating}
              >×</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="create-footer">
      {#if createError}
        <span class="create-error" role="alert">{createError}</span>
      {:else}
        <span class="create-hint">⌘↵ to create</span>
      {/if}
      <button
        class="btn btn-send"
        type="button"
        onclick={create}
        disabled={!canCreate}
        aria-busy={creating}
      >
        {creating ? 'Creating…' : isGroupDm ? 'Create group' : 'Create channel'}
      </button>
    </div>
  </div>
</div>

<style>
  .create-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 3.5rem 1.5rem 1.5rem;
    background: color-mix(in srgb, var(--pop-bg) 48%, transparent);
  }

  .create-sheet {
    width: 100%;
    max-width: 460px;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    padding: 1.125rem 1.25rem 1.25rem;
    border-radius: var(--radius-popover);
    border: 1px solid var(--pop-border);
    background: var(--pop-bg);
    backdrop-filter: var(--glass-filter, blur(36px) saturate(118%) contrast(102%));
    -webkit-backdrop-filter: var(--glass-filter, blur(36px) saturate(118%) contrast(102%));
    box-shadow: var(--pop-shadow), inset 0 1px 0 var(--pop-highlight);
    color: var(--pop-text);
    font-family: var(--font-sans);
  }

  .create-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .create-header h2 {
    margin: 0;
    font-size: var(--text-lg, 18px);
    font-weight: 600;
    color: var(--pop-text);
  }

  .create-close {
    border: none;
    background: transparent;
    color: var(--pop-muted);
    font-size: var(--text-lg, 18px);
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
    border-radius: 6px;
  }

  .create-close:hover {
    background: var(--pop-hover);
    color: var(--pop-text);
  }

  .create-close:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .create-field {
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
  }

  .create-label {
    font-size: var(--text-base, 13px);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--pop-muted);
  }

  .optional {
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
    color: var(--pop-muted);
  }

  .name-input-wrap {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    border-radius: 8px;
    border: 1px solid var(--pop-border);
    background: var(--pop-hover);
    padding: 0 0.625rem;
  }

  .name-input-wrap:focus-within {
    border-color: var(--c-field-border);
    background: var(--c-field-bg);
  }

  .name-hash {
    color: var(--pop-muted);
    font-size: var(--text-base, 13px);
    font-weight: 600;
  }

  .name-input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--pop-text);
    font-family: inherit;
    font-size: var(--text-base, 13px);
    line-height: 1.4;
    padding: 0.5rem 0;
  }

  .name-input:focus {
    outline: none;
  }

  .scope-select {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 0.625rem;
    border-radius: 8px;
    border: 1px solid var(--pop-border);
    background: var(--pop-hover);
    color: var(--pop-text);
    font-family: inherit;
    font-size: var(--text-base, 13px);
  }

  .scope-select:focus {
    outline: none;
    border-color: var(--c-field-border);
  }

  .scope-hint {
    margin: 0;
    font-size: var(--text-base, 13px);
    color: var(--pop-muted);
  }

  .scope-control {
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
  }

  .scope-status {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-height: 32px;
    margin: 0;
    padding: 0.25rem 0;
    color: var(--pop-muted);
    font-size: var(--text-base, 13px);
    line-height: 1.35;
  }

  .scope-error {
    justify-content: space-between;
    color: var(--pop-text);
  }

  .scope-retry {
    flex-shrink: 0;
    padding: 2px 0;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--pop-text);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .scope-retry:focus-visible {
    outline: 2px solid var(--c-field-border);
    outline-offset: 2px;
  }

  .scope-retry:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .invite-chips {
    list-style: none;
    margin: 0.125rem 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .invite-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1875rem 0.375rem 0.1875rem 0.5rem;
    border-radius: 999px;
    background: var(--pop-hover);
    border: 1px solid var(--pop-border);
  }

  .invite-chip-name {
    font-size: var(--text-base, 13px);
    color: var(--pop-text);
  }

  .invite-chip-remove {
    border: none;
    background: transparent;
    color: var(--pop-muted);
    font-size: var(--text-base, 13px);
    line-height: 1;
    cursor: pointer;
    padding: 0 0.125rem;
  }

  .invite-chip-remove:hover {
    color: var(--pop-text);
  }

  .invite-chip-remove:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .create-footer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.25rem;
  }

  .create-hint {
    font-size: var(--text-base, 13px);
    color: var(--pop-muted);
  }

  .create-error {
    font-size: var(--text-base, 13px);
    color: var(--red, var(--popover-danger));
    word-break: break-word;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    padding: 0.4375rem 0.875rem;
    border-radius: 7px;
    font-size: var(--text-base, 13px);
    font-weight: 600;
    cursor: pointer;
    border: none;
    font-family: inherit;
    transition: background-color 0.12s ease;
  }

  .btn-send {
    margin-left: auto;
    background: var(--v4-primary-bg, var(--c-btn-bg));
    color: var(--v4-primary-fg, var(--c-btn-fg));
  }

  .btn-send:hover:not(:disabled) {
    filter: brightness(0.94);
  }

  .btn-send:disabled {
    opacity: 0.45;
    cursor: default;
  }

  @media (prefers-reduced-transparency: reduce) {
    .create-backdrop,
    .create-sheet {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    .create-backdrop {
      background: color-mix(in srgb, var(--c-bg) 74%, transparent);
    }

    .create-sheet {
      background: var(--c-bg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .create-close,
    .scope-retry,
    .invite-chip-remove,
    .btn {
      animation: none;
      transition: none;
    }
  }
</style>
