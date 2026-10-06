<!--
  Live meeting canvas (console-rail US-021, design.md Meetings revision 6).

  Toolbar (title, live chip, venue, Join, Copy link, More), a room strip with
  attendee avatars, live dots and the speaker ringed, then three columns:
  Outline (240 px), Notes (primary), Signals (300 px). Signal items are one
  line and expand on hover or focus into a card with owner, time, the source
  quote, and Confirm / Edit / Dismiss / Answer / Park.

  Everything renders from the event passed in, which comes from the
  meetings-store snapshot (cache first), so the canvas paints in the frame the
  row is clicked.
-->
<script lang="ts">
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import {
    elapsedLabel,
    clockLabel,
    isLiveMeeting,
    noteLines,
    outlineItems,
    roomStrip,
    SIGNAL_ACTION_LABEL,
    signalGroups,
    signalTotal,
    type SignalAction,
    type SignalItem,
  } from "./meetings-rail-model";
  import {
    durationMinutes,
    eventMeetingUrl,
    eventStart,
    platformLabel,
    type MeetingEvent,
    type ScheduledBot,
  } from "./meetings-model";
  import LiveTranscriptDoor from "./LiveTranscriptDoor.svelte";

  interface Props {
    event: MeetingEvent;
    bot?: ScheduledBot;
    companyName?: string | null;
    now?: Date;
    openExternal?: (url: string) => void;
    oncopy?: (url: string) => void;
    onmore?: () => void;
    onsignal?: (action: SignalAction, item: SignalItem, text?: string) => void;
  }

  let {
    event,
    bot,
    companyName = null,
    now = new Date(),
    openExternal,
    oncopy,
    onmore,
    onsignal,
  }: Props = $props();

  let tab = $state<"notes" | "transcript" | "live">("notes");
  // Local item state per meeting: dismissed / parked hide, confirmed marks.
  let hidden = $state(new Set<string>());
  let confirmed = $state(new Set<string>());
  let editing = $state<{ id: string; mode: "edit" | "answer"; text: string } | null>(null);
  let resetFor = "";

  $effect.pre(() => {
    if (event.id === resetFor) return;
    resetFor = event.id;
    hidden = new Set();
    confirmed = new Set();
    editing = null;
  });

  const live = $derived(isLiveMeeting(event, now, bot));
  const start = $derived(eventStart(event));
  const url = $derived(eventMeetingUrl(event));
  const venue = $derived(url ? platformLabel(event) : null);
  const room = $derived(roomStrip(event));
  const outline = $derived(outlineItems(event));
  const notes = $derived(noteLines(event));
  const groups = $derived(signalGroups(event, hidden));
  const total = $derived(signalTotal(groups));
  const minutes = $derived(durationMinutes(event));
  const whenLabel = $derived(
    start
      ? `${start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${clockLabel(start)}${minutes ? ` · ${minutes} min` : ""}`
      : "Time pending",
  );
  const botName = $derived(room.people.find((p) => p.kind === "bot")?.name ?? null);

  function act(action: SignalAction, item: SignalItem): void {
    if (action === "edit" || action === "answer") {
      editing = { id: item.id, mode: action, text: action === "edit" ? item.title : "" };
      return;
    }
    if (action === "dismiss" || action === "park") hidden = new Set([...hidden, item.id]);
    if (action === "confirm") confirmed = new Set([...confirmed, item.id]);
    onsignal?.(action, item);
  }

  function saveEdit(item: SignalItem): void {
    if (!editing) return;
    const text = editing.text.trim();
    const mode = editing.mode;
    editing = null;
    if (text) onsignal?.(mode, item, text);
  }
</script>

