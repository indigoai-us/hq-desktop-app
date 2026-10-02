<!--
  US-022 meetings states. Loaded only through meetings-states-lazy so the
  recap, transcript, upcoming brief, empty canvas, and new-meeting sheet
  stay out of the initial graph. First frame is the door skeleton.
-->
<script lang="ts">
  import PeoplePicker from "../chat/PeoplePicker.svelte";
  import type { PeoplePickerEntry } from "../chat/people-picker.js";
  import type { MeetingEvent, ScheduledBot } from "./meetings-model";
  import type { MeetingsRailSection } from "./meetings-rail-model";
  import { clockLabel, initialsOf } from "./meetings-rail-model";
  import {
    draftToEvent,
    emptyNewMeetingDraft,
    filterTranscript,
    joinAvailable,
    recapModel,
    recapPlainText,
    relativeUntil,
    transcriptTurns,
    venueLabel,
    whenChip,
    type MeetingDurationMin,
    type MeetingLinkKind,
    type NewMeetingDraft,
  } from "./meeting-states-model";
  import { eventStart } from "./meetings-model";

  interface Props {
    mode: "recap" | "upcoming" | "empty";
    event?: MeetingEvent | null;
    bot?: ScheduledBot;
    companyName?: string | null;
    sections?: readonly MeetingsRailSection[];
    now?: Date;
    sheetOpen?: boolean;
    people?: readonly PeoplePickerEntry[];
    openExternal?: (url: string) => void;
    oncopy?: (text: string) => void;
    onselect?: (id: string) => void;
    oncreate?: (event: MeetingEvent) => void;
    oncloseSheet?: () => void;
    onopenSheet?: () => void;
    /** Sheet only, over the live canvas. */
    sheetOnly?: boolean;
  }

  let {
    mode,
    event = null,
    bot,
    companyName = null,
    sections = [],
    now = new Date(),
    sheetOpen = false,
    people = [],
    openExternal,
    oncopy,
    onselect,
    oncreate,
    oncloseSheet,
    onopenSheet,
    sheetOnly = false,
  }: Props = $props();

  let tab = $state<"recap" | "transcript" | "notes" | "agenda">("recap");
  let query = $state("");
  let jumped = $state<string | null>(null);
  let draft = $state<NewMeetingDraft>(emptyNewMeetingDraft());
  let pickerQuery = $state("");
  let titleError = $state(false);

  const recap = $derived(event ? recapModel(event, bot) : null);
  const turns = $derived(event ? filterTranscript(transcriptTurns(event), query) : []);
  const url = $derived((event?.meetingUrl || event?.hangoutLink || "").trim());
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

  function setDuration(mins: MeetingDurationMin): void {
    draft.durationMin = mins;
  }

  function setLink(kind: MeetingLinkKind): void {
    draft.link = kind;
  }

  function create(): void {
    const built = draftToEvent(draft, `local-${Date.now()}`);
    if (!built) {
      titleError = true;
      return;
    }
    titleError = false;
    oncreate?.(built);
    draft = emptyNewMeetingDraft(now);
  }

  $effect.pre(() => {
    tab = mode === "upcoming" ? "agenda" : "recap";
    query = "";
  });
</script>

