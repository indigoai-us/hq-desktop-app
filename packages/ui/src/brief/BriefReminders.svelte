<script lang="ts">
  /**
   * You asked to be reminded: what you told HQ to remind you of, in your own
   * words, on the day it matters. Each reminder reads in one pass: the quote
   * (the owner's words, with a hanging open quote), then a mono caps due pill
   * (OVERDUE in red, DUE TODAY warm, the rest quiet) and a quiet source line
   * saying when and where it was said. No boxes: a lone reminder is the card's
   * hero in large type, several are open rows soonest due first. On hover a
   * row offers its own actions: Start (the reminder's prompt, in the engine
   * the brief has chosen) and Done, which marks it in this brief only
   * (brief.cleared) until the brief-log append seam exists. A lone reminder on
   * a tall card also gets a day strip, said to due. The row's peek holds the
   * full text, where and when, and the prompt. Never a count card. Hidden when
   * nothing is due by the end of tomorrow, by the same rule the picker uses
   * (brief-reminders.ts, dueReminders).
   */
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import {
    REMINDER_TALL_PX,
    dueLabel,
    dueReminders,
    dueState,
    dueTone,
    reminderPrompt,
    reminderRows,
    reminderStrip,
    saidLabel,
    sourceLine,
    whenLine,
  } from "./brief-reminders.js";
  import type { BriefReminder } from "./brief-types.js";

  /** The strip's own height plus the gap above it. */
  const STRIP_ROOM_PX = 72;

  interface Props {
    reminders: BriefReminder[];
    prompts: Record<string, string>;
    /** ISO time the brief is generated for. */
    now: string;
    /** The brief's local day, YYYY-MM-DD (ctx.today). */
    today: string;
    rows: number;
    cols?: number;
  }
  let { reminders, prompts, now, today, rows, cols = 2 }: Props = $props();
  const brief = useBrief();
  const due = $derived(dueReminders(reminders, now));
  // At most five rows in a list; a one-column slot shows three. The rest open in the "+N more" peek.
  const split = $derived(reminderRows(due, cols >= 2 || rows > 1 ? 5 : 3));
  const shown = $derived(split.shown);
  const rest = $derived(split.rest);
  const done = $derived(due.filter((r) => brief.cleared[r.id]).length);
  /** One reminder alone leads the card in large type, with no row around it. */
  const hero = $derived(shown.length === 1 && rest.length === 0);
  // The card's own height: a lone reminder on a tall card (two grid rows, or a row stretched by its
  // neighbours) sets its words larger and gets the day strip in the room that would otherwise be empty.
  // The strip sits on the card's bottom edge out of flow, so it never changes the card's height: it
  // shows only when the room under the words can hold it. Before the first measure (and under test,
  // where nothing is laid out) a two-row slot counts as tall.
  let height = $state(0);
  let listH = $state(0);
  let card = $state<HTMLElement | null>(null);
  let list = $state<HTMLElement | null>(null);
  const tall = $derived(hero && (rows > 1 || height >= REMINDER_TALL_PX));
  const room = $derived.by(() => {
    if (!card || !list || !height) return rows > 1 ? Infinity : 0;
    return height - (list.offsetTop + listH) - (parseFloat(getComputedStyle(card).paddingBottom) || 0);
  });
  const strip = $derived(tall && shown[0] && room >= STRIP_ROOM_PX ? reminderStrip(shown[0], today) : []);

  const promptFor = (r: BriefReminder): string => prompts[r.id] ?? r.prompt ?? reminderPrompt(r);
  const late = (r: BriefReminder): boolean => dueState(r, today) === "overdue";
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  function content(r: BriefReminder): PeekContent {
    const where = r.where.trim();
    const when = whenLine(r.saidAt);
    return {
      eyebrow: `Reminder · ${saidLabel(r.saidAt, now)}`,
      title: r.text,
      status: brief.cleared[r.id] ? "Done in this brief" : cap(dueLabel(r, today)),
      sections: [
        {
          label: "Where and when",
          text: `${where ? `You said it in ${where}` : "You said it"}${when ? `, ${when}` : ""}.${r.dueAt && whenLine(r.dueAt) ? ` Due ${whenLine(r.dueAt)}.` : ""}`,
        },
      ],
      prompt: { id: r.id, text: promptFor(r) },
    };
  }

  const morePeek = (): PeekContent => ({
    title: `${rest.length} more reminder${rest.length === 1 ? "" : "s"}`,
    status: "Also due by tomorrow",
    sections: [
      {
        label: "In your words",
        lines: rest.map((r) => ({
          label: r.text,
          state: brief.cleared[r.id] ? "DONE" : dueLabel(r, today).toUpperCase(),
          ...(late(r) && !brief.cleared[r.id] ? { tone: "warn" as const } : {}),
        })),
      },
    ],
  });
</script>

