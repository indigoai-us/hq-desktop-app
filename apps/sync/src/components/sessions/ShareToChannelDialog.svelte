<script lang="ts">
  /**
   * "Share to channel…" — post a session's digest to an HQ channel and invite
   * people to it, from one sheet.
   *
   * OUTWARD ACTIONS HAPPEN ONLY ON THE SHARE CLICK. Opening this dialog runs
   * two read-only loads (the channels + members preflight, the company's
   * projects); nothing is created, invited or posted until the operator reads
   * the preview line and presses Share. Everything before that is a draft.
   *
   * The draft's rules — what makes it sendable, the exact payload, the preview
   * wording, the result folding — live in `share-channel.ts`; the store owns
   * the one mutating invoke. This component owns the DOM and the click.
   */
  import { untrack } from 'svelte';
  import { liveSessionStore } from '../../desktop-alt/lib/live-session-store.svelte';
  import {
    buildSharePayload,
    channelSlug,
    emptyShareDraft,
    filterChannels,
    filterMembers,
    foldInviteResults,
    hashName,
    loadCompanyProjects,
    loadSharePreflight,
    memberLabel,
    projectChannelName,
    shareDraftBlocker,
    sharePreviewText,
    shareResultText,
    type CompanyProject,
    type PreflightChannel,
    type PreflightMember,
    type ShareDraft,
    type ShareToChannelResult,
  } from './share-channel';

  interface Props {
    sessionId: string;
    company: string | null;
    onclose?: () => void;
    /** Navigate to a channel by id — the shell's own route mechanism. */
    onopenchannel?: (channelId: string) => void;
  }

  let { sessionId, company, onclose, onopenchannel }: Props = $props();

  // The draft is seeded once: the page remounts this dialog per session, so
  // a later prop change is a new dialog, not an edit to this one.
  let draft = $state<ShareDraft>(untrack(() => emptyShareDraft(sessionId, company)));
  let channels = $state<PreflightChannel[]>([]);
  let members = $state<PreflightMember[]>([]);
  let projects = $state<CompanyProject[]>([]);
  let loading = $state(true);
  let loadError = $state('');
  let channelQuery = $state('');
  let inviteQuery = $state('');
  /** The name the project picker last wrote, so a typed edit is never clobbered. */
  let prefilledName = $state('');
  let sharing = $state(false);
  let shareError = $state('');
  let result = $state<ShareToChannelResult | null>(null);
  let sheet = $state<HTMLDivElement | null>(null);

  const blocker = $derived(shareDraftBlocker(draft));
  const preview = $derived(sharePreviewText(draft, channels, members));
  const channelHits = $derived(filterChannels(channels, channelQuery));
  const inviteHits = $derived(filterMembers(members, inviteQuery, draft.inviteUids).slice(0, 8));
  const invites = $derived(result ? foldInviteResults(result.invited) : null);

  // The read-only loads: once, for the company the session is bound to. A
  // company-less session has nothing to share to and says so via `blocker`.
  $effect(() => {
    const co = company;
    if (!co) {
      loading = false;
      return;
    }
    loading = true;
    loadError = '';
    void Promise.all([loadSharePreflight(co), loadCompanyProjects(co).catch(() => [])])
      .then(([preflight, list]) => {
        channels = preflight.channels;
        members = preflight.members;
        projects = list;
      })
      .catch((err: unknown) => {
        loadError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        loading = false;
      });
  });

  $effect(() => {
    sheet?.focus();
  });

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || sharing) return;
    event.stopPropagation();
    onclose?.();
  }

  function pickChannel(channelId: string) {
    draft.channelId = channelId;
  }

  function pickProject(path: string) {
    const project = projects.find((item) => item.path === path) ?? null;
    draft.projectPath = project?.path ?? null;
    if (!project) return;
    const wanted = projectChannelName(project);
    // Prefill only over an empty name or our own earlier prefill.
    if (!draft.newName.trim() || channelSlug(draft.newName) === prefilledName) {
      draft.newName = wanted;
      prefilledName = wanted;
    }
  }

  function addInvite(uid: string) {
    if (!draft.inviteUids.includes(uid)) draft.inviteUids = [...draft.inviteUids, uid];
    inviteQuery = '';
  }

  function removeInvite(uid: string) {
    draft.inviteUids = draft.inviteUids.filter((item) => item !== uid);
  }

  /** THE confirm. The only place anything leaves the app. */
  async function share() {
    const payload = buildSharePayload(draft);
    if (!payload || sharing) return;
    sharing = true;
    shareError = '';
    try {
      result = await liveSessionStore.shareToChannel(payload);
    } catch (err) {
      shareError = err instanceof Error ? err.message : String(err);
    } finally {
      sharing = false;
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="share-layer" data-testid="share-dialog-layer">
  <button
    type="button"
    class="scrim"
    aria-label="Close"
    tabindex="-1"
    disabled={sharing}
    onclick={() => onclose?.()}
  ></button>

  <div
    class="sheet"
    role="dialog"
    aria-modal="true"
    aria-label="Share to channel"
    aria-busy={sharing ? 'true' : undefined}
    tabindex="-1"
    bind:this={sheet}
    data-testid="share-dialog"
  >
    <header class="head">
      <h3 class="title">Share to channel</h3>
      <button
        type="button"
        class="close"
        aria-label="Close"
        disabled={sharing}
        data-testid="share-close"
        onclick={() => onclose?.()}
      >
        ×
      </button>
    </header>

    {#if result}
      <div class="result" role="status" data-testid="share-result">
        <p class="result-line">
          <span data-testid="share-result-text">{shareResultText(result)}</span>
          <span class="dot" aria-hidden="true">·</span>
          <button
            type="button"
            class="link"
            data-testid="share-open-channel"
            onclick={() => onopenchannel?.(result!.channelId)}
          >
            open channel
          </button>
        </p>
        {#if invites && invites.failed.length > 0}
          <ul class="failures" data-testid="share-invite-failures">
            {#each invites.failed as failure (failure.uid)}
              <li>
                <strong>{memberLabel(failure.uid, members)}</strong>
                <span class="failure-why">{failure.error}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
      <footer class="foot">
        <button type="button" class="button primary" data-testid="share-done" onclick={() => onclose?.()}>
          Done
        </button>
      </footer>
    {:else}
      {#if loading}
        <p class="note" role="status" data-testid="share-loading">Loading channels…</p>
      {:else if loadError}
        <p class="error" role="alert" data-testid="share-load-error">{loadError}</p>
      {/if}

      <fieldset class="field" disabled={sharing}>
        <legend class="label">Where</legend>
        <div class="segmented" role="group" aria-label="Target">
          <button
            type="button"
            class="seg"
            class:on={draft.targetKind === 'existing'}
            aria-pressed={draft.targetKind === 'existing'}
            data-testid="share-target-existing"
            onclick={() => (draft.targetKind = 'existing')}
          >
            Existing channel
          </button>
          <button
            type="button"
            class="seg"
            class:on={draft.targetKind === 'new'}
            aria-pressed={draft.targetKind === 'new'}
            data-testid="share-target-new"
            onclick={() => (draft.targetKind = 'new')}
          >
            New channel
          </button>
        </div>

        {#if draft.targetKind === 'existing'}
          <input
            class="input"
            type="search"
            placeholder="Search channels"
            aria-label="Search channels"
            bind:value={channelQuery}
            data-testid="share-channel-search"
          />
          <ul class="list" role="listbox" aria-label="Channels" data-testid="share-channel-list">
            {#each channelHits as channel (channel.channelId)}
              <li>
                <button
                  type="button"
                  class="option"
                  class:selected={draft.channelId === channel.channelId}
                  role="option"
                  aria-selected={draft.channelId === channel.channelId}
                  data-testid="share-channel-option"
                  data-channel-id={channel.channelId}
                  onclick={() => pickChannel(channel.channelId)}
                >
                  <span class="option-name">{hashName(channel.name)}</span>
                  <span class="option-kind">{channel.kind}</span>
                </button>
              </li>
            {:else}
              <li class="empty">{loading ? '' : channels.length === 0 ? 'No channels yet.' : 'No matches.'}</li>
            {/each}
          </ul>
        {:else}
          <label class="name-row">
            <span class="hash" aria-hidden="true">#</span>
            <input
              class="input name"
              type="text"
              placeholder="channel-name"
              aria-label="New channel name"
              bind:value={draft.newName}
              data-testid="share-new-name"
            />
          </label>
          {#if projects.length > 0}
            <label class="project-row">
              <span class="label">From project</span>
              <select
                class="select"
                aria-label="From project"
                data-testid="share-project"
                value={draft.projectPath ?? ''}
                onchange={(event) => pickProject((event.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">— none —</option>
                {#each projects as project (project.path)}
                  <option value={project.path}>{project.name}</option>
                {/each}
              </select>
            </label>
          {/if}
        {/if}
      </fieldset>

      <fieldset class="field" disabled={sharing}>
        <legend class="label">Invite</legend>
        {#if draft.inviteUids.length > 0}
          <ul class="chips" data-testid="share-invite-chips">
            {#each draft.inviteUids as uid (uid)}
              <li class="chip" data-testid="share-invite-chip" data-uid={uid}>
                <span>{memberLabel(uid, members)}</span>
                <button
                  type="button"
                  class="chip-x"
                  aria-label={`Remove ${memberLabel(uid, members)}`}
                  onclick={() => removeInvite(uid)}
                >
                  ×
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        <input
          class="input"
          type="search"
          placeholder="People or agents"
          aria-label="Invite people or agents"
          bind:value={inviteQuery}
          data-testid="share-invite-search"
        />
        {#if inviteHits.length > 0}
          <ul class="list short" role="listbox" aria-label="Members" data-testid="share-invite-list">
            {#each inviteHits as member (member.uid)}
              <li>
                <button
                  type="button"
                  class="option"
                  role="option"
                  aria-selected="false"
                  data-testid="share-invite-option"
                  data-uid={member.uid}
                  onclick={() => addInvite(member.uid)}
                >
                  <span class="option-name">{member.displayName}</span>
                  <span class="option-kind">{member.kind}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </fieldset>

      <label class="toggle">
        <input
          type="checkbox"
          bind:checked={draft.includeTranscript}
          disabled={sharing}
          data-testid="share-include-transcript"
        />
        <span>Include transcript digest</span>
      </label>

      <textarea
        class="input note-input"
        rows="2"
        placeholder="Add a note (optional)"
        aria-label="Note"
        bind:value={draft.note}
        disabled={sharing}
        data-testid="share-note"
      ></textarea>

      <p class="preview" class:blocked={Boolean(blocker)} data-testid="share-preview">{preview}</p>

      {#if shareError}
        <p class="error" role="alert" data-testid="share-error">{shareError}</p>
      {/if}

      <footer class="foot">
        <button
          type="button"
          class="button"
          disabled={sharing}
          data-testid="share-cancel"
          onclick={() => onclose?.()}
        >
          Cancel
        </button>
        <button
          type="button"
          class="button primary"
          disabled={Boolean(blocker) || sharing || loading}
          aria-busy={sharing ? 'true' : undefined}
          data-testid="share-confirm"
          onclick={() => void share()}
        >
          {sharing ? 'Sharing…' : 'Share'}
        </button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .share-layer {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 48px 16px 16px;
    font-family: var(--font-sans);
  }

  .scrim {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: var(--ws-scrim, rgba(0, 0, 0, 0.32));
    cursor: default;
  }

  .sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
    max-width: 440px;
    max-height: calc(100% - 32px);
    overflow: auto;
    padding: 14px 16px 16px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card, 10px);
    background: var(--v4-surface, var(--pop-bg, #fff));
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
    color: var(--v4-text-1);
    outline: none;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  .close {
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-3);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }

  .close:hover:not(:disabled) {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  .label {
    padding: 0;
    font-size: 11px;
    font-weight: 500;
    color: var(--v4-text-3);
  }

  .segmented {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill, 999px);
    align-self: flex-start;
  }

  .seg {
    height: 22px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--v4-radius-pill, 999px);
    background: transparent;
    color: var(--v4-text-2);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .seg.on {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .input {
    box-sizing: border-box;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: 12px;
  }

  .note-input {
    height: auto;
    padding: 6px 8px;
    resize: vertical;
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .hash {
    color: var(--v4-text-3);
    font-size: 12px;
  }

  .project-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .select {
    flex: 1;
    height: 26px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: 12px;
  }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 168px;
    overflow: auto;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
  }

  .list.short {
    max-height: 120px;
  }

  .option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    border: 0;
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .option:hover,
  .option:focus-visible {
    background: var(--v4-active-row);
  }

  .option.selected {
    background: var(--v4-active-row);
    font-weight: 500;
  }

  .option-kind {
    font-size: 10px;
    color: var(--v4-text-3);
  }

  .empty {
    padding: 6px 8px;
    font-size: 11px;
    color: var(--v4-text-3);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 4px 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill, 999px);
    font-size: 11px;
  }

  .chip-x {
    width: 16px;
    height: 16px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--v4-text-3);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
  }

  .chip-x:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }

  .preview {
    margin: 0;
    font-size: 11px;
    color: var(--v4-text-2);
  }

  .preview.blocked {
    color: var(--v4-text-3);
  }

  .note,
  .error {
    margin: 0;
    font-size: 11px;
  }

  .note {
    color: var(--v4-text-3);
  }

  .error {
    color: var(--v4-text-1);
  }

  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .button {
    height: 26px;
    padding: 0 12px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill, 999px);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .button:hover:not(:disabled) {
    background: var(--v4-active-row);
  }

  .button.primary {
    background: var(--v4-text-1);
    border-color: var(--v4-text-1);
    color: var(--v4-surface, #fff);
  }

  .button.primary:hover:not(:disabled) {
    opacity: 0.9;
    background: var(--v4-text-1);
  }

  .button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .result {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .result-line {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 12px;
  }

  .dot {
    color: var(--v4-text-3);
  }

  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: 12px;
    text-decoration: underline;
    cursor: pointer;
  }

  .failures {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 11px;
    color: var(--v4-text-2);
  }

  .failure-why {
    margin-left: 6px;
    color: var(--v4-text-3);
  }
</style>
