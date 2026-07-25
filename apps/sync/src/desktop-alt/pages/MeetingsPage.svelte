<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import { onMount } from 'svelte';
  import {
    activeMeetings,
    recordingMemberships,
    setRecordingCompany,
    startRecording,
    stopRecording,
  } from '../../lib/activeMeetings';
  import {
    meetingsStore,
    startMeetingsStore,
    type ToastDescriptor,
  } from '../lib/meetings-store.svelte';
  import LiveNowCard from '../components/LiveNowCard.svelte';
  import MeetingsAgenda from '../components/MeetingsAgenda.svelte';
  import {
    buildConnectedCalendarRows,
    activeRecordingsFromScheduledBots,
    companyLabel,
    durationLabel,
    eventEnd,
    eventStart,
    eventMeetingUrl,
    extractedSignalLabels,
    groupByDay,
    isPlausibleMeetingUrl,
    pickLiveMeeting,
    pickUpNext,
    sortByStart,
    timeLabel,
    totalSignalCounts,
    type MeetingEvent,
  } from '../lib/meetings-model';
  import '../v4/tokens.css';

  // Store-backed data. The singleton (started at app launch in
  // DesktopApp.onMount) loads once + polls every 30s, so this page is a thin
  // consumer: it reads the already-warm store instead of running a blocking
  // network fetch on every nav remount — which is what made the page take
  // 5-10s to paint. Aliased through $derived so the presentation derives below
  // — and the US-006 source-contract strings — stay unchanged.
  const events = $derived(meetingsStore.events);
  const botsByEventId = $derived(meetingsStore.botsByEventId);
  const scheduledBots = $derived(meetingsStore.scheduledBots);
  const accounts = $derived(meetingsStore.accounts);
  const calendarsByAccount = $derived(meetingsStore.calendarsByAccount);
  const enabledCalIdsByAccount = $derived(meetingsStore.enabledCalIdsByAccount);
  const companyNamesByUid = $derived(meetingsStore.companyNamesByUid);
  const memberships = $derived(meetingsStore.memberships);
  const membershipsError = $derived(meetingsStore.membershipsError);
  const fetchError = $derived(meetingsStore.fetchError);
  const refreshBlocked = $derived(meetingsStore.refreshBlocked);
  const loading = $derived(meetingsStore.loading);
  // Per-row in-flight set for bot actions, owned by the store. Passed to the
  // agenda so each row can disable its buttons + spin while its invoke runs.
  const pendingEventIds = $derived(meetingsStore.pendingEventIds);

  // Recordings inferred from the calendar snapshot's scheduled bots. Derived
  // (not manually assigned) so it recomputes whenever the cache-first paint or
  // the live network refresh swaps `events`/`botsByEventId`.
  const cachedActiveRecordings = $derived(
    activeRecordingsFromScheduledBots(events, botsByEventId),
  );

  const liveMeeting = $derived(pickLiveMeeting([...cachedActiveRecordings, ...$activeMeetings]));
  // The calendar event id behind the live detection, so the agenda can mark
  // exactly that row "Live" (recall bots carry the originating event id).
  const liveEventId = $derived(liveMeeting?.sourceEventId ?? null);
  // Multi-day agenda: `meetings_list_upcoming` already returns events across
  // the server's sync window, so we show them all grouped by day rather than
  // narrowing to today (the old `isToday` filter hid every non-today meeting,
  // which read as an empty "no meetings" view).
  const upcomingEvents = $derived([...events].sort(sortByStart));
  const dayGroups = $derived(groupByDay(upcomingEvents));
  const upNext = $derived(pickUpNext(upcomingEvents));
  const signalTotals = $derived(totalSignalCounts(upcomingEvents));
  const connectedRows = $derived(
    buildConnectedCalendarRows(
      accounts,
      calendarsByAccount,
      enabledCalIdsByAccount,
      events,
      memberships,
    ),
  );
  const recentlySynced = $derived(
    events
      .filter((event) => extractedSignalLabels(event).length > 0)
      .sort((a, b) => (eventEnd(b)?.getTime() ?? eventStart(b)?.getTime() ?? 0) - (eventEnd(a)?.getTime() ?? eventStart(a)?.getTime() ?? 0))
      .slice(0, 3),
  );

  // Upcoming meetings carrying >=1 extracted signal — powers "from N meetings" caption.
  const signalMeetingCount = $derived(
    upcomingEvents.filter((event) => extractedSignalLabels(event).length > 0).length,
  );

  /**
   * Compact meeting-bot health from real scheduled-bot statuses only.
   * Calm when empty/waiting; explicit when a bot carries an error message.
   */
  const botHealth = $derived.by(() => {
    let scheduled = 0;
    let inCall = 0;
    let joining = 0;
    let processing = 0;
    let done = 0;
    let errored = 0;
    for (const bot of scheduledBots) {
      const status = (bot.status ?? '').toLowerCase();
      if (bot.errorMessage) {
        errored += 1;
        continue;
      }
      if (status === 'recording' || status === 'in_call' || status === 'in-call') {
        inCall += 1;
      } else if (status === 'joining') {
        joining += 1;
      } else if (status === 'processing') {
        processing += 1;
      } else if (status === 'completed') {
        done += 1;
      } else if (status === 'scheduled') {
        scheduled += 1;
      } else {
        scheduled += 1;
      }
    }
    return {
      total: scheduledBots.length,
      scheduled,
      inCall,
      joining,
      processing,
      done,
      errored,
    };
  });

  const botHealthLabel = $derived.by(() => {
    if (botHealth.total === 0) return 'No bots scheduled';
    const parts: string[] = [];
    if (botHealth.inCall > 0) parts.push(`${botHealth.inCall} in call`);
    if (botHealth.joining > 0) parts.push(`${botHealth.joining} joining`);
    if (botHealth.scheduled > 0) parts.push(`${botHealth.scheduled} ready`);
    if (botHealth.processing > 0) parts.push(`${botHealth.processing} processing`);
    if (botHealth.done > 0) parts.push(`${botHealth.done} done`);
    if (botHealth.errored > 0) parts.push(`${botHealth.errored} need attention`);
    return parts.length > 0 ? parts.join(' · ') : `${botHealth.total} bots`;
  });

  const toolbarMeta = $derived.by(() => {
    const days = dayGroups.length;
    const dayPart = `${days} day${days === 1 ? '' : 's'}`;
    const meetingPart = `${upcomingEvents.length} upcoming`;
    return `${meetingPart} · ${dayPart} · all companies`;
  });

  // Transient action feedback. The store owns the invoke + decides the copy
  // (returns a ToastDescriptor next to the call that produced it); this page
  // only renders it. `null` = nothing to surface (no-op dedupe / missing bot).
  let toast = $state<ToastDescriptor | null>(null);
  let meetingsFeatureEnabled = $state<boolean | null>(null);
  function flashToast(kind: 'info' | 'warn', text: string): void {
    toast = { kind, text };
    setTimeout(() => {
      if (toast && toast.text === text) toast = null;
    }, 4000);
  }

  // Thin wrappers: delegate the invoke to the store, surface its toast (if any).
  // The agenda calls these via callback props so it stays 'invoke'-free.
  async function onInvite(evt: MeetingEvent): Promise<void> {
    const t = await meetingsStore.inviteBot(evt);
    if (t) flashToast(t.kind, t.text);
  }
  async function onUninvite(evt: MeetingEvent): Promise<void> {
    const t = await meetingsStore.cancelBot(evt);
    if (t) flashToast(t.kind, t.text);
  }
  async function onJoinNow(evt: MeetingEvent): Promise<void> {
    const t = await meetingsStore.joinBotNow(evt);
    if (t) flashToast(t.kind, t.text);
  }

  // Ad-hoc "paste a meeting URL" invite — parity with the classic
  // MeetingsWindow. Sends the recording bot to a link that isn't on the user's
  // calendar. `urlInputCompanyId` null = Personal (the default). This page owns
  // the in-flight guard; the store owns the invoke + toast copy.
  let urlInput = $state('');
  let urlInputCompanyId = $state<string | null>(null);
  let urlInviting = $state(false);
  async function onUrlInvite(): Promise<void> {
    const url = urlInput.trim();
    if (urlInviting || !isPlausibleMeetingUrl(url)) return;
    urlInviting = true;
    // Snapshot the destination BEFORE the await so a slow request that lands
    // after the user re-types doesn't clear their next selection.
    const submittedCompanyId = urlInputCompanyId;
    try {
      const t = await meetingsStore.inviteBotByUrl(url, submittedCompanyId);
      if (t) {
        // `info` = invited (success or already-scheduled) → reset the row so the
        // next paste starts fresh on Personal. `warn` = keep it for a retry.
        if (t.kind === 'info') {
          urlInput = '';
          urlInputCompanyId = null;
        }
        flashToast(t.kind, t.text);
      }
    } finally {
      urlInviting = false;
    }
  }
  let reporting = $state(false);
  async function onReportProblem(): Promise<void> {
    if (reporting) return;
    reporting = true;
    try {
      const t = await meetingsStore.reportRefreshProblem();
      flashToast(t.kind, t.text);
    } finally {
      reporting = false;
    }
  }

  function openCalendar(): void {
    void openExternal('https://calendar.google.com');
  }

  function joinUpNext(): void {
    if (!upNext) return;
    const url = eventMeetingUrl(upNext);
    if (url) void openExternal(url);
  }

  onMount(() => {
    invoke<boolean>('meetings_feature_enabled')
      .then((enabled) => {
        meetingsFeatureEnabled = enabled;
      })
      .catch(() => {
        meetingsFeatureEnabled = false;
      });
    // The store is a module-level singleton started once at app launch from
    // DesktopApp.onMount. Calling it here too keeps the page self-sufficient
    // for isolated mounts (tests / direct nav); it's idempotent via an internal
    // `started` guard, so this never double-fetches or double-polls. The
    // cache-first paint, live refresh, 30s poll, and focus/storage listeners
    // all live in the store now — this remount just reads the already-warm
    // singleton, which is what makes the nav instant instead of 5-10s.
    startMeetingsStore();
  });