{#if due.length}
  <div class="w" class:solo={hero} class:tall data-testid="brief-reminders" bind:this={card} bind:clientHeight={height}>
    <div class="eyebrow">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21v-4M9 4h6l-.8 6.2 2.3 2.3a1 1 0 0 1-.7 1.7H8.2a1 1 0 0 1-.7-1.7l2.3-2.3z" /></svg>
      You asked to be reminded
    </div>
    <div class="list" bind:this={list} bind:clientHeight={listH}>
      {#each shown as r (r.id)}
        {@const cleared = !!brief.cleared[r.id]}
        <div
          class="it"
          class:hero
          class:done={cleared}
          class:late={late(r) && !cleared}
          data-testid="brief-reminder"
          role="group"
          aria-label={r.text}
          use:peek={{ state: brief, content: () => content(r) }}
        >
          <div class="q"><span class="qm" aria-hidden="true">“</span><span data-testid="brief-reminder-text">{r.text}</span><span class="qm" aria-hidden="true">”</span></div>
          <div class="meta">
            <span class="duepill" data-testid="brief-reminder-due" data-tone={dueTone(r, today, cleared)}>{cleared ? "Done" : dueLabel(r, today)}</span>
            <span class="said" data-testid="brief-reminder-said">{sourceLine(r, now)}</span>
            {#if !cleared}
              <span class="acts">
                <button type="button" class="btn go" data-testid="brief-start" onclick={() => void brief.start(r.id, promptFor(r))}>Start</button>
                <button type="button" class="btn" data-testid="brief-reminder-done" onclick={() => brief.clear(r.id)}>Done</button>
              </span>
            {/if}
          </div>
          {#if brief.notes[r.id]}<div class="note" role="status">{brief.notes[r.id]}</div>{/if}
        </div>
      {/each}
      {#if rest.length}
        <div class="more-row" role="button" tabindex="0" data-testid="brief-reminder-more" use:peek={{ state: brief, content: morePeek }}>
          +{rest.length} more
        </div>
      {/if}
    </div>
    {#if strip.length}
      <!-- Said to due, day by day: solid for the days gone, dotted for the days left, red once it is late. -->
      <div class="strip" data-testid="brief-reminder-strip" aria-hidden="true">
        {#each strip as d (d.day)}
          <div class="d" class:said={d.said} class:due={d.due} class:today={d.today} data-tone={d.due ? dueTone(shown[0]!, today, !!brief.cleared[shown[0]!.id]) : null} data-day={d.day}>
            <span class="dl">{d.label}</span>
            <span class="track">
              {#if d.into}<i class="seg in {d.into}"></i>{/if}
              {#if d.out}<i class="seg out {d.out}"></i>{/if}
              <b class="dot"></b>
            </span>
            <span class="cap">{d.due ? "Due" : d.said ? "Said" : d.today ? "Today" : ""}</span>
          </div>
        {/each}
      </div>
    {/if}
    {#if rows > 1 && !hero}
      <div class="foot"><span>{done} of {due.length} done</span><span>Hover a row to start it</span></div>
    {/if}
  </div>
{/if}

<style>
  .w {
    container-type: inline-size;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
  }
  /* Open rows, no boxes: a soft white glass shows only under the pointer. The text lines up with the card label. */
  .it {
    position: relative;
    margin: 0 -10px;
    padding: 7px 10px 6px;
    border-radius: 8px;
    transition: background 0.25s, opacity 0.5s;
  }
  .it:not(.hero):hover,
  .it:not(.hero):focus-within {
    background: rgba(255, 255, 255, 0.14);
  }
  .it.hero {
    margin: 0;
    padding: 0;
  }
  .it.done {
    opacity: 0.55;
  }
  .it.done .q > span:not(.qm) {
    text-decoration: line-through;
    text-decoration-thickness: 1px;
    text-decoration-color: rgba(255, 255, 255, 0.6);
  }
  /* The owner's words. The open quote mark starts on the card's content edge, the same left edge as the
     label and the due pill (no hanging punctuation, no negative indent). */
  .q {
    font-size: 15px;
    font-weight: 500;
    line-height: 20px;
    letter-spacing: -0.01em;
    color: #fff;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .qm {
    color: rgba(255, 255, 255, 0.62);
  }
  .hero .q {
    font-size: var(--b-fs-title-lg, 20px);
    line-height: 26px;
    letter-spacing: -0.02em;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
  .w.tall .hero .q {
    font-size: 26px;
    line-height: 32px;
    letter-spacing: -0.025em;
  }
  .w.tall .hero .meta {
    margin-top: 12px;
  }
  /* The due pill, then where and when it was said; the row's actions take the line's end on hover. */
  .meta {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    height: 24px;
    margin-top: 3px;
  }
  .hero .meta {
    height: 26px;
    margin-top: 8px;
  }
  .duepill {
    flex: none;
    transition: opacity 0.2s;
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 7px;
    border-radius: 6px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
    text-shadow: none;
  }
  .duepill[data-tone="today"] {
    color: #ffe08a;
    background: rgba(255, 205, 110, 0.32);
    /* The field's own whisper of shadow, a touch warmer, keeps the pale gold legible on the light end of the field. */
    text-shadow: 0 1px 2px rgba(120, 40, 10, 0.3);
  }
  .duepill[data-tone="overdue"] {
    color: #fff;
    background: rgba(255, 107, 94, 0.42);
  }
  .duepill[data-tone="done"] {
    color: rgba(255, 255, 255, 0.85);
  }
  .said {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.82);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: opacity 0.2s;
  }
  .note {
    margin-top: 4px;
    font-size: 12px;
    color: #fff;
  }
  /* Actions appear only on the reminder that has your attention, over the end of its source line. */
  .acts {
    position: absolute;
    right: 0;
    top: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    opacity: 0;
    translate: 6px 0;
    pointer-events: none;
    transition: opacity 0.25s, translate 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .it:hover .acts,
  .it:focus-within .acts {
    opacity: 1;
    translate: 0 0;
    pointer-events: auto;
  }
  .it:hover .said,
  .it:focus-within .said {
    opacity: 0;
  }
  .btn {
    all: unset;
    cursor: pointer;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 9px;
    border-radius: 6px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: #fff;
    background: rgba(255, 255, 255, 0.16);
    text-shadow: none;
    transition: background 0.2s, color 0.2s;
  }
  .btn:hover,
  .btn:focus-visible {
    color: #18181b;
    background: #fff;
    outline: none;
  }
  .hero .btn {
    height: 26px;
    padding: 0 11px;
  }
  /* The hero's line has room for both: its actions keep their place at the end, so the source line stays put. */
  .hero .acts {
    position: static;
    margin-left: auto;
    flex: none;
  }
  .it.hero:hover .said,
  .it.hero:focus-within .said {
    opacity: 1;
  }
  /* "+N more": a quiet mono caps button that opens the rest in a peek. */
  .more-row {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    height: 24px;
    margin-top: 6px;
    padding: 0 9px;
    border-radius: 6px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
    text-shadow: none;
    cursor: default;
    transition: background 0.2s, color 0.2s;
  }
  .more-row:hover,
  .more-row:focus-visible {
    color: #18181b;
    background: #fff;
    outline: none;
  }
  .foot {
    border-top: 0;
  }

  /* The day strip: said to due, at the foot of a tall card with a lone reminder. */
  .strip {
    position: absolute;
    left: 20px;
    right: 20px;
    bottom: 18px;
    display: grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
  }
  .d {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.6);
    text-shadow: none;
  }
  .dl,
  .cap {
    white-space: nowrap;
  }
  .cap {
    height: 10px;
    color: rgba(255, 255, 255, 0.85);
  }
  .d.today .dl,
  .d.said .dl {
    color: #fff;
  }
  .track {
    position: relative;
    align-self: stretch;
    height: 12px;
    display: grid;
    place-items: center;
  }
  .seg {
    position: absolute;
    top: 50%;
    height: 0;
    width: 50%;
    border-top: 2px solid rgba(255, 255, 255, 0.8);
    translate: 0 -1px;
  }
  .seg.in {
    left: 0;
  }
  .seg.out {
    right: 0;
  }
  .seg.ahead {
    border-top-style: dotted;
    border-top-color: rgba(255, 255, 255, 0.75);
  }
  .seg.late {
    border-top-color: rgba(255, 140, 128, 0.95);
  }
  .dot {
    position: relative;
    z-index: 1;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.45);
  }
  .d.said .dot {
    width: 10px;
    height: 10px;
    background: transparent;
    box-shadow: 0 0 0 2px #fff;
  }
  /* Hollow: the field shows through, so the track starts at the ring, not under it. */
  .d.said .seg.out {
    width: calc(50% - 7px);
  }
  .d.today .dot {
    width: 8px;
    height: 8px;
    background: #fff;
  }
  .d.due .dot {
    width: 12px;
    height: 12px;
    background: #fff;
  }
  .d.due[data-tone="today"] .dot {
    background: #ffe08a;
  }
  .d.due[data-tone="today"] :is(.dl, .cap) {
    color: #ffe08a;
  }
  .d.due[data-tone="overdue"] .dot {
    background: #ff8a80;
  }
  .d.due :is(.dl, .cap) {
    color: #fff;
  }
  .d.due[data-tone="overdue"] :is(.dl, .cap) {
    color: #ffd0ca;
  }
  /* Narrow cards: the words stay at the title size, the actions take the source line's place on
     hover (the pill too, so both buttons fit), and the strip's marks carry it without captions. */
  @container (max-width: 300px) {
    .hero .q {
      font-size: 17px;
      line-height: 22px;
    }
    .w.tall .hero .q {
      font-size: var(--b-fs-title-lg, 20px);
      line-height: 26px;
    }
    .hero .acts {
      position: absolute;
      margin-left: 0;
    }
    .it.hero:hover .said,
    .it.hero:focus-within .said {
      opacity: 0;
    }
    .it:hover .duepill,
    .it:focus-within .duepill {
      opacity: 0;
    }
    .cap {
      display: none;
    }
    /* One letter a day (the mono face makes 1ch exactly one letter), as on a calendar's narrow week. */
    .dl {
      width: 1ch;
      overflow: hidden;
      letter-spacing: 0;
    }
  }
</style>
