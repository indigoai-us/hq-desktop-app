<script lang="ts">
  import { onMount } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";
  import {
    activeMeetings,
    recordingMemberships,
    setRecordingCompany,
    startRecording,
    stopRecording,
  } from "./active-meetings";
  import {
    configureMeetingsApi,
    meetingsStore,
    setMeetingsViewActive,
    startMeetingsStore,
    type MeetingBotAction,
    type ToastDescriptor,
  } from "./meetings-store.svelte";
  import type { MeetingsStorage } from "./meetings-cache";
  import LiveNowCard from "../common/LiveNowCard.svelte";
  import MeetingsAgenda from "./MeetingsAgenda.svelte";
  import {
    buildConnectedCalendarRows,
    activeRecordingsFromScheduledBots,
    companyLabel,
    durationLabel,
    eventEnd,
    eventStart,
    eventMeetingUrl,
    extractedSignalLabels,
    isPlausibleMeetingUrl,
    botForEvent,
    meetingMatchesFocusId,
    pickLiveMeeting,
    pickUpNext,
    timeLabel,
    totalSignalCounts,
    type MeetingEvent,
  } from "./meetings-model";
  import {
    MEETINGS_CONNECT_EMPTY_BODY,
    MEETINGS_CONNECT_EMPTY_TITLE,
    MEETINGS_LOADING_LABEL,
    MEETINGS_PAGE_DEK,
    MEETINGS_PAST_EMPTY,
    MEETINGS_UPCOMING_EMPTY,
    formatMeetingsFooterLabel,
    groupMeetingsForAgenda,
    partitionUpcomingPast,
    type MeetingsAgendaTab,
  } from "./meetings-view-model";
  import { HQ_CONSOLE_INTEGRATIONS_URL } from "../common/hq-console";
  import PageHeader from "../shell/PageHeader.svelte";
  import "../chat/tokens.css";
  import "../chat/chat-tokens.css";

  interface MeetingsPageProps {
    /** Platform backend seam (meetings/feedback/identity slices are used). */
    adapter: PlatformAdapter;
    accountId?: string | null;
    onback?: () => void;
    /**
     * Open a URL in the host's external browser. Defaults to window.open —
     * desktop hosts pass their shell opener (former the desktop shell plugin
     * `open`).
     */
    openExternal?: (url: string) => Promise<void> | void;
    /**
     * Deep-link focus target (former `meetings:focus-meeting` Tauri event +
     * `meetings_take_pending_focus` invoke — the host resolves both and passes
     * the meeting id + sequence here; every sequence is a consumable focus
     * event, including repeated requests for the same meeting.
     */
    focusRequest?: { meetingId: string; sequence: number } | null;
    /** Account-partitioned cache supplied by the embedded desktop host. */
    storage?: MeetingsStorage | null;
    /** Native auth generation that owns any in-flight meeting hydration. */
    sessionGeneration?: number;
  }
  let {
    adapter,
    accountId = null,
    onback,
    openExternal = (url: string) => {
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) {
        throw new Error(
          "Popup blocked — allow popups for this site and try again.",
        );
      }
    },
    focusRequest = null,
    storage = typeof window !== "undefined" ? window.localStorage : null,
    sessionGeneration = 0,
  }: MeetingsPageProps = $props();

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
  // Per-row operation map, owned by the store. Sibling actions disable while
  // a request runs, but only the invoked control announces and paints busy.
  const pendingActionsByEventId = $derived<Map<string, MeetingBotAction>>(
    meetingsStore.pendingActionsByEventId,
  );

  /** Deep-link focus from open_meetings_window / notification (US-004 routing). */
  let focusedMeetingId = $state<string | null>(null);
  let focusClearTimer: ReturnType<typeof setTimeout> | null = null;

  function focusMeetingRow(meetingId: string) {
    const id = meetingId.trim();
    if (!id) return;
    focusedMeetingId = id;
    if (focusClearTimer) clearTimeout(focusClearTimer);
    focusClearTimer = setTimeout(() => {
      if (focusedMeetingId === id) focusedMeetingId = null;
      focusClearTimer = null;
    }, 1800);
  }

  // Recordings inferred from the calendar snapshot's scheduled bots. Derived
  // (not manually assigned) so it recomputes whenever the cache-first paint or
  // the live network refresh swaps `events`/`botsByEventId`.
  const cachedActiveRecordings = $derived(
    activeRecordingsFromScheduledBots(events, botsByEventId),
  );

  const liveMeeting = $derived(
    pickLiveMeeting([...cachedActiveRecordings, ...$activeMeetings]),
  );
  // The calendar event id behind the live detection, so the agenda can mark
  // exactly that row "Live" (recall bots carry the originating event id).
  const liveEventId = $derived(liveMeeting?.sourceEventId ?? null);
  // US-017: Upcoming | Past partition over the already-fetched snapshot.
  // Upcoming = end >= now (existing pickUpNext behavior); Past = end < now,
  // newest first. No new backend command.
  let agendaTab = $state<MeetingsAgendaTab>("upcoming");
  let lastSyncedAt = $state<Date | null>(null);
  let wasLoading = $state(false);

  const partitioned = $derived(partitionUpcomingPast(events));
  const upcomingEvents = $derived(partitioned.upcoming);
  const pastEvents = $derived(partitioned.past);
  const agendaEvents = $derived(
    agendaTab === "past" ? pastEvents : upcomingEvents,
  );
  const dayGroups = $derived(groupMeetingsForAgenda(agendaEvents));
  const upNext = $derived(pickUpNext(upcomingEvents));
  const signalTotals = $derived(totalSignalCounts(upcomingEvents));
  const agendaEmptyMessage = $derived(
    agendaTab === "past" ? MEETINGS_PAST_EMPTY : MEETINGS_UPCOMING_EMPTY,
  );
  const agendaTitle = $derived(agendaTab === "past" ? "Past" : "Upcoming");

  // US-010: first paint. Skeleton until we have either a cache snapshot or a
  // settled first refresh; then, if there is genuinely nothing AND no calendar
  // account is linked (and the emptiness is not a fetch failure), lead with
  // the connect-a-calendar state instead of "no meetings".
  const initialLoadPending = $derived(meetingsStore.initialLoadPending);
  const showConnectEmpty = $derived(
    !initialLoadPending &&
      meetingsStore.hasLiveSnapshot &&
      !fetchError &&
      accounts.length === 0 &&
      events.length === 0,
  );

  // Stamp last-synced when a store refresh completes (loading true → false).
  $effect(() => {
    if (loading) {
      wasLoading = true;
      return;
    }
    if (wasLoading || lastSyncedAt === null) {
      lastSyncedAt = new Date();
      wasLoading = false;
    }
  });

  const connectedRows = $derived(
    buildConnectedCalendarRows(
      accounts,
      calendarsByAccount,
      enabledCalIdsByAccount,
      events,
      memberships,
    ),
  );
  const footerLabel = $derived(
    formatMeetingsFooterLabel({
      calendarCount: connectedRows.length,
      lastSyncedAt,
    }),
  );
  const recentlySynced = $derived(
    events
      .filter((event) => extractedSignalLabels(event).length > 0)
      .sort(
        (a, b) =>
          (eventEnd(b)?.getTime() ?? eventStart(b)?.getTime() ?? 0) -
          (eventEnd(a)?.getTime() ?? eventStart(a)?.getTime() ?? 0),
      )
      .slice(0, 3),
  );

  // Upcoming meetings carrying >=1 extracted signal — powers "from N meetings" caption.
  const signalMeetingCount = $derived(
    upcomingEvents.filter((event) => extractedSignalLabels(event).length > 0)
      .length,
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
      const status = (bot.status ?? "").toLowerCase();
      if (bot.errorMessage) {
        errored += 1;
        continue;
      }
      if (
        status === "recording" ||
        status === "in_call" ||
        status === "in-call"
      ) {
        inCall += 1;
      } else if (status === "joining") {
        joining += 1;
      } else if (status === "processing") {
        processing += 1;
      } else if (status === "completed") {
        done += 1;
      } else if (status === "scheduled") {
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
    if (botHealth.total === 0) return "No bots scheduled";
    const parts: string[] = [];
    if (botHealth.inCall > 0) parts.push(`${botHealth.inCall} in call`);
    if (botHealth.joining > 0) parts.push(`${botHealth.joining} joining`);
    if (botHealth.scheduled > 0) parts.push(`${botHealth.scheduled} ready`);
    if (botHealth.processing > 0)
      parts.push(`${botHealth.processing} processing`);
    if (botHealth.done > 0) parts.push(`${botHealth.done} done`);
    if (botHealth.errored > 0)
      parts.push(`${botHealth.errored} need attention`);
    return parts.length > 0 ? parts.join(" · ") : `${botHealth.total} bots`;
  });

  const toolbarMeta = $derived.by(() => {
    const days = dayGroups.length;
    const dayPart = `${days} day${days === 1 ? "" : "s"}`;
    const meetingPart = `${upcomingEvents.length} upcoming`;
    return `${meetingPart} · ${dayPart} · all companies`;
  });

  // Transient action feedback. The store owns the invoke + decides the copy
  // (returns a ToastDescriptor next to the call that produced it); this page
  // only renders it. `null` = nothing to surface (no-op dedupe / missing bot).
  let toast = $state<ToastDescriptor | null>(null);
  let calendarOpening = $state(false);
  let upNextJoining = $state(false);
  let connectStarting = $state(false);
  const connectPending = $derived(meetingsStore.connectPending);
  function flashToast(kind: "info" | "warn", text: string): void {
    toast = { kind, text };
    setTimeout(() => {
      if (toast && toast.text === text) toast = null;
    }, 4000);
  }

  // Async connect-watch completion (new account appeared, or bounded timeout).
  $effect(() => {
    const notice = meetingsStore.connectNotice;
    if (!notice) return;
    flashToast(notice.kind, notice.text);
    meetingsStore.clearConnectNotice();
  });

  // Thin wrappers: delegate the invoke to the store, surface its toast (if any).
  // The agenda calls these via callback props so it stays 'invoke'-free.
  //
  // US-005: invite HTTP 409 is recovered inside the store (already-invited row
  // state + background refresh). The returned toast is always kind:'info' for
  // that path — never a warn — so this page must not promote it to the
  // refresh-error banner (fetchError is store-owned and left untouched).
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
  let urlInput = $state("");
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
        if (t.kind === "info") {
          urlInput = "";
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

  async function openCalendar(): Promise<void> {
    if (calendarOpening) return;
    calendarOpening = true;
    try {
      await openExternal("https://calendar.google.com");
    } catch (err) {
      flashToast("warn", `Couldn't open Calendar: ${String(err)}`);
    } finally {
      calendarOpening = false;
    }
  }

  async function joinUpNext(): Promise<void> {
    if (!upNext || upNextJoining) return;
    const url = eventMeetingUrl(upNext);
    if (!url) return;
    upNextJoining = true;
    try {
      await openExternal(url);
    } catch (err) {
      flashToast("warn", `Couldn't open the meeting: ${String(err)}`);
    } finally {
      upNextJoining = false;
    }
  }

  /** Primary path: POST /v1/google/connect → open Google consent URL. */
  async function connectCalendar(): Promise<void> {
    if (connectStarting || connectPending) return;
    connectStarting = true;
    try {
      const result = await meetingsStore.beginCalendarConnect();
      if (result.toast) flashToast(result.toast.kind, result.toast.text);
      if (result.url) {
        try {
          await openExternal(result.url);
        } catch (err) {
          meetingsStore.stopCalendarConnectWatch();
          flashToast("warn", `Couldn't open the browser: ${String(err)}`);
        }
      }
    } finally {
      connectStarting = false;
    }
  }

  /** Per-account revoke: confirm, then store.disconnectCalendar(accountId). */
  async function disconnectCalendar(accountId: string): Promise<void> {
    if (!accountId) return;
    if (meetingsStore.disconnectPendingByAccountId.has(accountId)) return;
    const confirmed = window.confirm(
      "Disconnect this Google calendar from HQ? You can reconnect later.",
    );
    if (!confirmed) return;
    const result = await meetingsStore.disconnectCalendar(accountId);
    if (result) flashToast(result.kind, result.text);
  }

  /** Secondary: manage connected accounts in HQ Console. */
  async function openIntegrationsConsole(): Promise<void> {
    try {
      await openExternal(HQ_CONSOLE_INTEGRATIONS_URL);
    } catch (err) {
      flashToast("warn", `Couldn't open HQ Console: ${String(err)}`);
    }
  }

  onMount(() => {
    // Cache-first singleton. Do not force another refresh on every icon
    // click — that re-downloaded the full calendar and beachballed the app.
    configureMeetingsApi({
      accountId,
      meetings: adapter.meetings,
      feedback: adapter.feedback,
      settings: adapter.settings,
      storage,
      sessionGeneration,
    });
    startMeetingsStore();
    setMeetingsViewActive(true);

    return () => {
      setMeetingsViewActive(false);
      if (focusClearTimer) clearTimeout(focusClearTimer);
    };
  });

  // Host-driven deep-link focus (replaces the Tauri meetings:focus-meeting
  // listener + meetings_take_pending_focus cold-mount stash). Unattributed
  // recordings live on the Past tab — switch to it so the selected row exists.
  $effect(() => {
    if (!focusRequest) return;
    const id = focusRequest.meetingId;
    const matches = (event: MeetingEvent) =>
      meetingMatchesFocusId(
        id,
        event,
        botForEvent(event, botsByEventId, scheduledBots) ??
          botsByEventId.get(event.id),
      );
    if (pastEvents.some(matches) && !upcomingEvents.some(matches) && agendaTab !== "past") {
      agendaTab = "past";
    }
    focusMeetingRow(id);
  });
</script>

<!-- DESKTOP meetings native: compact toolbar, Live now → Up next → bot health → agenda. -->
<div class="meetings" aria-label="Meetings" data-testid="desktop-alt-meetings">
  {#snippet iconCalendar()}
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  {/snippet}
  {#snippet iconSync()}
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 0 0-15-6.7L3 8" />
      <path d="M3 12a9 9 0 0 0 15 6.7L21 16" />
      <path d="M3 3v5h5" />
      <path d="M21 21v-5h-5" />
    </svg>
  {/snippet}

  <PageHeader
    title="Meetings"
    onback={onback}
    backTestId="meetings-back"
    variant="embedded"
    extraClass="meetings-toolbar chat-shell"
  >
    <div class="subtitle" data-testid="meetings-dek">{MEETINGS_PAGE_DEK}</div>
    <div class="subtitle toolbar-meta">{toolbarMeta}</div>
    {#if fetchError}
      <div
        class="page-error"
        role="status"
        data-testid="meetings-refresh-error"
      >
        <span class="error-pill" title={fetchError}>Refresh issue</span>
        <span class="error-copy">{fetchError}</span>
        {#if refreshBlocked}
          <button
            type="button"
            class="report-link"
            data-testid="meetings-report-problem"
            onclick={onReportProblem}
            disabled={reporting}
            aria-busy={reporting}
            aria-label={reporting
              ? "Reporting refresh problem"
              : "Report refresh problem"}
          >
            {reporting ? "Reporting…" : "Report a problem"}
          </button>
        {/if}
      </div>
    {/if}
    {#snippet trailing()}
    <div class="actions detail-primary-actions">
      <button
        type="button"
        class="btn subtle"
        data-testid="meetings-connect-calendar"
        onclick={connectCalendar}
        disabled={connectStarting || connectPending}
        aria-busy={connectStarting || connectPending}
      >
        <span class="icon">{@render iconCalendar()}</span>
        {connectPending
          ? "Waiting for Google…"
          : connectStarting
            ? "Connecting…"
            : "Connect calendar"}
      </button>
      <button
        type="button"
        class="btn subtle meetings-open-cal"
        onclick={openCalendar}
        disabled={calendarOpening}
        aria-busy={calendarOpening}
      >
        {calendarOpening ? "Opening…" : "Open calendar"}
      </button>
      <button
        type="button"
        class="btn subtle"
        data-testid="meetings-refresh"
        onclick={() => void meetingsStore.refresh()}
        disabled={loading}
        aria-busy={loading}
        aria-label={loading ? "Refreshing meetings" : "Refresh meetings"}
      >
        <span class="icon">{@render iconSync()}</span>
        {loading ? "Refreshing" : "Refresh"}
      </button>
    </div>
    {/snippet}
  </PageHeader>

  {#if toast}
    <div class="toast" class:toast-warn={toast.kind === "warn"} role="status">
      {toast.text}
    </div>
  {/if}

  <div class="content">
    <div class="url-invite-bar">
      <div class="url-field">
        <span class="url-lead" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path
              d="M6.4 9.6a3.2 3.2 0 0 1 0-4.53l1.7-1.7a3.2 3.2 0 1 1 4.53 4.53l-.85.85M9.6 6.4a3.2 3.2 0 0 1 0 4.53l-1.7 1.7a3.2 3.2 0 1 1-4.53-4.53l.85-.85"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
            />
          </svg>
        </span>
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
            if (e.key === "Enter" && isPlausibleMeetingUrl(urlInput.trim())) {
              e.preventDefault();
              void onUrlInvite();
            }
          }}
        />
      </div>
      {#if urlInput.trim().length > 0}
        <!-- Destination picker. Only renders once the user starts typing —
             keeps the idle bar clean. `null` = Personal (the default). -->
        <span class="url-invite-company-wrap">
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
          <span class="url-invite-company-chevron" aria-hidden="true">›</span>
        </span>
      {/if}
      <button
        type="button"
        class="btn subtle url-invite-btn"
        data-testid="meetings-url-invite"
        disabled={urlInviting || !isPlausibleMeetingUrl(urlInput.trim())}
        aria-busy={urlInviting}
        aria-label={urlInviting
          ? "Inviting recording bot"
          : "Invite recording bot"}
        onclick={onUrlInvite}
      >
        {urlInviting ? "Inviting…" : "Invite"}
      </button>
    </div>

    <div
      class="agenda-toggle"
      role="group"
      aria-label="Agenda range"
      data-testid="meetings-agenda-toggle"
    >
      <button
        type="button"
        class="agenda-toggle-btn"
        class:active={agendaTab === "upcoming"}
        aria-pressed={agendaTab === "upcoming"}
        data-testid="meetings-tab-upcoming"
        onclick={() => (agendaTab = "upcoming")}
      >
        Upcoming
      </button>
      <button
        type="button"
        class="agenda-toggle-btn"
        class:active={agendaTab === "past"}
        aria-pressed={agendaTab === "past"}
        data-testid="meetings-tab-past"
        onclick={() => (agendaTab = "past")}
      >
        Past
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
    <section
      class="next-strip"
      aria-label="Up next"
      data-testid="meetings-up-next"
    >
      <div class="next-time">
        {#if upNext}{timeLabel(upNext)}{/if}
      </div>
      <div class="next-copy">
        {#if upNext}
          {@const dur = durationLabel(upNext)}
          <div class="next-title">{upNext.summary ?? "(no title)"}</div>
          <div class="next-meta">
            Next · {companyLabel(upNext, companyNamesByUid)}{#if dur}
              · {dur}{/if}
          </div>
        {:else}
          <div class="next-title">Nothing scheduled next</div>
          <div class="next-meta">Waiting for the next calendar event</div>
        {/if}
      </div>
      {#if upNext && eventMeetingUrl(upNext)}
        <button
          type="button"
          class="btn subtle next-join"
          onclick={joinUpNext}
          disabled={upNextJoining}
          aria-busy={upNextJoining}
        >
          {upNextJoining ? "Joining…" : "Join"}
        </button>
      {/if}
    </section>

    <!-- 3. Meeting-bot health + calendar sync (discrete status, not dashboard cards). -->
    <section
      class="health-strip"
      aria-label="Meeting bot status"
      data-testid="meetings-bot-health"
    >
      <div class="health-item">
        <span class="health-label">Bots</span>
        <span class="health-value" class:health-error={botHealth.errored > 0}
          >{botHealthLabel}</span
        >
      </div>
      <div class="health-item">
        <span class="health-label">Calendars</span>
        <span class="health-value">
          {#if membershipsError}
            <span class="health-error-text">{membershipsError}</span>
          {:else if connectedRows.length === 0}
            {accounts.length === 0 ? "None connected" : "No enabled calendars"}
          {:else}
            {connectedRows.length} connected
          {/if}
        </span>
      </div>
      <div class="health-item">
        <span class="health-label">Signals</span>
        <span class="health-value">
          {signalTotals.actions}a · {signalTotals.decisions}d · {signalTotals.risks}r
          <span class="health-sub"
            >from {signalMeetingCount} meeting{signalMeetingCount === 1
              ? ""
              : "s"}</span
          >
        </span>
      </div>
    </section>

    <!-- 4. Upcoming agenda — naked hairline rows, primary surface. -->
    {#if initialLoadPending}
      <!-- US-010: first snapshot still loading — never paint "no meetings". -->
      <section
        class="section agenda-loading"
        aria-label="Loading meetings"
        aria-busy="true"
        data-testid="meetings-loading"
      >
        <p class="loading-label">{MEETINGS_LOADING_LABEL}</p>
        <div class="skeleton-rows" aria-hidden="true">
          {#each Array.from({ length: 4 }) as _row, i (i)}
            <div class="skeleton-row">
              <span class="skeleton-bar skeleton-time"></span>
              <span class="skeleton-bar skeleton-title"></span>
            </div>
          {/each}
        </div>
      </section>
    {:else if showConnectEmpty}
      <!-- US-010: settled + truly empty + no linked account → connect-first. -->
      <section
        class="section connect-empty"
        aria-label={MEETINGS_CONNECT_EMPTY_TITLE}
        data-testid="meetings-connect-empty"
      >
        <h3 class="ce-title">{MEETINGS_CONNECT_EMPTY_TITLE}</h3>
        <p class="ce-copy">{MEETINGS_CONNECT_EMPTY_BODY}</p>
        <button
          type="button"
          class="btn"
          data-testid="meetings-connect-empty-cta"
          onclick={connectCalendar}
          disabled={connectStarting || connectPending}
          aria-busy={connectStarting || connectPending}
        >
          {connectPending
            ? "Waiting for Google…"
            : connectStarting
              ? "Connecting…"
              : "Connect calendar"}
        </button>
      </section>
    {:else}
      <MeetingsAgenda
        groups={dayGroups}
        {upNext}
        totalCount={agendaEvents.length}
        {agendaTitle}
        emptyMessage={agendaEmptyMessage}
        companyNames={companyNamesByUid}
        {liveEventId}
        {botsByEventId}
        {scheduledBots}
        {pendingActionsByEventId}
        {focusedMeetingId}
        {onInvite}
        {onUninvite}
        {onJoinNow}
        onOpenExternal={openExternal}
      />
    {/if}

    <!-- Secondary: connected calendars + recent signals as hairline sections. -->
    <div class="section secondary-grid">
      <section
        class="secondary-section"
        aria-labelledby="connected-calendars-title"
      >
        <div class="section-head">
          <h3 id="connected-calendars-title">Connected calendars</h3>
          <span>{connectedRows.length}</span>
        </div>
        {#if membershipsError}
          <p class="section-error">{membershipsError}</p>
        {/if}
        <div class="sync-list">
          {#each connectedRows as row (row.key)}
            {@const disconnecting =
              row.accountId !== "" &&
              meetingsStore.disconnectPendingByAccountId.has(row.accountId)}
            <div class="sync-source">
              <span class="icon-wrap">{@render iconCalendar()}</span>
              <div class="ss-copy">
                <strong>{row.email}</strong>
                <span class="sub">{row.calendar} -> {row.routingTarget}</span>
              </div>
              <div class="ss-actions">
                <span class="status-pill">{row.status}</span>
                {#if row.accountId}
                  <button
                    type="button"
                    class="btn subtle disconnect-btn"
                    data-testid="meetings-disconnect-calendar"
                    data-account-id={row.accountId}
                    onclick={() => void disconnectCalendar(row.accountId)}
                    disabled={disconnecting}
                    aria-busy={disconnecting}
                  >
                    {disconnecting ? "Disconnecting…" : "Disconnect"}
                  </button>
                {/if}
              </div>
            </div>
          {:else}
            {#if accounts.length === 0}
              <div class="section-empty no-accounts">
                <div class="na-title">No calendars connected yet</div>
                <p class="na-copy">
                  Connect a Google Calendar to start capturing meetings here.
                </p>
                <button
                  type="button"
                  class="btn"
                  data-testid="meetings-connect-calendar-empty"
                  onclick={connectCalendar}
                  disabled={connectStarting || connectPending}
                  aria-busy={connectStarting || connectPending}
                >
                  {connectPending
                    ? "Waiting for Google…"
                    : connectStarting
                      ? "Connecting…"
                      : "Connect calendar"}
                </button>
              </div>
            {:else}
              <div class="section-empty">
                No connected calendars in the cached snapshot.
              </div>
            {/if}
          {/each}
        </div>
      </section>

      <section
        class="secondary-section"
        aria-labelledby="recently-synced-title"
      >
        <div class="section-head">
          <h3 id="recently-synced-title">Recently synced</h3>
          <span>{recentlySynced.length}</span>
        </div>
        <div class="recent-list">
          {#if recentlySynced.length > 0}
            {#each recentlySynced as event (event.id)}
              {@const labels = extractedSignalLabels(event)}
              <div class="recent-row">
                <div class="what">{event.summary ?? "(no title)"}</div>
                <div class="who">{labels.join(" / ")}</div>
              </div>
            {/each}
          {:else}
            <div class="section-empty">
              Extracted meeting signals will appear after sync.
            </div>
          {/if}
        </div>
      </section>
    </div>

    <footer class="meetings-footer" data-testid="meetings-footer">
      <span class="footer-meta">{footerLabel}</span>
      <button
        type="button"
        class="footer-manage"
        data-testid="meetings-manage"
        onclick={openIntegrationsConsole}
      >
        Manage in console
      </button>
    </footer>
  </div>
</div>

<style>
  .meetings {
    box-sizing: border-box;
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 0;
    overflow: hidden;
    padding: 16px 32px 16px 22px;
    font-family: var(--font-sans);
    background: transparent;
  }
  @media (max-width: 1120px) {
    .meetings {
      padding: 14px 24px 14px 16px;
    }
  }
  /* Compact toolbar — no oversized title block. */
  .meetings-open-cal {
    display: none;
  }
  .subtitle {
    margin: 0;
    color: var(--t3, var(--v4-text-3));
    font-size: 12px;
    font-weight: 400;
    line-height: 1.45;
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
    color: var(--v4-error);
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
  .report-link:hover:not(:disabled) {
    color: var(--v4-text-2);
  }
  .report-link:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }
  .report-link:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .actions,
  .detail-primary-actions {
    display: flex;
    flex: 0 0 auto;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
  }

  .toast {
    --toast-dot: var(--v4-ok);
    display: flex;
    align-items: baseline;
    gap: 7px;
    margin: 10px 0 0;
    padding: 8px 0 0;
    border: 0;
    border-top: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font-size: var(--type-body, 12px);
    line-height: 18px;
  }

  .toast::before {
    width: 5px;
    height: 5px;
    flex: 0 0 auto;
    border-radius: var(--v4-radius-pill);
    background: var(--toast-dot);
    content: "";
    transform: translateY(-1px);
  }

  .toast-warn {
    --toast-dot: var(--v4-warn);
  }

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
    /* Match the app-standard 12px control size — the meetings --type-body
       token is 15px, which made these header buttons visibly oversized. */
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 140ms cubic-bezier(0.2, 0.7, 0.2, 1),
      border-color 140ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }
  .btn:hover:not(:disabled) {
    border-color: transparent;
    background: var(--v4-primary-bg);
  }
  .btn:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
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
    gap: 8px;
    margin-top: 8px;
    min-height: 0;
    flex: 1 1 auto;
    overflow: auto;
    padding-right: 12px;
    background: transparent;
  }

  /* Daybook meetings: no dashboard chrome — live is a row, agenda is the page. */
  .next-strip,
  .health-strip,
  .secondary-grid {
    display: none;
  }

  .url-invite-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
    border-bottom: 1px solid var(--line, var(--v4-rowline));
    background: transparent;
  }
  .url-field {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--btn-bg, var(--v4-inset));
  }
  .url-field:hover {
    border-color: var(--line2, var(--v4-control-border));
  }
  .url-field:focus-within {
    border-color: var(--border-active, var(--v4-text-3));
  }
  .url-lead {
    display: inline-flex;
    color: var(--t3, var(--v4-text-3));
  }
  .url-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--t1, var(--v4-text-1));
    font: inherit;
    font-size: 12px;
    line-height: 18px;
  }
  .url-input::placeholder {
    color: var(--t3, var(--v4-text-3));
  }
  .url-input:focus {
    outline: none;
  }
  .url-input:disabled {
    opacity: 0.55;
    cursor: default;
  }
  /* Styled (non-native-looking) destination dropdown (D-18). */
  .url-invite-company-wrap {
    position: relative;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
  }
  .url-invite-company {
    appearance: none;
    -webkit-appearance: none;
    flex: 0 0 auto;
    max-width: 160px;
    padding: 6px 24px 6px 8px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-field);
    background: var(--v4-inset);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--text-base);
    line-height: 18px;
    cursor: pointer;
  }
  .url-invite-company:focus {
    outline: none;
    border-color: var(--v4-text-3);
  }
  .url-invite-company-chevron {
    position: absolute;
    right: 8px;
    color: var(--v4-text-3);
    font-size: 13px;
    line-height: 1;
    transform: rotate(90deg);
    pointer-events: none;
  }
  .url-invite-company:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .url-invite-btn {
    flex: 0 0 auto;
  }

  /* Up next — discrete strip (not a raised card grid cell). */
  .next-strip {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 8px 0;
    border: 0;
    border-top: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
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
  .next-join {
    flex: 0 0 auto;
  }

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
  /* US-010: first-load skeleton — quiet muted bars, no motion needed. */
  .agenda-loading {
    padding: 12px 0;
  }
  .loading-label {
    margin: 0 0 10px;
    color: var(--v4-text-3);
    font-size: var(--type-body, 12px);
    line-height: 18px;
  }
  .skeleton-rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .skeleton-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .skeleton-bar {
    display: inline-block;
    height: 10px;
    border-radius: 5px;
    background: var(--v4-text-3);
    opacity: 0.18;
  }
  .skeleton-time {
    width: 64px;
  }
  .skeleton-title {
    width: min(46%, 320px);
  }
  /* US-010: connect-first empty state. */
  .connect-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 16px 0;
  }
  .ce-title {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-body, 12px);
    font-weight: 600;
    line-height: 18px;
  }
  .ce-copy {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--type-body, 12px);
    line-height: 18px;
    max-width: 420px;
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

  .sync-list {
    display: flex;
    flex-direction: column;
  }
  .sync-source {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--v4-rowline);
    border-radius: 0;
    transition: background 140ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }
  .ss-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .disconnect-btn {
    padding: 3px 8px;
    font-size: var(--type-metadata, 10px);
  }
  .sync-source:last-child {
    border-bottom: none;
  }
  .sync-source:hover {
    background: var(--v4-active-row);
  }
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
  .ss-copy {
    min-width: 0;
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
  }
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

  .recent-list {
    display: flex;
    flex-direction: column;
  }
  .recent-row {
    padding: 10px 0;
    border-bottom: 1px solid var(--v4-rowline);
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
  }
  .recent-row:last-child {
    border-bottom: none;
  }
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

  .toolbar-meta {
    display: none;
  }

  .agenda-toggle {
    display: inline-flex;
    align-self: flex-start;
    align-items: center;
    width: fit-content;
    gap: 2px;
    padding: 2px;
    border: none;
    border-radius: 8px;
    background: var(--raised, var(--v4-inset));
  }
  .agenda-toggle-btn {
    flex: 0 0 auto;
    min-width: 0;
    padding: 4px 12px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2, var(--v4-text-3));
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 17.4px;
    white-space: nowrap;
    cursor: pointer;
  }
  .agenda-toggle-btn.active {
    background: var(--sel, var(--v4-secondary-bg));
    color: var(--t1, var(--v4-text-1));
  }
  .agenda-toggle-btn:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 1px;
  }

  .meetings-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 4px;
    padding: 10px 0 0;
    border-top: 1px solid var(--v4-rowline);
  }
  .footer-meta {
    min-width: 0;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    font-weight: 500;
    letter-spacing: 0.06em;
    line-height: 14px;
    text-transform: uppercase;
  }
  .footer-manage {
    flex: 0 0 auto;
    margin-left: auto;
    padding: 3px 10px;
    border: 1px solid var(--line2, var(--v4-control-border));
    border-radius: 6px;
    background: transparent;
    color: var(--t2, var(--v4-text-2));
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0;
    line-height: 14px;
    text-transform: none;
    text-decoration: none;
    cursor: pointer;
  }
  .footer-manage:hover:not(:disabled) {
    background: var(--hover, var(--v4-active-row));
    color: var(--t1, var(--v4-text-1));
  }
  .footer-manage:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .footer-manage:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  @media (max-width: 820px) {
    .health-strip {
      grid-template-columns: minmax(0, 1fr);
    }
    .secondary-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    :global(.meetings-toolbar) {
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
    .sync-source {
      transition: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .next-strip {
      background: transparent;
    }
  }

  /* Daybook meetings: hide leftover dashboard chrome. !important wins over
     later display:grid rules on the same selectors. */
  .next-strip,
  .health-strip,
  .secondary-grid,
  .meetings-open-cal,
  .toolbar-meta,
  :global([data-testid="meetings-live-now"]) {
    display: none !important;
  }
</style>
