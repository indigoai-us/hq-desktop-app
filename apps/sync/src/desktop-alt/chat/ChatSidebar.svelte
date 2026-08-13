<script lang="ts">
  /**
   * Chat-first unified conversation sidebar (US-003).
   *
   * Cache-first list of project channels + DMs + group DMs, day-grouped with
   * pin / scope / sort / show filters. Routes selection into the Messages shell.
   */
  import { invoke } from '@tauri-apps/api/core';
  import { emit } from '@tauri-apps/api/event';
  import { listen } from '@tauri-apps/api/event';
  import { onMount } from 'svelte';
  import { safeUnlisten } from '../../lib/listener-registry';
  import {
    clearChannelUnread,
    type Channel,
    upsertChannel,
    bumpChannelUnread,
  } from '../../lib/channels';
  import { requestConversation } from '../../lib/pendingConversation';
  import type { Workspace } from '../../lib/workspaces';
  import {
    type DmRequest,
    addRequest,
    removeRequest,
  } from '../../lib/dmRequests';
  import { requestChannelOpen, requestDmRequestsOpen } from './open-target';
  import CreateProjectChannel from './CreateProjectChannel.svelte';
  import {
    adminCompanyUids,
    browseOnlyCompanyProjectChannels,
    collectEnsureTargets,
    createProjectChannelProvisioner,
    type LocalProjectLike,
  } from './channel-provisioning';
  import {
    applyPairUnreads,
    applySidebarFilters,
    clearDmDot,
    clearPairUnread,
    conversationKindLabel,
    distinctDmPeople,
    filterTypeahead,
    formatSearchHitTime,
    groupByDay,
    historySearchScopeLabel,
    initialsFor,
    buildScopeOptions,
    loadConversationCache,
    loadDmDots,
    loadPins,
    loadShowFilter,
    normalizeChannel,
    normalizeConversations,
    resolveSearchHitRow,
    saveConversationCache,
    saveDmDots,
    savePins,
    saveShowFilter,
    scopeFromHotkey,
    scopePillLabel,
    searchCompanyUidFromScope,
    searchHistory,
    searchHitSnippet,
    togglePin,
    type CompanyScope,
    type ConversationRow,
    type DmContactInput,
    type MessageSearchHit,
    type MessageSearchResult,
    type ShowFilter,
    type SortMode,
  } from './sidebar-model';
  import '../v4/tokens.css';
  import './chat-tokens.css';

  interface Props {
    companies?: Workspace[] | null;
    accountLabel?: string | null;
    accountInitials?: string | null;
    /** Currently selected conversation id (`ch:…` / `dm:…`). */
    selectedId?: string | null;
    /** External company scope (cloud uid). Daybook: picking a company filters the daybook. */
    scopeUid?: string | null;
    oncommand?: () => void;
    onnavigateMessages?: () => void;
    onopenSettings?: () => void;
    onselect?: (row: ConversationRow) => void;
  }

  let {
    companies = null,
    accountLabel = null,
    accountInitials = null,
    selectedId = null,
    scopeUid = null,
    oncommand,
    onnavigateMessages,
    onopenSettings,
    onselect,
  }: Props = $props();

  interface ContactsResponse {
    contacts: DmContactInput[];
  }
  interface ChannelsResponse {
    channels?: Channel[];
  }
  interface RequestsResponse {
    requests?: DmRequest[];
  }
  interface PairUnreadEntry {
    withPersonUid: string;
    lastReadAt?: string | null;
    unreadCount: number;
  }
  interface PairUnreadsPayload {
    pairUnreads?: PairUnreadEntry[];
  }

  const storage =
    typeof window !== 'undefined' ? window.localStorage : null;

  let channels = $state<Channel[]>(
    loadConversationCache(storage)?.channels ?? [],
  );
  let contacts = $state<DmContactInput[]>(
    loadConversationCache(storage)?.contacts ?? [],
  );
  let pins = $state<string[]>(loadPins(storage));
  let dmDots = $state<string[]>(loadDmDots(storage));
  /** personUid → unreadCount from inbox `pairUnreads` (absent-safe). */
  let pairUnreads = $state<Map<string, number>>(new Map());
  /** Pending incoming connection requests (same source as MessagesShell). */
  let pendingRequests = $state<DmRequest[]>([]);

  let scope = $state<CompanyScope>('all');
  $effect(() => {
    if (scopeUid) scope = scopeUid;
  });
  let sortMode = $state<SortMode>('recent');
  // Defaults new/unset users to 'mine' ("My projects"); persisted choice wins.
  let showFilter = $state<ShowFilter>(loadShowFilter(storage));

  function setShowFilter(next: ShowFilter): void {
    showFilter = next;
    saveShowFilter(next, storage);
    filterOpen = false;
  }
  let personFilter = $state<string | null>(null);

  let lastWeekExpanded = $state(false);
  let historyOpen = $state(false);
  let historyQuery = $state('');
  /** Server message-content hits for non-empty history query (US-013). */
  let messageSearchHits = $state<MessageSearchHit[]>([]);
  let messageSearchLoading = $state(false);
  let messageSearchError = $state<string | null>(null);
  let messageSearchSeq = 0;
  let newMessageOpen = $state(false);
  let newMessageQuery = $state('');
  let createProjectChannelOpen = $state(false);
  let filterOpen = $state(false);
  let scopeMenuOpen = $state(false);
  let footerMenuOpen = $state(false);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let scopeMenuEl: HTMLDivElement | null = $state(null);
  let filterWrapEl: HTMLDivElement | null = $state(null);
  let footerEl: HTMLDivElement | null = $state(null);

  // Mirror of selectedId — do not seed $state from a prop (state_referenced_locally).
  let activeId = $state<string | null>(null);
  $effect(() => {
    activeId = selectedId;
  });

  const scopeCompanies = $derived(
    (companies ?? [])
      .filter((w) => w.kind !== 'personal' && w.cloudUid)
      .map((w) => ({
        companyUid: w.cloudUid as string,
        label: w.displayName?.trim() || w.slug,
      })),
  );

  const contactsWithUnreads = $derived(applyPairUnreads(contacts, pairUnreads));

  let localProjects = $state<LocalProjectLike[]>([]);
  const projectTitles = $derived(
    localProjects.map((p) => ({ id: p.id, title: p.title ?? p.name ?? null })),
  );

  const allRows = $derived(
    normalizeConversations(channels, contactsWithUnreads, {
      pinnedIds: pins,
      dmDots,
      projectTitles,
    }),
  );

  // Full people directory (contacts WITHOUT a conversation included) — used
  // only by the new-message typeahead, never rendered as sidebar rows (G3).
  const directoryRows = $derived(
    normalizeConversations(channels, contactsWithUnreads, {
      pinnedIds: pins,
      dmDots,
      includeContactsWithoutConversation: true,
      projectTitles,
    }),
  );

  // US-021: owner/admin-only "All company projects" view. `companyProjectChannels`
  // is the owner-scoped fetch; browse rows are the ones the caller is NOT in.
  const ownerCompanyUids = $derived(adminCompanyUids(companies ?? []));
  const canSeeCompanyProjects = $derived(ownerCompanyUids.length > 0);
  let companyProjectChannels = $state<Channel[]>([]);
  const browseRows = $derived(
    showFilter === 'company-projects'
      ? browseOnlyCompanyProjectChannels(channels, companyProjectChannels).map(
          (c) => ({
            ...normalizeChannel(c, { pinnedIds: pins, projectTitles }),
            browseOnly: true,
          }),
        )
      : [],
  );

  const pendingRequestCount = $derived(pendingRequests.length);

  const filteredRows = $derived(
    applySidebarFilters([...allRows, ...browseRows], {
      scope,
      show: showFilter,
      sort: sortMode,
      personUid: personFilter,
    }),
  );

  const grouped = $derived(groupByDay(filteredRows));
  const people = $derived(distinctDmPeople(allRows));
  const typeaheadRows = $derived(filterTypeahead(directoryRows, newMessageQuery));
  const historyRows = $derived(searchHistory(filteredRows, historyQuery));
  const historyScopeLabel = $derived(historySearchScopeLabel(scope, scopeCompanies));
  const historyCompanyUid = $derived(searchCompanyUidFromScope(scope));
  const historyHasQuery = $derived(historyQuery.trim().length > 0);
  const scopeLabel = $derived(scopePillLabel(scope, scopeCompanies));
  const scopeOptions = $derived(buildScopeOptions(scopeCompanies));
  const displayName = $derived(accountLabel?.trim() || 'Account');
  /** Footer shows the first name only (D-17). */
  const firstName = $derived(displayName.split(/\s+/)[0] || displayName);
  const initials = $derived(
    (accountInitials?.trim() || initialsFor(displayName)).slice(0, 2).toUpperCase(),
  );

  /** Mutually exclusive overlays: opening one closes the others (D-03). */
  function closeAllOverlays(): void {
    filterOpen = false;
    scopeMenuOpen = false;
    footerMenuOpen = false;
    newMessageOpen = false;
  }

  function openScopeMenu(): void {
    const next = !scopeMenuOpen;
    closeAllOverlays();
    scopeMenuOpen = next;
  }

  function openFilterMenu(): void {
    const next = !filterOpen;
    closeAllOverlays();
    filterOpen = next;
  }

  function openNewMessage(): void {
    closeAllOverlays();
    newMessageOpen = true;
    newMessageQuery = '';
  }

  function openFooterMenu(): void {
    const next = !footerMenuOpen;
    closeAllOverlays();
    footerMenuOpen = next;
  }

  function selectScope(next: CompanyScope): void {
    scope = next;
    scopeMenuOpen = false;
  }

  function scopeShortcutLabel(optionId: string, companyIndex: number): string {
    if (optionId === 'all') return '⌘0';
    if (optionId === 'personal') return '⌘P';
    if (companyIndex >= 0 && companyIndex < 5) return `⌘${companyIndex + 1}`;
    return '';
  }

  function scopeAvatarLabel(option: { id: string; label: string }): string {
    if (option.id === 'all') return 'AL';
    if (option.id === 'personal') return 'PE';
    return initialsFor(option.label);
  }

  // Avatar hue from stable hash of label (monochrome-friendly tint via CSS vars).
  function scopeAvatarTone(label: string): number {
    let h = 0;
    for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0;
    return Math.abs(h) % 6;
  }

  $effect(() => {
    if (!scopeMenuOpen && !filterOpen && !footerMenuOpen && !newMessageOpen) return;

    function onMouseDown(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      if (scopeMenuOpen && scopeMenuEl && !scopeMenuEl.contains(event.target)) {
        scopeMenuOpen = false;
      }
      if (filterOpen && filterWrapEl && !filterWrapEl.contains(event.target)) {
        filterOpen = false;
      }
      if (footerMenuOpen && footerEl && !footerEl.contains(event.target)) {
        footerMenuOpen = false;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (newMessageOpen) {
        newMessageOpen = false;
        event.preventDefault();
        return;
      }
      if (scopeMenuOpen || filterOpen || footerMenuOpen) {
        scopeMenuOpen = false;
        filterOpen = false;
        footerMenuOpen = false;
        event.preventDefault();
      }
    }

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  $effect(() => {
    if (!historyOpen) return;
    const q = historyQuery.trim();
    if (!q) {
      messageSearchHits = [];
      messageSearchError = null;
      messageSearchLoading = false;
      return;
    }
    const companyUid = historyCompanyUid;
    const seq = ++messageSearchSeq;
    messageSearchLoading = true;
    messageSearchError = null;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const resp = await invoke<MessageSearchResult>('search_messages', {
            q,
            companyUid: companyUid ?? undefined,
            limit: 50,
          });
          if (seq !== messageSearchSeq) return;
          messageSearchHits = Array.isArray(resp?.results) ? resp.results : [];
        } catch (err) {
          if (seq !== messageSearchSeq) return;
          messageSearchHits = [];
          messageSearchError =
            typeof err === 'string' ? err : 'Could not search recent messages';
          console.error('chat-sidebar: search_messages failed', err);
        } finally {
          if (seq === messageSearchSeq) messageSearchLoading = false;
        }
      })();
    }, 220);
    return () => clearTimeout(handle);
  });

  // US-021: debounced owner-scoped fetch while the company-projects view is on.
  let companyProjectsSeq = 0;
  $effect(() => {
    if (showFilter !== 'company-projects' || !canSeeCompanyProjects) return;
    const uids = ownerCompanyUids;
    const seq = ++companyProjectsSeq;
    const timer = setTimeout(async () => {
      const collected: Channel[] = [];
      for (const uid of uids) {
        try {
          const resp = await invoke<ChannelsResponse | null>('list_channels', {
            companyUid: uid,
            includeCompanyProjects: true,
          });
          for (const c of resp?.channels ?? []) collected.push(c);
        } catch (err) {
          // Absent-safe: old servers / non-owner races degrade to member-only.
          console.warn('chat-sidebar: company project listing failed', err);
        }
      }
      if (seq === companyProjectsSeq) companyProjectChannels = collected;
    }, 250);
    return () => clearTimeout(timer);
  });

  // US-021: auto-activate project channels for the user's member projects.
  // Debounced + per-session deduped; silent no-op against old servers.
  const channelProvisioner = createProjectChannelProvisioner({
    invoke: (cmd, args) => invoke(cmd, args),
  });
  async function provisionProjectChannels(): Promise<void> {
    try {
      const projects = await invoke<LocalProjectLike[] | null>('get_local_projects');
      localProjects = Array.isArray(projects) ? projects : [];
      channelProvisioner.schedule(
        collectEnsureTargets(localProjects, companies ?? []),
      );
    } catch {
      // Local project listing is best-effort; provisioning must never surface.
    }
  }

  let provisionedOnce = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRefresh(): void {
    if (refreshTimer != null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshLists();
    }, 400);
  }

  async function refreshLists(): Promise<void> {
    const firstPaint = channels.length === 0 && contacts.length === 0;
    if (firstPaint) loading = true;
    loadError = null;
    try {
      const [contactsResp, channelsResp, requestsResp] = await Promise.all([
        invoke<ContactsResponse>('list_contacts').catch((err) => {
          console.error('chat-sidebar: list_contacts failed', err);
          return { contacts: contacts } as ContactsResponse;
        }),
        invoke<ChannelsResponse | null>('list_channels').catch((err) => {
          console.error('chat-sidebar: list_channels failed', err);
          return { channels } as ChannelsResponse;
        }),
        invoke<RequestsResponse>('list_dm_requests').catch((err) => {
          console.error('chat-sidebar: list_dm_requests failed', err);
          return { requests: pendingRequests } as RequestsResponse;
        }),
      ]);
      contacts = Array.isArray(contactsResp?.contacts) ? contactsResp.contacts : [];
      channels = Array.isArray(channelsResp?.channels) ? channelsResp.channels : [];
      pendingRequests = Array.isArray(requestsResp?.requests) ? requestsResp.requests : [];
      saveConversationCache(
        { channels, contacts, cachedAt: Date.now() },
        storage,
      );
      // Provision once per session — doing it on every unread refresh
      // re-walks every local project and stalls the sidebar.
      if (!provisionedOnce) {
        provisionedOnce = true;
        void provisionProjectChannels();
      }
    } catch (err) {
      loadError = typeof err === 'string' ? err : 'Could not load conversations';
      console.error('chat-sidebar: refresh failed', err);
    } finally {
      loading = false;
    }
  }

  function mergePairUnreadsPayload(payload: PairUnreadsPayload | null | undefined): void {
    const entries = payload?.pairUnreads;
    if (!Array.isArray(entries)) return;
    // Empty array on account switch clears the map; page rollups merge in.
    if (entries.length === 0) {
      pairUnreads = new Map();
      return;
    }
    const next = new Map(pairUnreads);
    for (const entry of entries) {
      const uid = entry?.withPersonUid?.trim();
      if (!uid) continue;
      const count =
        typeof entry.unreadCount === 'number' && Number.isFinite(entry.unreadCount)
          ? Math.max(0, Math.floor(entry.unreadCount))
          : 0;
      next.set(uid, count);
    }
    pairUnreads = next;
  }

  onMount(() => {
    // Cache already painted; refresh in the background.
    void refreshLists();

    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (unlisten: () => void) => {
      const safe = safeUnlisten(unlisten);
      if (disposed) safe();
      else unlisteners.push(safe);
    };

    void listen<{ channelId: string; unread?: number }>('channel:new-message', (e) => {
      const { channelId } = e.payload;
      if (activeId === `ch:${channelId}`) return;
      if (typeof e.payload.unread === 'number') {
        channels = channels.map((c) =>
          c.channelId === channelId ? { ...c, unread: e.payload.unread } : c,
        );
      } else {
        channels = bumpChannelUnread(channels, channelId, 1);
      }
    }).then(track);

    void listen<Channel>('channel:updated', (e) => {
      channels = upsertChannel(channels, e.payload);
    }).then(track);

    void listen('channel:unread-changed', () => {
      scheduleRefresh();
    }).then(track);

    // Per-pair DM unreads from the SINGLE inbox poll (hq-pro US-010).
    void listen<PairUnreadsPayload>('dm:pair-unreads', (e) => {
      mergePairUnreadsPayload(e.payload);
    }).then(track);

    void listen<DmRequest>('dm:request-new', (e) => {
      pendingRequests = addRequest(pendingRequests, e.payload);
    }).then(track);

    void listen<{ pairKey: string }>('dm:request-update', (e) => {
      pendingRequests = removeRequest(pendingRequests, e.payload.pairKey);
      // Accept may promote a new contact — refresh so the conversation appears.
      scheduleRefresh();
    }).then(track);

    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      // Don't steal when typing in inputs.
      const t = event.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable)
      ) {
        return;
      }
      const next = scopeFromHotkey(event.key, scopeCompanies);
      if (next == null) return;
      event.preventDefault();
      event.stopPropagation();
      scope = next;
    }

    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      disposed = true;
      for (const u of unlisteners) u();
      channelProvisioner.dispose();
      window.removeEventListener('keydown', onKeyDown, true);
    };
  });

  function handlePin(row: ConversationRow, event: MouseEvent) {
    event.stopPropagation();
    pins = togglePin(pins, row.id);
    savePins(pins, storage);
  }

  async function openRow(
    row: ConversationRow,
    focus?: { messageId?: string | null; createdAt?: string | null },
  ) {
    activeId = row.id;
    onselect?.(row);
    onnavigateMessages?.();

    // G4: stash the open target SYNCHRONOUSLY, before any awaited IPC. The
    // previous ordering awaited mark-read first, so the mounting MessagesShell
    // could consume an empty stash and the first click appeared to do nothing
    // (a second click was needed once the shell was already mounted).
    if (row.kind === 'dm' && row.personUid) {
      requestConversation({
        personUid: row.personUid,
        email: row.email ?? '',
        displayName: row.title,
      });
      // Optimistic clear (local dot + numeric pair unread), then server mark-read.
      dmDots = clearDmDot(dmDots, row.personUid);
      saveDmDots(dmDots, storage);
      pairUnreads = clearPairUnread(pairUnreads, row.personUid);
      try {
        await invoke('mark_dm_thread_read', { withPersonUid: row.personUid });
      } catch (err) {
        // Non-fatal — optimistic clear already applied; next poll reconciles.
        console.error('chat-sidebar: mark_dm_thread_read failed', err);
      }
      return;
    }

    if (row.channelId) {
      requestChannelOpen(row.channelId, {
        messageId: focus?.messageId,
        createdAt: focus?.createdAt,
      });
      channels = clearChannelUnread(channels, row.channelId);
      try {
        await invoke('mark_channel_read', { channelId: row.channelId });
      } catch (err) {
        console.error('chat-sidebar: mark_channel_read failed', err);
      }
    }
  }

  function openConnectionRequests() {
    onnavigateMessages?.();
    requestDmRequestsOpen();
  }

  function openFromTypeahead(row: ConversationRow) {
    newMessageOpen = false;
    newMessageQuery = '';
    void openRow(row);
  }

  function openProjectChannelCreate() {
    newMessageOpen = false;
    newMessageQuery = '';
    createProjectChannelOpen = true;
  }

  function handleProjectChannelCreated(channel: Channel) {
    createProjectChannelOpen = false;
    channels = upsertChannel(channels, channel);
    saveConversationCache(
      { channels, contacts, cachedAt: Date.now() },
      storage,
    );
    if (channel.channelId) {
      requestChannelOpen(channel.channelId);
      onnavigateMessages?.();
    }
  }

  function openHistory() {
    historyOpen = true;
    historyQuery = '';
    messageSearchHits = [];
    messageSearchError = null;
    messageSearchLoading = false;
  }

  function closeHistory() {
    historyOpen = false;
    historyQuery = '';
    messageSearchHits = [];
    messageSearchError = null;
  }

  function openSearchHit(hit: MessageSearchHit) {
    const row = resolveSearchHitRow(hit, allRows);
    void openRow(row, {
      messageId: hit.messageId,
      createdAt: hit.createdAt,
    });
  }

  async function signOut() {
    footerMenuOpen = false;
    try {
      await emit('tray:sign-out');
    } catch (err) {
      console.error('chat-sidebar: sign out failed', err);
    }
  }

  function openSettings() {
    footerMenuOpen = false;
    onopenSettings?.();
  }