</script>

{#if meetingsFeatureEnabled === false}
  <div class="meetings-feature-hidden" data-testid="meetings-feature-hidden" role="status">
    Meetings are not available for this account.
  </div>
{/if}

<!-- DESKTOP meetings native: compact toolbar, Live now → Up next → bot health → agenda. -->
<div class="meetings" class:hidden-by-gate={meetingsFeatureEnabled === false} aria-label="Meetings" data-testid="desktop-alt-meetings">
  {#snippet iconCalendar()}
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  {/snippet}
  {#snippet iconSync()}
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 0 0-15-6.7L3 8" />
      <path d="M3 12a9 9 0 0 0 15 6.7L21 16" />
      <path d="M3 3v5h5" />
      <path d="M21 21v-5h-5" />
    </svg>
  {/snippet}

  <header class="page-header meetings-toolbar">
    <div class="ph-titles">
      <h1>Meetings</h1>
      <div class="subtitle">{toolbarMeta}</div>
      {#if fetchError}
        <div class="page-error" role="status" data-testid="meetings-refresh-error">
          <span class="error-pill" title={fetchError}>Refresh issue</span>
          <span class="error-copy">{fetchError}</span>
          {#if refreshBlocked}
            <button type="button" class="report-link" onclick={onReportProblem} disabled={reporting}>
              {reporting ? 'Reporting…' : 'Report a problem'}
            </button>
          {/if}
        </div>
      {/if}
    </div>
    <div class="actions detail-primary-actions">
      <button type="button" class="btn subtle" onclick={openCalendar}>
        <span class="icon">{@render iconCalendar()}</span>
        Open calendar
      </button>
      <button type="button" class="btn" onclick={() => void meetingsStore.refresh()} disabled={loading}>
        <span class="icon">{@render iconSync()}</span>
        {loading ? 'Refreshing' : 'Refresh'}
      </button>
    </div>
  </header>

  {#if toast}
    <div class="toast" class:toast-warn={toast.kind === 'warn'} role="status">{toast.text}</div>
  {/if}

  <div class="content">
    <div class="url-invite-bar">
      <input
        type="url"
        inputmode="url"
        autocomplete="off"
        spellcheck="false"
        placeholder="Paste a Zoom or Google Meet URL"
        aria-label="Paste a meeting URL to send the recording bot"
        bind:value={urlInput}
        disabled={urlInviting}
        class="url-input"
        onkeydown={(e) => {
          if (e.key === 'Enter' && isPlausibleMeetingUrl(urlInput.trim())) {
            e.preventDefault();
            void onUrlInvite();
          }
        }}
      />
      {#if urlInput.trim().length > 0}
        <!-- Destination picker. Only renders once the user starts typing —
             keeps the idle bar clean. `null` = Personal (the default). -->
        <select
          class="url-invite-company"
          aria-label="Save bot to"
          bind:value={urlInputCompanyId}
          disabled={urlInviting}
        >
          <option value={null}>Personal</option>
          {#each [...companyNamesByUid.entries()] as [uid, name] (uid)}
            <option value={uid}>{name}</option>
          {/each}
        </select>
      {/if}
      <button
        type="button"
        class="btn url-invite-btn"
        disabled={urlInviting || !isPlausibleMeetingUrl(urlInput.trim())}
        onclick={onUrlInvite}
      >
        {urlInviting ? 'Inviting…' : 'Invite'}
      </button>
    </div>

    <!-- 1. Live now — true live monitor (rounded only while active). -->
    <LiveNowCard
      meeting={liveMeeting}
      memberships={$recordingMemberships}
      onstart={startRecording}
      onstop={stopRecording}
      oncompany={setRecordingCompany}
    />

    <!-- 2. Up next — compact strip, not a summary card. -->
    <section class="next-strip" aria-label="Up next" data-testid="meetings-up-next">
      <div class="next-time">{upNext ? timeLabel(upNext) : '—'}</div>
      <div class="next-copy">
        {#if upNext}
          {@const dur = durationLabel(upNext)}
          <div class="next-title">{upNext.summary ?? '(no title)'}</div>
          <div class="next-meta">
            Next · {companyLabel(upNext, companyNamesByUid)}{#if dur} · {dur}{/if}
          </div>
        {:else}
          <div class="next-title">Nothing scheduled next</div>
          <div class="next-meta">Waiting for the next calendar event</div>
        {/if}
      </div>
      {#if upNext && eventMeetingUrl(upNext)}
        <button type="button" class="btn subtle next-join" onclick={joinUpNext}>Join</button>
      {/if}
    </section>

    <!-- 3. Meeting-bot health + calendar sync (discrete status, not dashboard cards). -->
    <section class="health-strip" aria-label="Meeting bot status" data-testid="meetings-bot-health">
      <div class="health-item">
        <span class="health-label">Bots</span>
        <span class="health-value" class:health-error={botHealth.errored > 0}>{botHealthLabel}</span>
      </div>
      <div class="health-item">
        <span class="health-label">Calendars</span>
        <span class="health-value">
          {#if membershipsError}
            <span class="health-error-text">{membershipsError}</span>
          {:else if connectedRows.length === 0}
            {accounts.length === 0 ? 'None connected' : 'No enabled calendars'}
          {:else}
            {connectedRows.length} connected
          {/if}
        </span>
      </div>
      <div class="health-item">
        <span class="health-label">Signals</span>
        <span class="health-value">
          {signalTotals.actions}a · {signalTotals.decisions}d · {signalTotals.risks}r
          <span class="health-sub">from {signalMeetingCount} meeting{signalMeetingCount === 1 ? '' : 's'}</span>
        </span>
      </div>
    </section>

    <!-- 4. Upcoming agenda — naked hairline rows, primary surface. -->
    <MeetingsAgenda
      groups={dayGroups}
      {upNext}
      totalCount={upcomingEvents.length}
      companyNames={companyNamesByUid}
      {liveEventId}
      {botsByEventId}
      {scheduledBots}
      {pendingEventIds}
      {onInvite}
      {onUninvite}
      {onJoinNow}
      onOpenExternal={openExternal}
    />

    <!-- Secondary: connected calendars + recent signals as hairline sections. -->
    <div class="section secondary-grid">
      <section class="secondary-section" aria-labelledby="connected-calendars-title">
        <div class="section-head">
          <h3 id="connected-calendars-title">Connected calendars</h3>
          <span>{connectedRows.length}</span>
        </div>
        {#if membershipsError}
          <p class="section-error">{membershipsError}</p>
        {/if}
        <div class="sync-list">
          {#each connectedRows as row (row.key)}
            <div class="sync-source">
              <span class="icon-wrap">{@render iconCalendar()}</span>
              <div class="ss-copy">
                <strong>{row.email}</strong>
                <span class="sub">{row.calendar} -> {row.routingTarget}</span>
              </div>
              <span class="status-pill">{row.status}</span>
            </div>
          {:else}
            {#if accounts.length === 0}
              <div class="section-empty no-accounts">
                <div class="na-title">No calendars connected yet</div>
                <p class="na-copy">Connect a Google Calendar in HQ Console to start capturing meetings here.</p>
                <button type="button" class="btn" onclick={() => void openExternal('https://hq.computer/integrations')}>Open HQ Console Integrations</button>
              </div>
            {:else}
              <div class="section-empty">No connected calendars in the cached snapshot.</div>
            {/if}
          {/each}
        </div>
      </section>

      <section class="secondary-section" aria-labelledby="recently-synced-title">
        <div class="section-head">
          <h3 id="recently-synced-title">Recently synced</h3>
          <span>{recentlySynced.length}</span>
        </div>
        <div class="recent-list">
          {#if recentlySynced.length > 0}
            {#each recentlySynced as event (event.id)}
              {@const labels = extractedSignalLabels(event)}
              <div class="recent-row">
                <div class="what">{event.summary ?? '(no title)'}</div>
                <div class="who">{labels.join(' / ')}</div>
              </div>
            {/each}
          {:else}
            <div class="section-empty">Extracted meeting signals will appear after sync.</div>
          {/if}
        </div>
      </section>
    </div>
  </div>
</div>

<style>
  .meetings {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
    font-family: var(--font-sans);
    background: transparent;
  }
  .meetings.hidden-by-gate { display: none; }
  .meetings-feature-hidden {
    padding: 12px 0;
    border-bottom: 1px solid var(--v4-rowline);
    color: var(--v4-text-3);
    font-size: var(--type-body, var(--text-base));
    line-height: 18px;
  }

  /* Compact toolbar — no oversized title block. */
  .page-header,
  .meetings-toolbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 0;
  }
  .ph-titles {
    min-width: 0;
    display: grid;
    grid-template-rows: auto auto;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--v4-row-stack-gap, 3px);
  }
  .ph-titles h1 {
    margin: 0;
    color: var(--v4-text-1);
    font-family: var(--font-display, var(--font-sans));
    font-size: var(--type-detail, 18px);
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .subtitle {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    line-height: 1.4;
  }
  .page-error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
    color: var(--v4-text-2);
    font-size: var(--type-secondary, 11px);
    line-height: 16px;
  }
  .error-pill {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-pill);
    color: var(--v4-warn);
    font-size: var(--type-metadata, 10px);
    font-weight: 600;
    white-space: nowrap;
  }
  .error-copy {
    min-width: 0;
    color: var(--v4-text-2);
  }
  .report-link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-secondary, 11px);
    line-height: 16px;
    text-decoration: underline;
    cursor: pointer;
  }
  .report-link:hover:not(:disabled) { color: var(--v4-text-2); }
  .report-link:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }
  .report-link:disabled { opacity: 0.55; cursor: default; }

  .actions,
  .detail-primary-actions {
    display: flex;
    flex: 0 0 auto;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
  }

  .toast {
    margin: 10px 0 0;
    padding: 7px 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-field);
    background: var(--v4-raised);
    color: var(--v4-ok);
    font-size: var(--type-body, 12px);
    line-height: 18px;
  }
  .toast-warn { color: var(--v4-warn); }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    padding: 5px 10px;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font: inherit;
    font-size: var(--type-body, 12px);
    white-space: nowrap;
    cursor: pointer;
    transition: background 140ms cubic-bezier(.2,.7,.2,1), border-color 140ms cubic-bezier(.2,.7,.2,1);
  }
  .btn:hover:not(:disabled) { border-color: transparent; background: var(--v4-primary-bg); }
  .btn:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn.subtle {
    border-color: var(--v4-control-border);
    background: var(--v4-secondary-bg);
    color: var(--v4-secondary-fg);
  }
  .btn.subtle:hover:not(:disabled) {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }
  .btn .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
  }

  .content {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4, 16px);
    margin-top: var(--v4-space-4, 16px);
    background: transparent;
  }

  .url-invite-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 0 10px;
    border-bottom: 1px solid var(--v4-rowline);
    background: transparent;
  }
  .url-input {
    flex: 1 1 auto; min-width: 0;
    padding: 6px 10px; border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-field); background: var(--v4-inset);
    color: var(--v4-text-1); font: inherit; font-size: var(--text-base); line-height: 18px;
  }
  .url-input::placeholder { color: var(--v4-text-3); }
  .url-input:focus { outline: none; border-color: var(--v4-text-3); }
  .url-input:disabled { opacity: 0.55; cursor: default; }
  .url-invite-company {
    flex: 0 0 auto; max-width: 160px;
    padding: 6px 8px; border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-field); background: var(--v4-inset);
    color: var(--v4-text-1); font: inherit; font-size: var(--text-base); line-height: 18px;
    cursor: pointer;
  }
  .url-invite-company:disabled { opacity: 0.55; cursor: default; }
  .url-invite-btn { flex: 0 0 auto; }

  /* Up next — discrete strip (not a raised card grid cell). */
  .next-strip {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 8px 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-field);
    background: var(--v4-raised);
  }
  .next-time {
    min-width: 58px;
    padding-right: 10px;
    border-right: 1px solid var(--v4-rowline);
    color: var(--v4-text-1);
    font-family: var(--font-mono);
    font-size: var(--type-metadata, 10px);
    white-space: nowrap;
  }
  .next-copy {
    min-width: 0;
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
  }
  .next-title {
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, 12px);
    font-weight: 600;
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .next-meta {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    line-height: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .next-join { flex: 0 0 auto; }

  /* Bot / calendar health — discrete status payload strip. */
  .health-strip {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px 16px;
    padding: 8px 0;
    border-top: 1px solid var(--v4-rowline);
    border-bottom: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
  }
  .health-item {
    min-width: 0;
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
  }
  .health-label {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .health-value {
    color: var(--v4-text-2);
    font-size: var(--type-secondary, 11px);
    line-height: 15px;
  }
  .health-value.health-error,
  .health-error-text {
    color: var(--v4-error);
  }
  .health-sub {
    display: block;
    margin-top: 1px;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
  }

  /* Secondary sections — naked, hairline only (no rounded outer cards). */
  .secondary-grid {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 20px;
    align-items: start;
  }
  .secondary-section {
    min-width: 0;
    border-radius: 0;
    background: transparent;
  }
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 0 0 8px;
    border-bottom: 1px solid var(--v4-rowline);
  }
  .section-head h3 {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    font-weight: 600;
    letter-spacing: 0.06em;
    line-height: 14px;
    text-transform: uppercase;
  }
  .section-head > span {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    line-height: 14px;
  }
  .section-error {
    margin: 8px 0 0;
    color: var(--v4-error);
    font-size: var(--type-secondary, 11px);
    line-height: 16px;
  }
  .section-empty {
    padding: 12px 0;
    color: var(--v4-text-3);
    font-size: var(--type-body, 12px);
    line-height: 18px;
  }
  .no-accounts {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .na-title {
    color: var(--v4-text-1);
    font-size: var(--type-body, 12px);
    font-weight: 600;
    line-height: 18px;
  }
  .na-copy {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    line-height: 16px;
  }

  .sync-list { display: flex; flex-direction: column; }
  .sync-source {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--v4-rowline);
    border-radius: 0;
    transition: background 140ms cubic-bezier(.2,.7,.2,1);
  }
  .sync-source:last-child { border-bottom: none; }
  .sync-source:hover { background: var(--v4-active-row); }
  .icon-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-button);
    color: var(--v4-text-3);
  }
  .ss-copy { min-width: 0; display: grid; gap: var(--v4-row-stack-gap, 3px); }
  .ss-copy strong {
    display: block;
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, 12px);
    font-weight: 600;
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ss-copy .sub {
    display: block;
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    line-height: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status-pill {
    max-width: 110px;
    overflow: hidden;
    padding: 2px 8px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-2);
    font-size: var(--type-metadata, 10px);
    font-weight: 600;
    line-height: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent-list { display: flex; flex-direction: column; }
  .recent-row {
    padding: 10px 0;
    border-bottom: 1px solid var(--v4-rowline);
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
  }
  .recent-row:last-child { border-bottom: none; }
  .what {
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, 12px);
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .who {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    line-height: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 820px) {
    .health-strip { grid-template-columns: minmax(0, 1fr); }
    .secondary-grid { grid-template-columns: minmax(0, 1fr); }
    .page-header,
    .meetings-toolbar {
      flex-wrap: wrap;
    }
    .actions,
    .detail-primary-actions {
      flex: 0 0 auto;
    }
  }

  @media (max-width: 520px) {
    .next-strip {
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }
    .next-time {
      min-width: 0;
      padding: 0;
      border-right: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .btn,
    .sync-source { transition: none; }
  }

  @media (prefers-reduced-transparency: reduce) {
    .next-strip {
      background: var(--v4-raised);
    }
  }
</style>
