<!--
  US-022 meetings states. Loaded only through meetings-states-lazy so the
  recap, transcript, upcoming brief, and empty canvas
  stay out of the initial graph. First frame is the door loader.
-->
<script lang="ts">
  import type { MeetingEvent, ScheduledBot } from "./meetings-model";
  import type { MeetingsRailSection } from "./meetings-rail-model";
  import { clockLabel, initialsOf, recapHeading } from "./meetings-rail-model";
  import {
    filterTranscript,
    joinAvailable,
    pastNotesState,
    recapModel,
    recapPlainText,
    relativeUntil,
    transcriptTurns,
    venueLabel,
    whenChip,
  } from "./meeting-states-model";
  import { eventStart } from "./meetings-model";
  import { renderInline, renderMarkdown } from "../common/markdown.js";
  import { markdownLinks } from "../common/markdown-links.js";
  import { decisionParts, normalizeRecapMarkdown } from "./recap-markdown";
  import { agendaItems, attendeeViews, locationLabel, meetingJoinUrl, organizerLabel } from "./meeting-details";
  import MeetingsToolbarControls from "./MeetingsToolbarControls.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import NotetakerControl from "./NotetakerControl.svelte";
  import LiveTranscriptDoor from "./LiveTranscriptDoor.svelte";
  import { meetingsStore } from "./meetings-store.svelte";
  import { meetingsRailState } from "./meetings-rail-state.svelte";
  import { PROVIDER_LABEL, detectMeetingProvider } from "./meeting-link";
  import { connectGoogleCalendar, joinPastedLink } from "./meeting-calendar-actions";

  interface Props {
    mode: "recap" | "upcoming" | "empty";
    event?: MeetingEvent | null;
    bot?: ScheduledBot;
    companyName?: string | null;
    sections?: readonly MeetingsRailSection[];
    now?: Date;
    openExternal?: (url: string) => void;
    oncopy?: (text: string) => void;
    onselect?: (id: string) => void;
    /** A recorded past meeting's saved notes are still loading. */
    notesLoading?: boolean;
    /** Saved notes past the first page, not read yet. */
    notesRemaining?: number;
    notesLoadingMore?: boolean;
    onloadmore?: () => void;
    /** The saved-notes read failed; show Try again, never "No notes". */
    notesFailed?: boolean;
    /** Some saved notes (summary, decisions) failed to read; the transcript still shows. */
    recapFailed?: boolean;
    onretrynotes?: () => void;
  }

  let {
    mode,
    event = null,
    bot,
    companyName = null,
    sections = [],
    now = new Date(),
    openExternal,
    oncopy,
    onselect,
    notesLoading = false,
    notesRemaining = 0,
    notesLoadingMore = false,
    onloadmore,
    notesFailed = false,
    recapFailed = false,
    onretrynotes,
  }: Props = $props();

  let tab = $state<"recap" | "transcript" | "notes" | "agenda" | "live">("recap");
  const agenda = $derived(event ? agendaItems(event) : []);
  const attendees = $derived(event ? attendeeViews(event) : []);
  const organizer = $derived(event ? organizerLabel(event) : "");
  const place = $derived(event ? locationLabel(event) : "");
  // A cached event from before the host passed details through has no
  // attendees field; hold a loader while the first refresh is in flight.
  // Recorded meetings never get attendees from a calendar refresh: they wait
  // only for their own notes load, then show names or "Attendees unavailable".
  const detailsPending = $derived(
    !!event &&
      event.attendees === undefined &&
      (event.recorded
        ? notesLoading
        : meetingsStore.loading && meetingsStore.lastSyncedAt === 0),
  );
  let query = $state("");
  let jumped = $state<string | null>(null);

  const recap = $derived(event ? recapModel(event, bot) : null);
  // Past meetings show tabs only when real notes exist on the server.
  const notesState = $derived(
    mode === "recap" && event ? pastNotesState(event, now, { bot, detailLoading: notesLoading, detailFailed: notesFailed }) : null,
  );
  const hasNotes = $derived(notesState === null || notesState === "ready");
  const turns = $derived(event ? filterTranscript(transcriptTurns(event), query) : []);
  const url = $derived(
    ((event ? meetingJoinUrl(event) : "") || (event ? meetingsRailState.attachedLinks.get(event.id) : "") || "").trim(),
  );
  // US-042: a read that succeeded, no error, and no linked account → connect-first canvas.
  // AUDIT-3-16: a failed calendar read is not "no calendar"; it gets the
  // failed-read line and Try again instead.
  const calendarFailed = $derived(
    !meetingsStore.initialLoadPending && meetingsStore.calendarReadFailed && meetingsStore.accounts.length === 0,
  );
  const noCalendar = $derived(
    !meetingsStore.initialLoadPending &&
      meetingsStore.hasLiveSnapshot &&
      !meetingsStore.calendarReadFailed &&
      !meetingsStore.fetchError &&
      meetingsStore.accounts.length === 0,
  );
  let firstRunLink = $state("");
  let firstRunJoining = $state(false);
  const firstRunProvider = $derived(detectMeetingProvider(firstRunLink.trim()));

  async function joinFirstRun(): Promise<void> {
    if (!firstRunProvider || firstRunJoining) return;
    firstRunJoining = true;
    try {
      await joinPastedLink(firstRunLink.trim(), openExternal);
      firstRunLink = "";
    } finally {
      firstRunJoining = false;
    }
  }

  const canJoin = $derived(event ? joinAvailable(event, now) : false);
  const today = $derived(sections.find((s) => s.id === "today")?.rows ?? []);
  const past = $derived(sections.find((s) => s.id === "past")?.rows ?? []);
  const nextRow = $derived(today[0] ?? sections.find((s) => s.id === "tomorrow")?.rows[0] ?? null);
  const later = $derived(today.slice(nextRow && today[0]?.id === nextRow.id ? 1 : 0));
  const yesterday = $derived(past.find((row) => row.hasRecap) ?? past[0] ?? null);

  function copyLink(): void {
    if (url) oncopy?.(url);
  }

  function copyRecap(): void {
    if (!event || !recap) return;
    oncopy?.(recapPlainText(recap, event.summary?.trim() || "Meeting"));
  }

  $effect.pre(() => {
    tab = mode === "upcoming" ? "agenda" : "recap";
    query = "";
  });