</script>

<aside class="chat-sidebar chat-shell" aria-label="Conversations" data-testid="chat-sidebar">
  {#if historyOpen}
    <div class="chat-history" data-testid="chat-history-view">
      <div class="chat-history-head">
        <button type="button" class="chat-text-btn" onclick={closeHistory}>
          Back
        </button>
        <span class="chat-section-label">History</span>
        <span class="chat-history-scope" data-testid="chat-history-scope">
          {historyScopeLabel}
        </span>
      </div>
      <input
        class="chat-search-input"
        type="search"
        placeholder="Search recent messages"
        bind:value={historyQuery}
        aria-label="Search conversation history"
        data-testid="chat-history-search"
      />
      <p class="chat-history-helper" data-testid="chat-history-helper">
        Searches recent messages (about the last 1,000)
      </p>
      <div class="chat-list" role="list" data-testid="chat-history-results">
        {#if historyHasQuery}
          {#if messageSearchLoading && messageSearchHits.length === 0}
            <div class="chat-empty" role="status">Searching…</div>
          {:else if messageSearchError}
            <div class="chat-empty" role="alert">{messageSearchError}</div>
          {:else if messageSearchHits.length === 0}
            <div class="chat-empty">No matching messages</div>
          {:else}
            {#each messageSearchHits as hit (hit.messageId + (hit.createdAt ?? ''))}
              {@const row = resolveSearchHitRow(hit, allRows)}
              <div role="listitem" class="chat-li">
              <button
                type="button"
                class="chat-row chat-search-hit"
                data-testid="chat-search-hit"
                onclick={() => openSearchHit(hit)}
              >
                {#if row.kind === 'channel'}
                  <span class="chat-glyph" aria-hidden="true">#</span>
                {:else if row.kind === 'group'}
                  <span class="chat-avatar group" aria-hidden="true">
                    {row.memberCount ?? row.members?.length ?? 0}
                  </span>
                {:else}
                  <span class="chat-avatar" aria-hidden="true">{initialsFor(row.title)}</span>
                {/if}
                <span class="chat-search-hit-copy">
                  <span class="chat-row-title">{row.title}</span>
                  <span class="chat-search-snippet">{searchHitSnippet(hit)}</span>
                </span>
                <span class="chat-search-meta">
                  <span class="chat-type-tag">{conversationKindLabel(row.kind)}</span>
                  <span class="chat-search-time">{formatSearchHitTime(hit.createdAt)}</span>
                </span>
              </button>
              </div>
            {/each}
          {/if}
        {:else}
          {#each historyRows as row (row.id)}
            <div role="listitem" class="chat-li">
            <button
              type="button"
              class="chat-row"
              class:unread={!!row.unreadCount || row.unreadDot}
              class:active={activeId === row.id}
              onclick={() => void openRow(row)}
            >
              {#if row.kind === 'channel'}
                <span class="chat-glyph" aria-hidden="true">#</span>
              {:else if row.kind === 'group'}
                <span class="chat-avatar group" aria-hidden="true">
                  {row.memberCount ?? row.members?.length ?? 0}
                </span>
              {:else}
                <span class="chat-avatar" aria-hidden="true">{initialsFor(row.title)}</span>
              {/if}
              <span class="chat-row-title">{row.title}</span>
            </button>
            </div>
          {:else}
            <div class="chat-empty">No conversations</div>
          {/each}
        {/if}
      </div>
    </div>
  {:else}
    <header class="chat-header">
      <div class="chat-scope-wrap" bind:this={scopeMenuEl}>
        <button
          type="button"
          class="chat-scope-pill"
          data-testid="chat-scope-pill"
          aria-label={`Company scope: ${scopeLabel}. Open menu.`}
          aria-expanded={scopeMenuOpen}
          aria-haspopup="menu"
          title="Company scope (⌘0 All, ⌘1–5 companies, ⌘P Personal)"
          onclick={openScopeMenu}
        >
          {#if scope === 'all'}
            <span class="chat-scope-tile all" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <rect x="1.75" y="8.25" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.3" />
                <rect x="8.75" y="8.25" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.3" />
                <rect x="5.25" y="2.25" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.3" />
              </svg>
            </span>
          {:else}
            <span class="chat-scope-tile" aria-hidden="true">{initialsFor(scopeLabel)}</span>
          {/if}
          {scopeLabel}
          <span class="chat-scope-caret" aria-hidden="true">⌄</span>
        </button>
        {#if scopeMenuOpen}
          <div
            class="chat-popover chat-scope-menu"
            data-testid="chat-scope-menu"
            role="menu"
            aria-label="Company scope"
          >
            {#each scopeOptions as option, i (option.id)}
              {@const companyIndex =
                option.id === 'all' || option.id === 'personal'
                  ? -1
                  : scopeCompanies.findIndex((c) => c.companyUid === option.id)}
              <button
                type="button"
                class="chat-popover-row chat-scope-row"
                class:active={scope === option.id}
                role="menuitemradio"
                aria-checked={scope === option.id}
                data-testid="chat-scope-option"
                data-scope={option.id}
                onclick={() => selectScope(option.id)}
              >
                <span
                  class={`chat-scope-avatar tone-${scopeAvatarTone(option.label)}`}
                  aria-hidden="true"
                >
                  {scopeAvatarLabel(option)}
                </span>
                <span class="chat-scope-row-label">
                  {option.id === 'all' ? 'All companies' : option.label}
                </span>
                {#if scopeShortcutLabel(option.id, companyIndex)}
                  <span class="chat-scope-shortcut">
                    {scopeShortcutLabel(option.id, companyIndex)}
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="chat-header-actions">
        <button
          type="button"
          class="chat-icon-btn"
          data-testid="chat-new-message"
          aria-label="New message"
          title="New message"
          onclick={openNewMessage}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
        <button
          type="button"
          class="chat-icon-btn"
          data-testid="chat-search"
          aria-label="Search (command palette)"
          title="Search (⌘K)"
          onclick={() => {
            closeAllOverlays();
            oncommand?.();
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.25" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
          </svg>
        </button>
        <div class="chat-filter-wrap" bind:this={filterWrapEl}>
          <button
            type="button"
            class="chat-icon-btn"
            class:on={showFilter !== 'mine' || personFilter != null}
            data-testid="chat-filter"
            aria-label="Filter conversations"
            aria-expanded={filterOpen}
            title="Filter"
            onclick={openFilterMenu}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
            </svg>
          </button>
          {#if filterOpen}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="chat-popover"
              data-testid="chat-filter-popover"
              role="dialog"
              tabindex="-1"
              aria-label="Conversation filters"
              onmousedown={(e) => e.stopPropagation()}
            >
              <div class="chat-section-label">Sort</div>
              <button
                type="button"
                class="chat-popover-row"
                class:active={sortMode === 'recent'}
                onclick={() => (sortMode = 'recent')}
              >
                Recent
              </button>
              <button
                type="button"
                class="chat-popover-row"
                class:active={sortMode === 'type'}
                onclick={() => (sortMode = 'type')}
              >
                Type
              </button>
              <div class="chat-section-label pad-top">Show</div>
              <button
                type="button"
                class="chat-popover-row"
                data-testid="chat-filter-mine"
                class:active={showFilter === 'mine'}
                onclick={() => setShowFilter('mine')}
              >
                My projects
              </button>
              <button
                type="button"
                class="chat-popover-row"
                class:active={showFilter === 'all'}
                onclick={() => setShowFilter('all')}
              >
                All
              </button>
              <button
                type="button"
                class="chat-popover-row"
                class:active={showFilter === 'projects'}
                onclick={() => setShowFilter('projects')}
              >
                Projects
              </button>
              <button
                type="button"
                class="chat-popover-row"
                class:active={showFilter === 'dms'}
                onclick={() => setShowFilter('dms')}
              >
                DMs
              </button>
              {#if canSeeCompanyProjects}
                <!-- US-021: org owners/admins only — includes other members'
                     project channels (browse-only rows). -->
                <button
                  type="button"
                  class="chat-popover-row"
                  data-testid="chat-filter-company-projects"
                  class:active={showFilter === 'company-projects'}
                  onclick={() => setShowFilter('company-projects')}
                >
                  All company projects
                </button>
              {/if}
              {#if people.length > 0}
                <div class="chat-section-label pad-top">People</div>
                <button
                  type="button"
                  class="chat-popover-row"
                  class:active={personFilter == null}
                  onclick={() => { personFilter = null; filterOpen = false; }}
                >
                  Everyone
                </button>
                {#each people as person (person.personUid)}
                  <button
                    type="button"
                    class="chat-popover-row"
                    class:active={personFilter === person.personUid}
                    onclick={() => { personFilter = person.personUid; filterOpen = false; }}
                  >
                    {person.label}
                  </button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </header>

    <div class="chat-scroll" data-testid="chat-conversation-list">
      {#if pendingRequestCount > 0}
        <button
          type="button"
          class="chat-row chat-requests-row"
          data-testid="chat-connection-requests"
          aria-label={`Connection requests, ${pendingRequestCount} pending`}
          onclick={openConnectionRequests}
        >
          <span class="chat-glyph requests" aria-hidden="true">·</span>
          <span class="chat-row-title">Connection requests</span>
          <span
            class="chat-unread-badge"
            data-testid="chat-requests-count"
            aria-hidden="true"
          >
            {pendingRequestCount > 99 ? '99+' : pendingRequestCount}
          </span>
        </button>
      {/if}

      {#if grouped.pinned.length > 0}
        <div class="chat-section-label" id="chat-pinned-label">
          <span class="chat-pin-ic" aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.2 2.4 13.6 5.8a.8.8 0 0 1-.15 1.26l-2.2 1.27-.7 3.15a.6.6 0 0 1-.98.32L7.2 9.43 4.3 12.32a.55.55 0 0 1-.78-.78L6.4 8.66 4.05 6.3a.6.6 0 0 1 .32-.98l3.15-.7 1.27-2.2A.8.8 0 0 1 10.2 2.4Z" />
            </svg>
          </span>
          PINNED
        </div>
        <div class="chat-list" role="list" aria-labelledby="chat-pinned-label">
          {#each grouped.pinned as row (row.id)}
            {@render conversationRow(row)}
          {/each}
        </div>
      {/if}

      {#each grouped.sections as section (section.key)}
        {@const [sectionName, sectionDate] = section.label.split(' · ')}
        <div class="chat-section-label chat-day-head" id={`chat-sec-${section.key}`}>
          <span>{sectionName}</span>
          {#if sectionDate}<span class="chat-day-date" data-testid="chat-day-date">{sectionDate}</span>{/if}
        </div>
        <div class="chat-list" role="list" aria-labelledby={`chat-sec-${section.key}`}>
          {#each section.rows as row (row.id)}
            {@render conversationRow(row)}
          {/each}
        </div>
      {/each}

      {#if grouped.lastWeek.length > 0}
        <button
          type="button"
          class="chat-collapse-row"
          data-testid="chat-last-week"
          aria-expanded={lastWeekExpanded}
          onclick={() => (lastWeekExpanded = !lastWeekExpanded)}
        >
          <span class="chat-collapse-left">
            <span class="chat-collapse-chevron" class:open={lastWeekExpanded} aria-hidden="true">›</span>
            <span class="chat-section-label inline">Last week</span>
          </span>
          {#if !lastWeekExpanded}
            <span class="chat-collapse-meta" data-testid="chat-last-week-count">{grouped.lastWeek.length}</span>
          {/if}
        </button>
        {#if lastWeekExpanded}
          <div class="chat-list" role="list" aria-label="Last week">
            {#each grouped.lastWeek as row (row.id)}
              {@render conversationRow(row)}
            {/each}
          </div>
        {/if}
      {/if}

      <button
        type="button"
        class="chat-history-affordance"
        data-testid="chat-show-history"
        onclick={openHistory}
      >
        Show all history…
      </button>

      {#if loading && allRows.length === 0}
        <div class="chat-empty" role="status">Loading…</div>
      {:else if loadError && allRows.length === 0}
        <div class="chat-empty" role="alert">{loadError}</div>
      {:else if filteredRows.length === 0}
        <div class="chat-empty">No conversations</div>
      {/if}
    </div>

    <div class="chat-footer" bind:this={footerEl}>
      <button
        type="button"
        class="chat-user-card"
        data-testid="chat-user-card"
        aria-haspopup="menu"
        aria-expanded={footerMenuOpen}
        onclick={openFooterMenu}
      >
        <span class="chat-avatar" aria-hidden="true">{initials}</span>
        <span class="chat-user-copy">
          <span class="chat-user-name">{firstName}</span>
          <span class="chat-user-status">
            <span class="chat-status-dot" aria-hidden="true"></span>
            SYNCED
          </span>
        </span>
        <span class="chat-chevron" aria-hidden="true">›</span>
      </button>
      {#if footerMenuOpen}
        <div class="chat-popover footer" role="menu" data-testid="chat-user-menu">
          <button type="button" class="chat-popover-row" role="menuitem" onclick={openSettings}>
            Settings
          </button>
          <button type="button" class="chat-popover-row" role="menuitem" onclick={() => void signOut()}>
            Sign out
          </button>
        </div>
      {/if}
    </div>
  {/if}

  {#if newMessageOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="chat-modal-backdrop"
      data-testid="chat-new-message-modal"
      onclick={(e) => {
        if (e.target === e.currentTarget) newMessageOpen = false;
      }}
      onkeydown={(e) => {
        if (e.key === 'Escape') newMessageOpen = false;
      }}
    >
      <div class="chat-modal" role="dialog" aria-label="New message" tabindex="-1">
        <div class="chat-modal-head">
          <span class="chat-section-label">New message</span>
          <button type="button" class="chat-text-btn" onclick={() => (newMessageOpen = false)}>
            Close
          </button>
        </div>
        <button
          type="button"
          class="chat-row chat-create-action"
          data-testid="chat-project-channel"
          onclick={openProjectChannelCreate}
        >
          <span class="chat-glyph" aria-hidden="true">#</span>
          <span class="chat-row-title">Project channel</span>
        </button>
        <input
          class="chat-search-input"
          type="search"
          placeholder="Find a person or channel"
          bind:value={newMessageQuery}
          aria-label="Find recipient or channel"
        />
        <div class="chat-list modal-list" role="list">
          {#each typeaheadRows as row (row.id)}
            <div role="listitem" class="chat-li">
            <button
              type="button"
              class="chat-row"
              onclick={() => openFromTypeahead(row)}
            >
              {#if row.kind === 'channel'}
                <span class="chat-glyph" aria-hidden="true">#</span>
              {:else if row.kind === 'group'}
                <span class="chat-avatar group" aria-hidden="true">
                  {row.memberCount ?? row.members?.length ?? 0}
                </span>
              {:else}
                <span class="chat-avatar" aria-hidden="true">{initialsFor(row.title)}</span>
              {/if}
              <span class="chat-row-title">{row.title}</span>
            </button>
            </div>
          {:else}
            <div class="chat-empty">No matches</div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  {#if createProjectChannelOpen}
    <CreateProjectChannel
      companies={companies}
      onclose={() => (createProjectChannelOpen = false)}
      oncreated={handleProjectChannelCreated}
    />
  {/if}
</aside>

{#snippet conversationRow(row: ConversationRow)}
  <div role="listitem" class="chat-li">
  <button
    type="button"
    class="chat-row"
    class:unread={!!row.unreadCount || row.unreadDot}
    class:active={activeId === row.id}
    data-kind={row.kind}
    data-conversation-id={row.id}
    onclick={() => void openRow(row)}
    oncontextmenu={(e) => handlePin(row, e)}
  >
    {#if row.kind === 'channel'}
      <span class="chat-glyph" aria-hidden="true">#</span>
    {:else if row.kind === 'group'}
      <span class="chat-avatar group" aria-hidden="true" data-testid="chat-group-avatar">
        {row.memberCount ?? row.members?.length ?? 0}
      </span>
    {:else}
      <span class="chat-avatar" aria-hidden="true" data-testid="chat-dm-avatar">
        {initialsFor(row.title)}
      </span>
    {/if}
    <span class="chat-row-title">{row.title}</span>
    {#if row.unreadCount != null && row.unreadCount > 0}
      <span class="chat-unread-badge" data-testid="chat-unread-badge" aria-label={`${row.unreadCount} unread`}>
        {row.unreadCount > 99 ? '99+' : row.unreadCount}
      </span>
    {:else if row.unreadDot}
      <span class="chat-unread-dot" data-testid="chat-unread-dot" aria-label="Unread"></span>
    {/if}
  </button>
  </div>
{/snippet}

<style>
  .chat-sidebar {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 0 0 260px;
    width: 260px;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    border-right: 1px solid var(--line);
    background: var(--side-bg);
    backdrop-filter: var(--v4-glass-filter);
    -webkit-backdrop-filter: var(--v4-glass-filter);
    box-shadow: inset 1px 0 0 var(--v4-glass-highlight);
    font-family: var(--font-ui);
    color: var(--t1);
    padding: 12px 14px 10px;
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex: 0 0 auto;
    height: 28px;
    padding: 0;
    margin-bottom: 10px;
  }

  .chat-header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .chat-scope-wrap {
    position: relative;
    min-width: 0;
  }

  .chat-scope-tile {
    display: grid;
    place-items: center;
    flex: 0 0 24px;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    background: var(--btn-bg);
    color: var(--t2);
    font: 700 9px var(--font-ui);
    letter-spacing: 0.18px;
  }

  .chat-scope-tile.all {
    color: var(--t2);
  }

  .chat-pin-ic {
    display: inline-grid;
    place-items: center;
    color: var(--t2);
  }

  .chat-scope-pill {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    max-width: 140px;
    height: 26px;
    padding: 0;
    overflow: hidden;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    transition: opacity 0.12s;
  }

  .chat-scope-pill:hover,
  .chat-scope-pill[aria-expanded='true'] {
    background: transparent;
    opacity: 0.65;
  }

  .chat-scope-caret {
    flex: 0 0 auto;
    color: var(--t3);
    font-size: 10px;
    line-height: 1;
  }

  /* S3: 252px panel, 32px single-line rows (tile + label + chord inline),
     no wrap and no resting scrollbar artifact — token contract §6 scopePanel. */
  .chat-scope-menu {
    left: 0;
    right: auto;
    width: 252px;
    min-width: 252px;
    max-height: min(60vh, 420px);
    overflow-y: auto;
    scrollbar-width: none;
  }

  .chat-scope-menu::-webkit-scrollbar {
    display: none;
  }

  /* Double-class beats the later `.chat-popover-row { display: block }`. */
  .chat-popover-row.chat-scope-row {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 9px;
    box-sizing: border-box;
    height: 32px;
    padding: 6px 8px;
    white-space: nowrap;
  }

  .chat-scope-avatar {
    display: grid;
    place-items: center;
    flex: 0 0 24px;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    background: var(--btn-bg);
    color: var(--t2);
    font: 700 9px var(--font-ui);
    letter-spacing: 0.02em;
  }

  .chat-scope-avatar.tone-0 {
    background: var(--line2);
  }
  .chat-scope-avatar.tone-1 {
    background: var(--line2);
  }
  .chat-scope-avatar.tone-2 {
    background: var(--line2);
  }
  .chat-scope-avatar.tone-3 {
    background: var(--line2);
  }
  .chat-scope-avatar.tone-4 {
    background: var(--line2);
  }
  .chat-scope-avatar.tone-5 {
    background: var(--line2);
  }

  .chat-scope-row-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-scope-shortcut {
    flex: 0 0 auto;
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 400;
  }

  .chat-icon-btn {
    appearance: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
  }

  .chat-icon-btn.on,
  .chat-icon-btn:hover,
  .chat-icon-btn[aria-expanded='true'] {
    border-color: transparent;
    background: var(--hover);
    color: var(--t1);
  }

  .chat-icon-btn svg {
    width: 14px;
    height: 14px;
  }

  .chat-filter-wrap {
    position: relative;
  }

  .chat-scroll {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    margin-right: -8px;
    padding: 0 8px 12px 0;
    scrollbar-color: var(--line) transparent;
    scrollbar-width: thin;
  }

  .chat-scroll::-webkit-scrollbar { width: 4px; }
  .chat-scroll::-webkit-scrollbar-track { background: transparent; margin: 10px 0; }
  .chat-scroll::-webkit-scrollbar-thumb { background: var(--line); border-radius: 999px; }
  .chat-scroll::-webkit-scrollbar-thumb:hover { background: var(--line2); }

  .chat-section-label {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    margin: 0;
    padding: 12px 8px 4px;
    color: var(--t2);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .chat-section-label.inline {
    margin: 0;
    padding: 0;
  }

  /* Day-group header: name left, date right-aligned (D-13). */
  .chat-day-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .chat-day-date {
    color: var(--t3);
    font-family: var(--font-mono, inherit);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  /* Listitem wrapper keeps ARIA list semantics without breaking layout (D-19). */
  .chat-li {
    display: contents;
  }

  .chat-collapse-left {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .chat-collapse-chevron {
    color: var(--t3);
    font-size: 13px;
    line-height: 1;
    transition: transform 120ms ease;
  }

  .chat-collapse-chevron.open {
    transform: rotate(90deg);
  }

  .chat-section-label.pad-top {
    margin-top: 0;
    padding-top: 12px;
  }

  .chat-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .chat-row {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    width: 100%;
    min-height: 0;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    line-height: 1.2;
    text-align: left;
    cursor: pointer;
  }

  .chat-requests-row {
    color: var(--t3);
    font-size: 12px;
    font-weight: 500;
  }

  .chat-row:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .chat-row.active {
    background: var(--sel);
    box-shadow: none;
    color: var(--t1);
  }

  .chat-row.unread .chat-row-title {
    color: var(--t1);
    font-weight: 500;
  }

  .chat-row-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-glyph {
    flex: 0 0 16px;
    width: 16px;
    color: var(--t3);
    font-size: 16px;
    font-weight: 400;
    text-align: center;
  }

  .chat-avatar {
    display: grid;
    place-items: center;
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--line2);
    color: var(--t2);
    font: 600 9px var(--font-ui);
    letter-spacing: 0.02em;
  }

  .chat-avatar.group {
    border-radius: 50%;
    font-variant-numeric: tabular-nums;
  }

  .chat-unread-badge {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-width: 16px;
    height: 16px;
    margin-left: auto;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--ice-ink);
    color: var(--badge-fg);
    font-size: 10px;
    font-weight: 500;
    line-height: 1;
  }

  .chat-unread-dot {
    flex: 0 0 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 16px;
    height: 16px;
    margin-left: auto;
    border-radius: 50%;
    background: transparent;
  }

  .chat-unread-dot::after {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ice-ink);
  }

  .chat-collapse-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    margin-top: 8px;
    padding: 12px 8px 4px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--t2);
    font: inherit;
    cursor: pointer;
  }

  .chat-collapse-row:hover {
    background: transparent;
    color: var(--t1);
  }

  .chat-collapse-meta {
    color: var(--t3);
    font-size: 10px;
    font-weight: 400;
  }

  .chat-history-affordance {
    width: 100%;
    margin-top: 8px;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }

  .chat-history-affordance:hover {
    color: var(--t2);
    background: var(--hover);
  }

  .chat-empty {
    padding: 16px 8px;
    color: var(--t3);
    font-size: 13px;
    font-weight: 400;
  }

  .chat-footer {
    position: relative;
    flex: 0 0 auto;
    border-top: 1px solid var(--line);
    margin-top: 8px;
    padding: 0;
  }

  .chat-user-card {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px;
    margin-top: 6px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s;
  }

  .chat-user-card:hover {
    background: var(--hover);
  }

  .chat-user-card:hover .chat-user-name {
    color: var(--t1);
  }

  .chat-user-card:hover .chat-chevron {
    color: var(--t2);
  }

  .chat-user-card .chat-avatar {
    flex: 0 0 22px;
    width: 22px;
    height: 22px;
    background: var(--line2);
    color: var(--t1);
    font: 600 10px var(--font-ui);
  }

  .chat-user-copy {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .chat-user-name {
    overflow: hidden;
    font-size: 12px;
    font-weight: 500;
    color: var(--t2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-user-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--ok-ink);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .chat-status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ok);
  }

  .chat-chevron {
    color: var(--t3);
    font-size: 10px;
    font-weight: 400;
    transform: rotate(90deg);
  }

  .chat-popover {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    min-width: 160px;
    max-height: 280px;
    overflow-y: auto;
    padding: 6px;
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    background: var(--panel-bg);
    box-shadow: var(--panel-shadow);
    backdrop-filter: blur(40px) saturate(1.5);
    -webkit-backdrop-filter: blur(40px) saturate(1.5);
  }

  :global(:root[data-force-theme='dark']) .chat-popover,
  :global(.dark) .chat-popover {
    background: var(--panel-bg);
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-force-theme='light'])) .chat-popover {
      background: var(--panel-bg);
    }
  }

  .chat-popover.footer {
    top: auto;
    bottom: calc(100% + 4px);
    left: 8px;
    right: 8px;
  }

  .chat-popover-row {
    display: block;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 12px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  .chat-popover-row:hover,
  .chat-popover-row.active {
    background: var(--hover);
    color: var(--t1);
  }

  .chat-popover-row.active {
    font-weight: 500;
  }

  .chat-history {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    padding: 12px 6px;
  }

  .chat-history-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 4px 8px;
  }

  .chat-history-scope {
    margin-left: auto;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 11px);
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .chat-history-helper {
    margin: 0 4px 8px;
    padding: 0 6px;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 11px);
    font-weight: 400;
    line-height: 1.35;
  }

  .chat-search-hit {
    align-items: flex-start;
    min-height: 44px;
    padding-top: 6px;
    padding-bottom: 6px;
  }

  .chat-search-hit-copy {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .chat-search-snippet {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 12px);
    font-weight: 400;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-search-meta {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    max-width: 88px;
  }

  .chat-type-tag {
    color: var(--v4-text-3);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .chat-search-time {
    color: var(--v4-text-3);
    font-size: 10px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .chat-search-input {
    box-sizing: border-box;
    width: calc(100% - 8px);
    margin: 0 4px 8px;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-field);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-secondary, 13px);
    font-weight: 400;
  }

  .chat-search-input:focus {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
  }

  .chat-text-btn {
    padding: 4px 6px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-secondary, 13px);
    font-weight: 500;
    cursor: pointer;
  }

  .chat-text-btn:hover {
    color: var(--v4-text-1);
  }

  .chat-create-action {
    margin: 0 4px 6px;
    width: calc(100% - 8px);
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
  }

  .chat-modal-backdrop {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 48px 12px 12px;
    background: color-mix(in srgb, var(--v4-text-1) 18%, transparent);
  }

  .chat-modal {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-height: 70%;
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
    /* Opaque surface — no transparent bleed-through (D-03). */
    background: var(--v4-surface-solid, #fff);
    box-shadow: var(--v4-shadow-popover);
  }

  :global(:root[data-force-theme='dark']) .chat-modal,
  :global(.dark) .chat-modal {
    background: var(--v4-surface-solid, #303030);
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-force-theme='light'])) .chat-modal {
      background: var(--v4-surface-solid, #303030);
    }
  }

  .chat-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 8px 0;
  }

  .modal-list {
    overflow-y: auto;
    padding: 0 4px 8px;
  }
</style>