<section class="canvas" aria-label={event.summary || "Meeting"} data-testid="meeting-canvas" data-live={live ? "true" : "false"}>
  <div class="toolbar">
    <div class="crumb">
      <b class="name">{event.summary?.trim() || "Untitled meeting"}</b>
      {#if live}
        <span class="chip live" data-testid="meeting-live-chip"><i class="ldot"></i>Live · {elapsedLabel(start, now)}</span>
      {/if}
      {#if venue}<span class="chip">{venue}</span>{/if}
      {#if companyName}<span class="chip"><CompanyLabel name={companyName} /></span>{/if}
    </div>
    <button type="button" class="btn primary" disabled={!url} title="Opens the meeting link in your browser" onclick={() => url && openExternal?.(url)}>Join</button>
    <button type="button" class="btn" disabled={!url} title="Copies the link" onclick={() => url && oncopy?.(url)}>Copy link</button>
    <button type="button" class="icon-btn" aria-label="More" title="Agenda and notetaker" onclick={() => onmore?.()}>⋯</button>
  </div>

  <div class="room" data-testid="meeting-room-strip">
    <div class="faces">
      {#each room.people as p (p.id)}
        <span
          class="mini"
          class:sq={p.kind === "bot"}
          class:speaking={p.speaking}
          class:invited={p.invited}
          title={p.name}
          data-testid="room-person"
          data-speaking={p.speaking ? "true" : undefined}
        >
          {p.kind === "bot" ? "⌁" : p.initials}
          {#if p.live}<span class="ld" aria-label="in the room"></span>{/if}
        </span>
      {/each}
    </div>
    <div class="who">{room.summary || (live ? "Waiting for people to join" : "No one in the room yet")}</div>
    {#if botName}<span class="chip"><span class="mini sq tiny">⌁</span>{botName} · {live ? "transcribing" : "notetaker"}</span>{/if}
    <span class="chip">{whenLabel}</span>
  </div>

  <div class="grid">
    <div class="col outline-col" data-testid="meeting-outline">
      <div class="colhead"><h2>Outline</h2></div>
      {#if outline.length}
        <ol class="ol">
          {#each outline as item, i (item.id)}
            <li class={item.state}>
              <span class="n">{i + 1}</span>
              <span class="txt">{item.title}{#if item.state === "now" && item.detail}<span class="sub">{item.detail}</span>{/if}</span>
              {#if item.state === "now" && item.children.length}
                <ul>
                  {#each item.children as c (c.id)}
                    <li class:done={c.done}><span class="n">·</span><span class="txt">{c.title}</span></li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ol>
      {:else}
        <p class="empty">No outline yet. The notetaker drafts one from the agenda.</p>
      {/if}
    </div>

    <div class="col notes-col" data-testid="meeting-notes">
      <div class="colhead">
        <h2>Notes</h2>
        {#if live}<span class="chip live"><i class="ldot"></i>live</span>{/if}
        <span class="grow"></span>
        <button type="button" class="tab" aria-pressed={tab === "notes"} onclick={() => (tab = "notes")}>Notes</button>
        <button type="button" class="tab" aria-pressed={tab === "transcript"} onclick={() => (tab = "transcript")}>Transcript</button>
        {#if bot}
          <button type="button" class="tab" aria-pressed={tab === "live"} onclick={() => (tab = "live")}>Live</button>
        {/if}
      </div>
      {#if tab === "live" && bot}
        {#if bot.sourceLanded}
          <p class="empty" data-testid="live-transcript-final">The saved transcript is ready in the Transcript tab.</p>
        {:else}
          <LiveTranscriptDoor
            recallBotId={bot.botId}
            companyId={bot.companyId ?? event.sourceCompanyUid ?? null}
            meetingTitle={event.summary ?? null}
            startTime={event.start.dateTime ?? event.start.date ?? null}
            {live}
            botStatus={bot.status}
          />
        {/if}
      {:else if tab === "transcript"}
        <p class="empty" data-testid="meeting-saved-transcript">
          {bot?.sourceLanded
            ? "The saved transcript is ready in the company vault."
            : "The saved transcript appears here after the notetaker finishes."}
        </p>
      {:else if notes.length}
        <div class="notes">
          {#each notes as n (n.id)}
            <div class="note" class:typing={n.typing}>
              <span class="mini" class:sq={n.kind === "bot"}>{n.kind === "bot" ? "⌁" : n.initials}</span>
              <div>
                <div class="hd"><b>{n.author}</b><span>{n.at}</span></div>
                <p>{n.text}{#if n.typing}<span class="cursor"></span>{/if}</p>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <p class="empty">{live ? "Notes from the notetaker will appear here as people talk." : "No notes for this meeting yet."}</p>
      {/if}
    </div>

    <div class="col signals-col" data-testid="meeting-signals">
      <div class="colhead">
        <h2>Signals</h2>
        {#if live}<span class="chip live"><i class="ldot"></i>tracking</span>{/if}
        <span class="grow"></span>
        <span class="count">{total}</span>
      </div>
      <div class="sig">
        {#each groups as g (g.kind)}
          <div class="sig-g" data-kind={g.kind}>
            <h3>{g.label} <span class="count">{g.items.length}</span></h3>
            {#if g.items.length === 0}
              <div class="sig-foot">none yet</div>
            {/if}
            {#each g.items as item (item.id)}
              <div
                class="sig-i"
                class:new={item.isNew}
                class:confirmed={confirmed.has(item.id)}
                class:open={editing?.id === item.id}
                data-testid="signal-item"
              >
                <span class="mk"></span>
                <button type="button" class="one" aria-expanded={editing?.id === item.id}>{item.title}</button>
                <div class="card">
                  <div>{item.title}</div>
                  {#if item.owner || item.at}<div class="own">{[item.owner, item.at].filter(Boolean).join(" · ")}</div>{/if}
                  {#if item.quote}<div class="quote">“{item.quote}”</div>{/if}
                  {#if editing?.id === item.id}
                    <form class="edit" onsubmit={(e) => { e.preventDefault(); saveEdit(item); }}>
                      <!-- svelte-ignore a11y_autofocus -->
                      <input
                        autofocus
                        aria-label={editing.mode === "answer" ? "Answer" : "Edit item"}
                        bind:value={editing.text}
                        onkeydown={(e) => { if (e.key === "Escape") editing = null; }}
                      />
                      <button type="submit" class="btn">Save</button>
                    </form>
                  {:else}
                    <div class="act">
                      {#each item.actions as a (a)}
                        <button type="button" class="btn" data-action={a} onclick={() => act(a, item)}>{SIGNAL_ACTION_LABEL[a]}</button>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>
</section>

<style>
  .canvas {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    color: var(--t1);
    font-family: var(--font-ui);
  }

  .toolbar {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    height: 44px;
    padding: 0 12px 0 16px;
    border-bottom: 1px solid var(--line);
  }

  .crumb {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .name {
    overflow: hidden;
    font-size: 14px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 5px;
    height: 20px;
    padding: 0 7px;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--t2);
    font-family: var(--font-mono);
    font-size: 11px;
    white-space: nowrap;
  }

  .ldot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok);
  }

  .btn {
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .btn:hover:not(:disabled) {
    background: var(--hover);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .btn.primary {
    border-color: transparent;
    background: var(--v4-primary-bg, var(--t1));
    color: var(--v4-primary-fg, var(--side-bg));
  }

  .icon-btn {
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
  }

  .icon-btn:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .room {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 6px 16px;
    border-bottom: 1px solid var(--line);
  }

  .faces {
    display: flex;
    align-items: center;
  }

  .faces .mini + .mini {
    margin-left: -4px;
  }

  .mini {
    position: relative;
    display: inline-grid;
    flex: 0 0 auto;
    place-items: center;
    width: 24px;
    height: 24px;
    box-sizing: border-box;
    border: 2px solid var(--v4-ground, var(--side-bg));
    border-radius: 50%;
    background: var(--line2);
    color: var(--t1);
    font-size: 9px;
    font-weight: 600;
  }

  .mini.sq {
    border-radius: 6px;
  }

  .mini.tiny {
    width: 14px;
    height: 14px;
    border-width: 0;
    font-size: 8px;
  }

  .mini.speaking {
    box-shadow: 0 0 0 2px var(--ok);
  }

  .mini.invited {
    border: 1px dashed var(--t3);
    background: transparent;
    opacity: 0.7;
  }

  .ld {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 0 1.5px var(--v4-ground, var(--side-bg));
  }

  .who {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--t2);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .grid {
    display: grid;
    flex: 1 1 auto;
    grid-template-columns: 240px minmax(0, 1fr) 300px;
    min-height: 0;
  }

  .col {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    contain: layout paint;
    padding: 12px 16px 20px;
    scrollbar-width: thin;
  }

  .col + .col {
    border-left: 1px solid var(--line);
  }

  .colhead {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    margin-bottom: 8px;
  }

  .colhead h2 {
    margin: 0;
    color: var(--t2);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .grow {
    flex: 1 1 auto;
  }

  .count {
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .tab {
    height: 22px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .tab[aria-pressed="true"] {
    background: var(--sel);
    color: var(--t1);
  }

  .empty {
    margin: 4px 0;
    color: var(--t2);
    font-size: 13px;
  }

  .ol,
  .ol ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ol > li {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    padding: 5px 0;
    color: var(--t2);
    font-size: 13px;
  }

  .ol > li.done {
    color: var(--t3);
  }

  .ol > li.now {
    color: var(--t1);
  }

  .ol .n {
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .ol .txt {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ol > li.now .txt {
    white-space: normal;
  }

  .sub {
    display: block;
    color: var(--t2);
    font-size: 11px;
  }

  .ol ul {
    grid-column: 1 / -1;
    padding-left: 18px;
  }

  .ol ul li {
    display: grid;
    grid-template-columns: 12px minmax(0, 1fr);
    padding: 3px 0;
    color: var(--t2);
    font-size: 12px;
  }

  .ol ul li.done {
    color: var(--t3);
  }

  .notes {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .note {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 10px;
  }

  .note .mini {
    border-width: 0;
  }

  .hd {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 13px;
  }

  .hd span {
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .note p {
    margin: 2px 0 0;
    font-size: 14px;
    line-height: 1.5;
  }

  .cursor {
    display: inline-block;
    width: 1px;
    height: 14px;
    margin-left: 2px;
    vertical-align: -2px;
    background: var(--t1);
  }

  .sig-g + .sig-g {
    margin-top: 12px;
  }

  .sig-g h3 {
    margin: 0 0 4px;
    color: var(--t2);
    font-size: 12px;
    font-weight: 600;
  }

  .sig-i {
    position: relative;
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr);
    align-items: start;
    padding: 5px 6px;
    border-radius: 6px;
    font-size: 13px;
    outline: none;
  }

  .mk {
    width: 5px;
    height: 5px;
    margin-top: 6px;
    border-radius: 50%;
    background: var(--t3);
  }

  .sig-i.new .mk {
    background: var(--t1);
  }

  .sig-i.confirmed .mk {
    background: var(--ok);
  }

  .one {
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: default;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card {
    display: none;
    grid-column: 2;
    flex-direction: column;
    gap: 4px;
    padding-top: 2px;
  }

  .card > div:first-child {
    display: none;
  }

  .sig-i:hover,
  .sig-i:focus-within,
  .sig-i.open {
    background: var(--hover);
  }

  .sig-i:hover .one,
  .sig-i:focus-within .one,
  .sig-i.open .one {
    white-space: normal;
  }

  .sig-i:hover .card,
  .sig-i:focus-within .card,
  .sig-i.open .card {
    display: flex;
  }

  .own {
    color: var(--t2);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .quote {
    color: var(--t2);
    font-size: 12px;
    font-style: italic;
  }

  .act,
  .edit {
    display: flex;
    gap: 4px;
    margin-top: 2px;
  }

  .edit input {
    flex: 1 1 auto;
    min-width: 0;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 12px;
  }

  .sig-foot {
    padding: 2px 6px;
    color: var(--t3);
    font-size: 12px;
  }
</style>