</script>

<section class="canvas" data-testid="meetings-states" data-mode={mode} aria-label={event?.summary || "Meetings"}>
  {#if mode === "empty"}
    <div class="toolbar">
      <h1>Meetings</h1>
      {#if !calendarFailed}<span class="sub">Nothing live</span>{/if}
      <span class="grow"></span>
      <MeetingsToolbarControls {openExternal} />
    </div>
    <div class="empty-body" data-testid="meetings-empty">
      {#if calendarFailed}
        <div class="next" role="alert" data-testid="meetings-calendar-failed">
          <h2>Couldn't read your calendar.</h2>
          <div class="actions">
            <button type="button" class="btn" data-testid="meetings-calendar-retry" disabled={meetingsStore.loading} aria-busy={meetingsStore.loading} onclick={() => void meetingsStore.refresh()}>Try again</button>
          </div>
        </div>
      {:else if noCalendar}
        <div class="next first-run" data-testid="meetings-no-calendar">
          <div class="kind">Get started</div>
          <h2>Connect your calendar to see meetings here</h2>
          <div class="subline">HQ reads your events and their video links so it can brief you before a call, send a notetaker, and file the recap. HQ never writes to your calendar.</div>
          <div class="actions">
            <button type="button" class="btn primary" data-testid="no-calendar-connect-google" disabled={meetingsStore.connectPending} aria-busy={meetingsStore.connectPending} onclick={() => void connectGoogleCalendar(openExternal)}>{meetingsStore.connectPending ? "Finish in your browser…" : "Connect Google"}</button>
            <button type="button" class="btn" data-testid="no-calendar-connect-microsoft" disabled title="Microsoft calendar connect is not available yet">Connect Microsoft</button>
          </div>
          <div class="rule"></div>
          <div class="kind">Or paste a meeting link</div>
          <div class="actions">
            <input class="field inline" data-testid="no-calendar-paste-input" placeholder="zoom.us, meet.google.com, or teams.microsoft.com link" aria-label="Meeting link" bind:value={firstRunLink} onkeydown={(e) => e.key === "Enter" && void joinFirstRun()} />
            {#if firstRunProvider}<span class="chip" data-testid="no-calendar-paste-provider">{PROVIDER_LABEL[firstRunProvider]}</span>{/if}
            <button type="button" class="btn" data-testid="no-calendar-paste-join" disabled={!firstRunProvider || firstRunJoining} aria-busy={firstRunJoining} onclick={() => void joinFirstRun()}>Join</button>
          </div>
          <div class="subline">Joining from a link sends the notetaker. The meeting appears under Today until it ends.</div>
        </div>
      {:else if nextRow}
        <div class="next">
          <div class="kind">Next</div>
          <h2>{nextRow.title} at {nextRow.time}</h2>
          <div class="subline">Join opens 10 min before{#if companyName} · {companyName}{/if}</div>
          <div class="actions">
            <button type="button" class="btn primary" data-testid="prepare-brief" onclick={() => onselect?.(nextRow.id)}>Prepare brief</button>
            <button type="button" class="btn" disabled title="Copy is on the meeting once it has a link">Copy link</button>
          </div>
        </div>
      {:else}
        <div class="next">
          <div class="kind">Next</div>
          <h2>Nothing scheduled</h2>
          <div class="subline">Meetings on your calendar show here.</div>
        </div>
      {/if}
      {#if later.length}
        <div class="rule"></div>
        <div class="next">
          <div class="kind">Later today</div>
          {#each later as row (row.id)}
            <button type="button" class="later" onclick={() => onselect?.(row.id)}>
              <span class="tm">{row.time}</span><span>{row.title}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if yesterday}
        <div class="rule"></div>
        <div class="kind" data-testid="empty-recap-heading">{recapHeading(yesterday.startMs, now)}</div>
        <button type="button" class="recap-row" data-testid="empty-recap" onclick={() => onselect?.(yesterday.id)}>
          <span class="mini sq">⌁</span>
          <span>
            <span class="tt">{yesterday.title} · {yesterday.time}</span>
            <span class="mm">{yesterday.hasRecap ? "Recap saved" : "Past meeting"}</span>
          </span>
          <span class="r">Open recap</span>
        </button>
      {/if}
    </div>
  {:else if event}
    <div class="toolbar">
      <div class="crumb">
        <b>{event.summary?.trim() || "Untitled meeting"}</b>
        <span class="chip">{whenChip(event)}</span>
        <span class="chip">{venueLabel(event)}{mode === "recap" && bot?.sourceLanded ? " · recorded" : ""}</span>
      </div>
      <span class="grow"></span>
      {#if mode === "upcoming"}
        <NotetakerControl {event} {bot} {url} />
        <span class="hint">{canJoin ? "Ready to join" : "Join opens 10 min before"}</span>
        <button type="button" class="btn primary" data-testid="meeting-join" disabled={!canJoin} title={canJoin ? "Opens the meeting link in your browser" : "Opens 10 min before the meeting starts"} onclick={() => url && openExternal?.(url)}>Join</button>
        <button type="button" class="btn" data-testid="meeting-copy" disabled={!url} onclick={copyLink}>Copy link</button>
      {:else if hasNotes}
        <button type="button" class="btn" onclick={() => oncopy?.(`sources/meetings/${event.id}.md`)}>Open notes file</button>
        <button type="button" class="btn" data-testid="copy-recap" onclick={copyRecap}>Copy recap</button>
      {:else if url}
        <button type="button" class="btn" data-testid="meeting-copy" onclick={copyLink}>Copy link</button>
      {/if}
    </div>

    <div class="split">
      <div class="main">
        {#if !hasNotes}
          <div class="no-notes" data-testid="meeting-no-notes" data-state={notesState}>
            {#if notesState === "loading"}
              <div aria-busy="true" aria-label="Loading notes"><ReadLoader testid="meeting-notes-loading" surface="meetings" onretry={onretrynotes ? () => onretrynotes() : null} /></div>
            {:else if notesState === "failed"}
              <div role="alert" data-testid="meeting-notes-failed">
                <p class="sum">Couldn't load the notes.</p>
                <div class="actions">
                  <button type="button" class="btn" data-testid="meeting-notes-retry" onclick={() => onretrynotes?.()}>Try again</button>
                </div>
              </div>
            {:else if notesState === "preparing"}
              <p class="sum">Notes are being prepared.</p>
              <p class="muted">They usually appear within 15 minutes after the meeting ends.</p>
            {:else}
              <p class="muted">No notes for this meeting</p>
            {/if}
            <p class="muted" data-testid="meeting-when">{whenChip(event)}</p>
            {#if url}<p class="muted" data-testid="meeting-link">{url}</p>{/if}
          </div>
        {:else}
        <div class="tabs" data-testid="meeting-tabs">
          {#if mode === "recap"}
            <button type="button" class="tab" aria-pressed={tab === "recap"} onclick={() => (tab = "recap")}>Recap</button>
            <button type="button" class="tab" aria-pressed={tab === "transcript"} onclick={() => (tab = "transcript")}>Transcript</button>
            <button type="button" class="tab" aria-pressed={tab === "notes"} onclick={() => (tab = "notes")}>Notes</button>
            {#if bot}<button type="button" class="tab" aria-pressed={tab === "live"} onclick={() => (tab = "live")}>Live</button>{/if}
            <span class="meta">{recap?.meta}</span>
          {:else}
            <button type="button" class="tab" aria-pressed={tab === "agenda"} onclick={() => (tab = "agenda")}>Agenda</button>
            <button type="button" class="tab" aria-pressed={tab === "notes"} onclick={() => (tab = "notes")}>Notes</button>
            <button type="button" class="tab" aria-pressed={tab === "transcript"} onclick={() => (tab = "transcript")}>Transcript</button>
            {#if bot}<button type="button" class="tab" aria-pressed={tab === "live"} onclick={() => (tab = "live")}>Live</button>{/if}
            <span class="meta">{eventStart(event) ? `Starts ${relativeUntil(eventStart(event)!, now)}` : "Upcoming"}</span>
          {/if}
        </div>

        {#if tab === "recap" && recap}
          <div data-testid="meeting-recap">
            {#if recapFailed}
              <div role="alert" data-testid="meeting-recap-failed">
                <p class="sum">Couldn't load part of the recap.</p>
                <div class="actions">
                  <button type="button" class="btn" data-testid="meeting-recap-retry" onclick={() => onretrynotes?.()}>Try again</button>
                </div>
              </div>
            {/if}
            {#if recap.summary}
              <h2 class="sh">Summary</h2>
              <!-- OWNER-R25: the shared renderer (escaped, no remote images); links open through the host opener. -->
              <div class="sum md" data-testid="recap-summary" use:markdownLinks={{ currentPath: "" }}>{@html renderMarkdown(normalizeRecapMarkdown(recap.summary, event.summary ?? ""))}</div>
            {/if}
            {#if recap.decisions.length}
              <h2 class="sh">Decisions <span class="n">{recap.decisions.length}</span></h2>
              {#each recap.decisions as item (item.id)}
                {@const d = decisionParts(item.title)}
                <div class="it top" data-testid="recap-decision">
                  <span class="mk hi"></span>
                  <div class="dec md" use:markdownLinks={{ currentPath: "" }}>
                    <span class="dec-title" data-testid="decision-title">{@html renderInline(d.title)}</span>
                    {#if d.decidedBy}<span class="dec-line" data-testid="decision-by"><span class="lbl">Decided by</span> {@html renderInline(d.decidedBy)}</span>{/if}
                    {#if d.reasoning}<span class="dec-line" data-testid="decision-reasoning"><span class="lbl">Reasoning</span> {@html renderInline(d.reasoning)}</span>{/if}
                  </div>
                  {#if item.owner}<span class="own"><span class="mini">{item.ownerInitials}</span>{item.owner}</span>{:else}<span></span>{/if}
                  {#if item.when}<span class="ts">{item.when}</span>{:else}<span></span>{/if}
                </div>
              {/each}
            {/if}
            {#if recap.actions.length}
              <h2 class="sh">Action items <span class="n">{recap.actions.length}</span></h2>
              {#each recap.actions as item (item.id)}
                <div class="it" data-testid="recap-action"><span class="mk"></span><span class="md" use:markdownLinks={{ currentPath: "" }}>{@html renderInline(item.title)}{#if item.detail}<span class="q">{item.detail}</span>{/if}</span>{#if item.owner || item.bot}<span class="own"><span class="mini" class:sq={item.bot}>{item.bot ? "⌁" : item.ownerInitials}</span>{item.owner}</span>{:else}<span></span>{/if}<span class="chip">{item.status}</span></div>
              {/each}
            {/if}
            {#if recap.questions.length}
              <h2 class="sh">Open questions <span class="n">{recap.questions.length}</span></h2>
              {#each recap.questions as item (item.id)}
                <div class="it" data-testid="recap-question"><span class="mk"></span><span class="md" use:markdownLinks={{ currentPath: "" }}>{@html renderInline(item.title)}</span><span class="own">{item.owner}</span><span class="chip">{item.status}</span></div>
              {/each}
            {/if}
            {#if !recapFailed && notesRemaining === 0 && !recap.summary && !recap.decisions.length && !recap.actions.length && !recap.questions.length}
              <p class="muted" data-testid="meeting-recap-none">There is no recap for this meeting yet.</p>
            {/if}
            {#if notesRemaining > 0}
              <div class="more" data-testid="recap-more">
                <span class="muted" data-testid="recap-more-count">{notesRemaining} more {notesRemaining === 1 ? "note" : "notes"}</span>
                <button type="button" class="btn" data-testid="recap-load-more" disabled={notesLoadingMore} aria-busy={notesLoadingMore} onclick={() => onloadmore?.()}>{notesLoadingMore ? "Loading…" : "Load more"}</button>
              </div>
            {/if}
          </div>
        {:else if tab === "live" && bot}
          {#if bot.sourceLanded}
            <p class="muted" data-testid="live-transcript-final">The saved transcript is ready in the Transcript tab.</p>
          {:else}
            <LiveTranscriptDoor
              recallBotId={bot.botId}
              companyId={bot.companyId ?? event.sourceCompanyUid ?? null}
              live={bot.status !== "completed" || !bot.sourceLanded}
              botStatus={bot.status}
            />
          {/if}
        {:else if tab === "transcript"}
          <div data-testid="meeting-transcript">
            <input class="search" placeholder="Search transcript" aria-label="Search transcript" bind:value={query} />
            {#each turns as turn (turn.id)}
              <div class="tx" data-signal={turn.signal ?? undefined}>
                {#if turn.signal}
                  <button type="button" class="jm" title={turn.signal} onclick={() => (jumped = turn.signal)}>●</button>
                {:else}<span></span>{/if}
                <span class="tm">{turn.at}</span>
                <span class="who"><span class="mini" class:sq={turn.bot}>{turn.bot ? "⌁" : turn.initials}</span>{turn.speaker}</span>
                <p>{turn.text}</p>
              </div>
            {:else}
              <p class="muted">{query ? "No lines match." : "The transcript opens here once the notetaker saves it. Nothing leaves the app."}</p>
            {/each}
            {#if jumped}<p class="muted">Jumped to {jumped}</p>{/if}
          </div>
        {:else if tab === "agenda"}
          <h2 class="sh">Agenda <span class="n">{agenda.length}</span></h2>
          {#if detailsPending}
            <div aria-busy="true"><ReadLoader testid="meeting-agenda-loading" surface="meetings" /></div>
          {:else}
            <ol class="ag" data-testid="meeting-agenda">
              {#each agenda as item, i (item.id ?? i)}
                <li><span class="n">{i + 1}</span><span>{item.title}{#if item.detail}<span class="q">{item.detail}</span>{/if}</span></li>
              {:else}<li class="muted ag-empty">No agenda yet.</li>{/each}
            </ol>
          {/if}
        {:else}
          <div data-testid="meeting-notes-tab">
            {#each event.notes ?? [] as note, i (note.id ?? i)}
              <div class="sum md" data-testid="meeting-note" use:markdownLinks={{ currentPath: "" }}><b>{note.author || "Note"}</b>{@html renderMarkdown(normalizeRecapMarkdown(note.text ?? "", event.summary ?? ""))}</div>
            {:else}<p class="muted">Notes render here. The file stays in the company vault.</p>{/each}
          </div>
        {/if}
        {/if}
      </div>
      <aside class="side" data-testid="meeting-side">
        <h2 class="sh">Attendees{#if attendees.length}<span class="n">{attendees.length}</span>{/if}</h2>
        {#if detailsPending}
          <div aria-busy="true"><ReadLoader testid="meeting-attendees-loading" surface="meetings" /></div>
        {:else}
          {#each attendees as person (person.key)}
            <div class="att" data-testid="meeting-attendee" title={person.email || undefined}><span class="mini">{initialsOf(person.name || "?")}</span><span class="an">{person.name}{#if person.organizer}<span class="q">Organizer</span>{/if}</span><span class="meta">{person.response}</span></div>
          {:else}<p class="muted" data-testid="meeting-attendees-unavailable">{event.recorded || event.attendees === undefined ? "Attendees unavailable" : "No attendees on the calendar event."}</p>{/each}
        {/if}
        {#if organizer || place}
          <h2 class="sh">Details</h2>
          {#if organizer}<p class="muted" data-testid="meeting-organizer">Organized by {organizer}</p>{/if}
          {#if place}<p class="muted" data-testid="meeting-location">{place}</p>{/if}
        {/if}
        {#if mode === "upcoming"}
          <h2 class="sh">Live signals</h2>
          <p class="muted">Nothing yet. Action items, decisions, and questions appear here once the meeting is live.</p>
        {:else if recap && hasNotes}
          <h2 class="sh">Details</h2>
          <p class="muted">{recap.decisions.length} decisions · {recap.actions.length} actions · {recap.questions.length} questions</p>
        {/if}
      </aside>
    </div>
  {/if}

</section>

<style>
  .canvas { position: relative; display: flex; flex-direction: column; min-height: 0; height: 100%; color: var(--t1); font: 400 13px/1.45 var(--font-ui, var(--font-sans)); background: var(--v4-ground, var(--side-bg)); }
  .toolbar, .actions, .att, .who { display: flex; align-items: center; gap: 8px; }
  .toolbar { height: 44px; padding: 0 16px; border-bottom: 1px solid var(--line); }
  .toolbar h1, .crumb b { margin: 0; font-size: var(--type-title, 20px); font-weight: 500; line-height: 1.25; }
  .crumb b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grow { flex: 1; }
  .sub, .hint, .meta, .muted, .subline, .mm, .q, .ts { color: var(--t3); font-size: 13px; }
  .crumb { display: flex; align-items: center; gap: 8px; min-width: 0; }
  /* Meta and status read as plain 13px text, like Messages; no bordered pills. */
  .chip { font-size: 13px; color: var(--t2); white-space: nowrap; }
  .crumb .chip + .chip::before { content: "· "; color: var(--t3); }
  .btn { height: 28px; padding: 0 10px; border: 1px solid var(--panel-border, var(--line)); border-radius: 6px; background: transparent; color: var(--t1); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn.primary { border-color: transparent; background: var(--v4-primary-bg, var(--t1)); color: var(--v4-primary-fg, var(--side-bg)); }
  .btn:disabled { color: var(--t3); cursor: default; }
  .btn.primary:disabled { background: var(--btn-bg, var(--hover)); color: var(--t3); }
  .empty-body { padding: 28px 24px; overflow: auto; }
  .kind { font-size: 13px; font-weight: 500; color: var(--t2); margin: 0 0 4px; }
  /* One 20px title per page (the toolbar); the hero line is 13px like a Messages row title. */
  .next h2 { margin: 0; font-size: 13px; font-weight: 500; line-height: 17px; }
  .rule { height: 1px; background: var(--line); margin: 16px 0; }
  .later, .recap-row { display: flex; gap: 8px; align-items: center; width: 100%; max-width: 576px; min-height: 28px; padding: 4px 8px; margin: 0 -8px; border: 0; border-radius: 6px; font: inherit; line-height: 17px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
  .later:hover, .recap-row:hover, .tab:hover { background: var(--hover); }
  .tab[aria-pressed="true"] { background: var(--sel, var(--hover)); color: var(--t1); }
  .tm { width: 40px; flex: none; color: var(--t3); font-variant-numeric: tabular-nums; }
  .tt { display: block; }
  .mm { display: block; }
  .r { margin-left: auto; color: var(--t2); font-size: 13px; }
  /* The agenda column keeps 240 px; narrower windows scroll instead of
     wrapping the agenda one word per line. */
  .split { display: grid; grid-template-columns: minmax(240px, 1fr) 300px; min-height: 0; flex: 1; }
  .main, .side { min-height: 0; overflow: auto; padding: 0 24px 24px; contain: layout paint; }
  .side { border-left: 1px solid var(--line); background: var(--v4-secondary-sidebar, transparent); padding: 16px 20px; }
  .tabs { display: flex; gap: 2px; align-items: center; padding: 10px 0; position: sticky; top: 0; background: var(--v4-ground, var(--side-bg)); }
  .tab { height: 24px; padding: 0 8px; border: 0; border-radius: 4px; background: transparent; color: var(--t2); font: inherit; font-size: 13px; cursor: pointer; }
  .meta { margin-left: auto; }
  .sh { display: flex; gap: 8px; margin: 16px 0 4px; font-size: 13px; font-weight: 500; line-height: 17px; color: var(--t2); }
  .n { color: var(--t3); font-weight: 400; }
  .more { display: flex; align-items: center; gap: 8px; margin: 12px 0 4px; }
  .sum { max-width: 66ch; line-height: 1.55; }
  .sum b { font-weight: 500; }
  .md :global(p) { margin: 0 0 8px; }
  .md :global(ul), .md :global(ol) { margin: 0 0 8px; padding-left: 20px; }
  .md :global(li) { margin: 2px 0; }
  .md :global(strong) { font-weight: 500; }
  .md :global(a) { color: inherit; text-decoration: underline; }
  .it.top { align-items: start; }
  .dec { display: grid; gap: 2px; min-width: 0; }
  .dec-line { color: var(--t2); }
  .dec-line .lbl { color: var(--t3); }
  .it { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 8px; align-items: center; min-height: 28px; padding: 4px 0; font-size: 13px; line-height: 17px; }
  .mk { width: 6px; height: 6px; border-radius: 50%; background: var(--t3); }
  .mk.hi { background: var(--t1); }
  .mini { display: inline-grid; place-items: center; width: 20px; height: 20px; flex: none; border-radius: 50%; background: var(--v4-control-bg, var(--hover)); color: var(--t2); font-size: 13px; letter-spacing: -0.02em; }
  .mini.sq { border-radius: 4px; }
  .own { display: flex; align-items: center; gap: 6px; color: var(--t2); font-size: 13px; white-space: nowrap; }
  .q { display: block; }
  .search, .field { width: 100%; height: 28px; margin: 0 0 10px; padding: 0 8px; border: 1px solid var(--line2, var(--line)); border-radius: 6px; background: transparent; color: var(--t1); font: inherit; font-size: 13px; }
  .tx { display: grid; grid-template-columns: 14px 64px 92px minmax(0, 1fr); gap: 8px; padding: 5px 0; }
  .tx p { margin: 0; color: var(--t2); line-height: 1.5; }
  .tx .tm { width: auto; font-size: 13px; }
  .jm { border: 0; background: transparent; color: var(--t3); cursor: pointer; }
  .ag { margin: 0; padding: 0; list-style: none; }
  .ag li { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; min-height: 28px; padding: 4px 0; line-height: 17px; }
  /* The empty row has one child; in the numbered grid it landed in the 22 px
     number column and wrapped per word. */
  .ag li.ag-empty { display: block; }
  .an { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .an .q { display: inline; margin-left: 6px; }
  .no-notes {
    padding-top: 8px;
  }

  .att .meta { margin-left: auto; }
  .field.inline { margin: 0; flex: 1; max-width: 360px; }
  .next .actions { margin-top: 12px; }
  .first-run { max-width: 560px; }
  .first-run .subline { margin-top: 6px; line-height: 1.45; }
</style>