<section class="canvas" class:overlay={sheetOnly} data-testid="meetings-states" data-mode={mode} aria-label={event?.summary || "Meetings"}>
  {#if sheetOnly}
    <!-- sheet rendered below -->
  {:else if mode === "empty"}
    <div class="toolbar">
      <h1>Meetings</h1>
      <span class="sub">Nothing live</span>
      <span class="grow"></span>
      <button type="button" class="btn" data-testid="empty-new-meeting" onclick={() => onopenSheet?.()}>New meeting</button>
    </div>
    <div class="empty-body" data-testid="meetings-empty">
      {#if nextRow}
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
          <div class="subline">Create a meeting to put one on today.</div>
          <div class="actions">
            <button type="button" class="btn primary" onclick={() => onopenSheet?.()}>New meeting</button>
          </div>
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
        <div class="kind">Yesterday's recap</div>
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
        <span class="hint">{canJoin ? "Ready to join" : "Join opens 10 min before"}</span>
        <button type="button" class="btn primary" data-testid="meeting-join" disabled={!canJoin} title={canJoin ? "Opens the meeting link in your browser" : "Opens 10 min before the meeting starts"} onclick={() => url && openExternal?.(url)}>Join</button>
        <button type="button" class="btn" data-testid="meeting-copy" disabled={!url} onclick={copyLink}>Copy link</button>
      {:else}
        <button type="button" class="btn" onclick={() => oncopy?.(`sources/meetings/${event.id}.md`)}>Open notes file</button>
        <button type="button" class="btn" data-testid="copy-recap" onclick={copyRecap}>Copy recap</button>
      {/if}
    </div>

    <div class="split">
      <div class="main">
        <div class="tabs" data-testid="meeting-tabs">
          {#if mode === "recap"}
            <button type="button" class="tab" aria-pressed={tab === "recap"} onclick={() => (tab = "recap")}>Recap</button>
            <button type="button" class="tab" aria-pressed={tab === "transcript"} onclick={() => (tab = "transcript")}>Transcript</button>
            <button type="button" class="tab" aria-pressed={tab === "notes"} onclick={() => (tab = "notes")}>Notes</button>
            <span class="meta">{recap?.meta}</span>
          {:else}
            <button type="button" class="tab" aria-pressed={tab === "agenda"} onclick={() => (tab = "agenda")}>Agenda</button>
            <button type="button" class="tab" aria-pressed={tab === "notes"} onclick={() => (tab = "notes")}>Notes</button>
            <button type="button" class="tab" aria-pressed={tab === "transcript"} onclick={() => (tab = "transcript")}>Transcript</button>
            <span class="meta">{eventStart(event) ? `Starts ${relativeUntil(eventStart(event)!, now)}` : "Upcoming"}</span>
          {/if}
        </div>

        {#if tab === "recap" && recap}
          <div data-testid="meeting-recap">
            <h2 class="sh">Summary</h2>
            <p class="sum">{recap.summary}</p>
            <h2 class="sh">Decisions <span class="n">{recap.decisions.length}</span></h2>
            {#each recap.decisions as item (item.id)}
              <div class="it" data-testid="recap-decision"><span class="mk hi"></span><span>{item.title}</span><span class="own"><span class="mini">{item.ownerInitials}</span>{item.owner}</span><span class="ts">{item.when}</span></div>
            {:else}<p class="muted">No decisions recorded.</p>{/each}
            <h2 class="sh">Action items <span class="n">{recap.actions.length}</span></h2>
            {#each recap.actions as item (item.id)}
              <div class="it" data-testid="recap-action"><span class="mk"></span><span>{item.title}{#if item.detail}<span class="q">{item.detail}</span>{/if}</span><span class="own"><span class="mini" class:sq={item.bot}>{item.bot ? "⌁" : item.ownerInitials}</span>{item.owner}</span><span class="chip">{item.status}</span></div>
            {:else}<p class="muted">No action items.</p>{/each}
            <h2 class="sh">Open questions <span class="n">{recap.questions.length}</span></h2>
            {#each recap.questions as item (item.id)}
              <div class="it"><span class="mk"></span><span>{item.title}</span><span class="own">{item.owner}</span><span class="chip">{item.status}</span></div>
            {:else}<p class="muted">No open questions.</p>{/each}
          </div>
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
          <h2 class="sh">Agenda <span class="n">{event.outline?.length ?? 0}</span></h2>
          <ol class="ag" data-testid="meeting-agenda">
            {#each event.outline ?? [] as item, i (item.id ?? i)}
              <li><span class="n">{i + 1}</span><span>{item.title}{#if item.detail}<span class="q">{item.detail}</span>{/if}</span></li>
            {:else}<li class="muted">No agenda yet.</li>{/each}
          </ol>
        {:else}
          <div data-testid="meeting-notes-tab">
            {#each event.notes ?? [] as note, i (note.id ?? i)}
              <p class="sum"><b>{note.author || "Note"}</b> {note.text}</p>
            {:else}<p class="muted">Notes render here. The file stays in the company vault.</p>{/each}
          </div>
        {/if}
      </div>
      <aside class="side" data-testid="meeting-side">
        <h2 class="sh">Attendees</h2>
        {#each event.attendees ?? [] as person (person.email || person.displayName)}
          <div class="att"><span class="mini">{initialsOf(person.displayName || person.email || "?")}</span>{person.displayName || person.email}<span class="meta">{person.responseStatus || ""}</span></div>
        {:else}<p class="muted">No attendees on the calendar event.</p>{/each}
        {#if mode === "upcoming"}
          <h2 class="sh">Live signals</h2>
          <p class="muted">Nothing yet. Action items, decisions, and questions appear here once the meeting is live.</p>
        {:else if recap}
          <h2 class="sh">Details</h2>
          <p class="muted">{recap.decisions.length} decisions · {recap.actions.length} actions · {recap.questions.length} questions</p>
        {/if}
      </aside>
    </div>
  {/if}

  {#if sheetOpen}
    <div class="scrim" data-testid="new-meeting-scrim" onclick={() => oncloseSheet?.()} role="presentation"></div>
    <div class="sheet" role="dialog" aria-label="New meeting" data-testid="new-meeting-sheet">
      <div class="sh-row">New meeting<span class="grow"></span><button type="button" class="icon-btn" aria-label="Close" onclick={() => oncloseSheet?.()}>✕</button></div>
      <div class="sb">
        <label class="fr"><span class="lb">Title</span>
          <input class="field" bind:value={draft.title} aria-invalid={titleError} placeholder="Meeting title" />
        </label>
        <div class="fr"><span class="lb">When</span>
          <div class="inl">
            <input class="field" type="date" bind:value={draft.date} aria-label="Date" />
            <input class="field time" type="time" bind:value={draft.time} aria-label="Time" />
            <div class="tabs" data-testid="duration-tabs">
              {#each [30, 45, 60] as mins (mins)}
                <button type="button" class="tab" aria-pressed={draft.durationMin === mins} onclick={() => setDuration(mins as MeetingDurationMin)}>{mins}</button>
              {/each}
            </div>
          </div>
        </div>
        <div class="fr"><span class="lb">Attendees</span>
          <PeoplePicker entries={people} selected={draft.attendeeIds} bind:query={pickerQuery} onToggle={(entry) => {
            draft.attendeeIds = draft.attendeeIds.includes(entry.id)
              ? draft.attendeeIds.filter((id) => id !== entry.id)
              : [...draft.attendeeIds, entry.id];
          }} />
          <label class="inl tog-row">
            <input type="checkbox" role="switch" bind:checked={draft.notetaker} /> Notetaker bot
          </label>
        </div>
        <div class="fr"><span class="lb">Link</span>
          <div class="tabs" data-testid="link-tabs">
            {#each ["zoom", "meet", "none"] as kind (kind)}
              <button type="button" class="tab" aria-pressed={draft.link === kind} onclick={() => setLink(kind as MeetingLinkKind)}>{kind === "zoom" ? "Zoom" : kind === "meet" ? "Meet" : "None"}</button>
            {/each}
          </div>
          <p class="muted">A {draft.link === "none" ? "link is not created" : `${draft.link} link is created when calendar save is connected`}.</p>
        </div>
        <label class="fr"><span class="lb">Agenda</span>
          <textarea class="field area" bind:value={draft.agenda} aria-label="Agenda" placeholder="1. …"></textarea>
        </label>
      </div>
      <div class="sf">
        <span class="hint">Saved on this Mac until calendar write ships.</span>
        <button type="button" class="btn" onclick={() => oncloseSheet?.()}>Cancel</button>
        <button type="button" class="btn primary" data-testid="create-meeting" onclick={create}>Create meeting</button>
      </div>
    </div>
  {/if}
</section>

<style>
  .canvas { position: relative; display: flex; flex-direction: column; min-height: 0; height: 100%; color: var(--t1); background: var(--v4-ground, var(--side-bg)); }
  .canvas.overlay { position: absolute; inset: 0; height: auto; background: transparent; pointer-events: none; z-index: 3; }
  .canvas.overlay .scrim, .canvas.overlay .sheet { pointer-events: auto; }
  .toolbar, .sh-row, .sf, .inl, .actions, .att, .who { display: flex; align-items: center; gap: 8px; }
  .toolbar { height: 44px; padding: 0 16px; border-bottom: 1px solid var(--line); }
  .toolbar h1 { margin: 0; font-size: 14px; font-weight: 600; }
  .grow { flex: 1; }
  .sub, .hint, .meta, .muted, .subline, .mm, .q, .ts { color: var(--t3); font-size: 12px; }
  .crumb { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .chip { height: 20px; padding: 0 7px; border-radius: 999px; background: var(--v4-control-bg, transparent); border: 1px solid var(--line); font-size: 12px; color: var(--t2); }
  .btn { height: 26px; padding: 0 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--t1); font: inherit; font-size: 12px; cursor: pointer; }
  .btn.primary { border-color: transparent; background: var(--v4-primary-bg, var(--t1)); color: var(--v4-primary-fg, var(--side-bg)); }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .icon-btn { width: 26px; height: 26px; border: 0; background: transparent; color: var(--t2); cursor: pointer; }
  .empty-body { padding: 28px 24px; overflow: auto; }
  .kind { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--t3); margin: 0 0 6px; }
  .next h2 { margin: 0; font-size: 20px; font-weight: 600; }
  .rule { height: 1px; background: var(--line); margin: 16px 0; }
  .later, .recap-row { display: flex; gap: 10px; align-items: center; width: 100%; max-width: 576px; padding: 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
  .later:hover, .recap-row:hover, .tab[aria-pressed="true"], .tab[aria-pressed="true"] { background: var(--sel, var(--hover)); }
  .tm { font-family: var(--font-mono); width: 40px; color: var(--t3); }
  .tt { display: block; }
  .mm { display: block; }
  .r { margin-left: auto; text-decoration: underline; text-underline-offset: 3px; color: var(--t2); font-size: 12px; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) 300px; min-height: 0; flex: 1; }
  .main, .side { min-height: 0; overflow: auto; padding: 0 24px 24px; contain: layout paint; }
  .side { border-left: 1px solid var(--line); background: var(--v4-secondary-sidebar, transparent); padding: 16px 20px; }
  .tabs { display: flex; gap: 2px; align-items: center; padding: 10px 0; position: sticky; top: 0; background: var(--v4-ground, var(--side-bg)); }
  .tab { height: 22px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: var(--t2); font: inherit; font-size: 12px; cursor: pointer; }
  .meta { margin-left: auto; }
  .sh { display: flex; gap: 8px; margin: 18px 0 6px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--t2); }
  .n { color: var(--t3); font-weight: 400; }
  .sum { max-width: 66ch; line-height: 1.55; }
  .it { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
  .mk { width: 6px; height: 6px; border-radius: 50%; background: var(--t3); }
  .mk.hi { background: var(--t1); }
  .mini { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: var(--v4-control-bg, var(--hover)); font-size: 8px; }
  .mini.sq { border-radius: 4px; }
  .own { display: flex; align-items: center; gap: 6px; color: var(--t2); font-size: 12px; white-space: nowrap; }
  .q { display: block; }
  .search, .field { width: 100%; height: 28px; margin: 0 0 10px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--t1); font: inherit; font-size: 13px; }
  .tx { display: grid; grid-template-columns: 14px 64px 92px minmax(0, 1fr); gap: 8px; padding: 5px 0; }
  .tx p { margin: 0; color: var(--t2); line-height: 1.5; }
  .tm { font-family: var(--font-mono); color: var(--t3); font-size: 12px; }
  .jm { border: 0; background: transparent; color: var(--t3); cursor: pointer; }
  .ag { margin: 0; padding: 0; list-style: none; }
  .ag li { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); }
  .scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.45); }
  .sheet { position: absolute; left: 50%; top: 48px; transform: translateX(-50%); width: 480px; max-height: calc(100% - 72px); display: flex; flex-direction: column; background: var(--v4-popover, var(--side-bg)); border: 1px solid var(--line); border-radius: 8px; z-index: 2; }
  .sh-row, .sf { padding: 12px 16px; border-bottom: 1px solid var(--line); font-weight: 600; }
  .sf { border-bottom: 0; border-top: 1px solid var(--line); font-weight: 400; }
  .sb { overflow: auto; min-height: 0; }
  .fr { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
  .lb { color: var(--t3); font-size: 12px; padding-top: 6px; }
  .field.time { width: 108px; }
  .field.area { height: auto; min-height: 60px; padding: 6px 8px; }
  .tog-row { margin-top: 8px; font-size: 13px; }
  .att .meta { margin-left: auto; }
</style>
