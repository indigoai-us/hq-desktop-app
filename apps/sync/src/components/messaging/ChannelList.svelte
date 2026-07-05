<script lang="ts">
  // Channels segment rail (US-018). Renders the caller's channels grouped under
  // a "Personal" header and one header per company. Each row shows the channel
  // #name + a scope chip (a personal glyph vs the company name) and an unread
  // badge. A "+ New channel" affordance opens the create flow. Selection + the
  // create affordance are bubbled to the parent (MessagesShell); the grouping
  // logic lives in lib/channels.ts (unit-tested).
  import {
    type Channel,
    type CompanyLabel,
    channelDisplayName,
    scopeChipLabel,
    groupChannels,
    isInvitedNotJoined,
  } from '../../lib/channels';

  interface Props {
    channels: Channel[];
    companies?: CompanyLabel[];
    loading?: boolean;
    error?: string | null;
    selectedId?: string | null;
    onselect: (channel: Channel) => void;
    // Open the create flow. `companyUid` is the group the "+ New channel" was
    // clicked under (null = top-level / Personal).
    oncreate: (companyUid: string | null) => void;
    // Open the group-DM create flow (an unnamed, participant-keyed channel).
    oncreategroup: () => void;
  }

  let {
    channels,
    companies = [],
    loading = false,
    error = null,
    selectedId = null,
    onselect,
    oncreate,
    oncreategroup,
  }: Props = $props();

  const groups = $derived(groupChannels(channels, companies));
</script>

<div class="channel-rail">
  <div class="channel-rail-top">
    <button class="new-channel-btn" type="button" onclick={() => oncreate(null)}>
      + New channel
    </button>
    <button class="new-channel-btn new-group-btn" type="button" onclick={() => oncreategroup()}>
      + New group DM
    </button>
  </div>

  {#if loading}
    <p class="rail-status">Loading channels…</p>
  {:else if error}
    <p class="rail-status rail-error" role="alert">{error}</p>
  {:else if groups.length === 0}
    <div class="segment-empty">
      <p class="segment-empty-title">No channels yet</p>
      <p class="segment-empty-sub">
        Create a personal or company channel to start a group conversation.
      </p>
    </div>
  {:else}
    {#each groups as group (group.key)}
      <div class="channel-group">
        <div class="group-header">
          <span class="group-label">
            {#if group.scope === 'group'}
              <span class="group-glyph" aria-hidden="true">⬡</span>
            {:else if group.scope === 'personal'}
              <span class="group-glyph" aria-hidden="true">◐</span>
            {/if}
            {group.label}
          </span>
          {#if group.scope === 'group'}
            <button
              class="group-add"
              type="button"
              title="New group DM"
              aria-label="New group DM"
              onclick={() => oncreategroup()}
            >+</button>
          {:else}
            <button
              class="group-add"
              type="button"
              title={`New channel in ${group.label}`}
              aria-label={`New channel in ${group.label}`}
              onclick={() => oncreate(group.companyUid ?? null)}
            >+</button>
          {/if}
        </div>
        <ul class="channel-list">
          {#each group.channels as ch (ch.channelId)}
            <li>
              <button
                class="channel-row"
                class:active={selectedId === ch.channelId}
                type="button"
                onclick={() => onselect(ch)}
              >
                <span class="channel-hash" aria-hidden="true">#</span>
                <span class="channel-name">{channelDisplayName(ch)}</span>
                {#if isInvitedNotJoined(ch)}
                  <span class="invited-chip" title="You're invited">invited</span>
                {:else}
                  <span class="scope-chip" class:personal={ch.scope === 'personal'}>
                    {scopeChipLabel(ch)}
                  </span>
                {/if}
                {#if (ch.unread ?? 0) > 0}
                  <span class="unread-badge">{(ch.unread ?? 0) > 9 ? '9+' : ch.unread}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  {/if}
</div>

<style>
  .channel-rail {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .channel-rail-top {
    padding: 0.125rem 0.375rem 0.5rem;
  }

  .new-channel-btn {
    width: 100%;
    border: 1px solid transparent;
    background: var(--v4-primary-bg, var(--c-btn-bg));
    color: var(--v4-primary-fg, var(--c-btn-fg));
    font-family: inherit;
    font-size: var(--text-base);
    font-weight: 600;
    padding: 0.375rem 0.5rem;
    border-radius: var(--v4-radius-button, var(--radius-button));
    cursor: pointer;
    transition: filter 0.12s ease, background-color 0.12s ease, border-color 0.12s ease;
  }

  .new-group-btn {
    margin-top: 0.375rem;
    border-color: var(--v4-control-border, var(--c-field-border));
    background: var(--v4-secondary-bg, var(--c-btn2-bg));
    color: var(--v4-secondary-fg, var(--c-btn2-fg));
  }

  .new-channel-btn:hover {
    filter: brightness(0.94);
  }

  .new-group-btn:hover {
    background: var(--pop-hover);
    filter: none;
  }

  .rail-status {
    margin: 0.5rem 0.625rem;
    font-size: var(--text-base);
    color: var(--pop-muted);
  }

  .rail-error {
    color: var(--v4-error, var(--popover-danger));
  }

  .segment-empty {
    padding: 1.25rem 0.875rem;
    text-align: center;
  }

  .segment-empty-title {
    margin: 0 0 0.375rem;
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--pop-text);
  }

  .segment-empty-sub {
    margin: 0;
    font-size: var(--text-base);
    line-height: 1.45;
    color: var(--pop-muted);
  }

  .channel-group {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    margin-bottom: 0.375rem;
  }

  .group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.3125rem 0.625rem 0.1875rem;
  }

  .group-label {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--pop-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .group-glyph {
    font-size: var(--text-base);
    line-height: 1;
    color: var(--muted-2);
  }

  .group-add {
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: var(--pop-muted);
    font-size: var(--text-base);
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
    border-radius: 5px;
  }

  .group-add:hover {
    background: var(--pop-hover);
    color: var(--pop-text);
  }

  .channel-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }

  .channel-row {
    display: flex;
    align-items: center;
    gap: 0.3125rem;
    width: 100%;
    text-align: left;
    padding: 0.375rem 0.5rem;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    cursor: pointer;
    transition: background-color 0.12s ease;
  }

  .channel-row:hover {
    background: var(--pop-hover);
  }

  .channel-row.active {
    background: var(--pop-hover);
  }

  .channel-hash {
    flex-shrink: 0;
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--pop-muted);
  }

  .channel-name {
    font-size: var(--text-base);
    font-weight: 500;
    color: var(--pop-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .scope-chip {
    flex-shrink: 0;
    margin-left: auto;
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 0.0625rem 0.375rem;
    border-radius: 999px;
    background: var(--pop-hover);
    color: var(--pop-muted);
    max-width: 6.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scope-chip.personal {
    background: var(--surface-raise);
    color: var(--muted-2, var(--pop-muted));
  }

  .invited-chip {
    flex-shrink: 0;
    margin-left: auto;
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    padding: 0.0625rem 0.375rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--v4-warn, #b45309) 16%, transparent);
    color: var(--v4-warn, #b45309);
  }

  .unread-badge {
    flex-shrink: 0;
    min-width: 1.0625rem;
    height: 1.0625rem;
    padding: 0 0.25rem;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 1;
    background: var(--v4-unread, var(--blue));
    color: var(--c-bg);
  }
</style>
