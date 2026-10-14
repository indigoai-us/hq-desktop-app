<script lang="ts">
  /**
   * Focus time: where today's one clear block is, which priority fits it, and
   * that it is worth protecting. The runway runs 8 AM to 6 PM on one thin
   * track: the padded gaps are filled segments in page ink (deep and solid
   * full, shallow lighter), every call is empty track with a thin tick at its
   * middle (fainter when projected or a busy hold). The longest gap is the
   * one terracotta segment and takes priority 1; the next gap takes
   * priority 2, and so on. Hover a gap for its neighbours, the suggested
   * task, Start in <engine>, and an event draft that blocks it (copied to the
   * clipboard; the brief never writes the calendar).
   */
  import { copyBriefPrompt, peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { humanTitle } from "./brief-distill.js";
  import {
    calendarDraft,
    focusRunway,
    gapRange,
    gapWhere,
    minutesText,
    pct,
    priorityLaunchId,
    priorityPrompt,
    RULER_HOURS,
    runwayTitle,
    suggestionFor,
    WORKDAY_END_MIN,
    WORKDAY_START_MIN,
    type FocusGap,
    type RunwayPill,
  } from "./brief-runway.js";
  import { rangeText } from "./brief-strip.js";
  import type { BriefCalendarEvent, BriefPriority } from "./brief-types.js";

  interface Props {
    events: BriefCalendarEvent[];
    priorities: BriefPriority[];
    prompts: Record<string, string>;
    /** ISO time the brief is generated for: the needle, and where the day's walk starts. */
    now: string;
    /** The calendar is illustrative (no live calendar). */
    sample: boolean;
    cols: number;
    rows: number;
  }
  let { events, priorities, prompts, now, sample, cols, rows }: Props = $props();
  const brief = useBrief();

  const runway = $derived(focusRunway(events, now));
  const provisional = $derived(sample || (runway.events.length > 0 && runway.events.every((e) => e.projected)));
  const title = $derived(runwayTitle(runway));
  // At most five rows in a list; a "+N more" row opens the rest in the peek.
  const cap = $derived(rows > 1 ? 5 : cols >= 3 ? 3 : 2);
  const shown = $derived(runway.ranked.slice(0, cap));
  const rest = $derived(runway.ranked.slice(cap));
  const needle = $derived(runway.nowMin != null && runway.nowMin >= WORKDAY_START_MIN && runway.nowMin <= WORKDAY_END_MIN ? pct(runway.nowMin) : null);
  const dateLabel = $derived(new Date(now).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }));
  let copied = $state<string | null>(null);

  /** The suggested task in plain words: no repo, PR or commit prefix. */
  const task = (g: FocusGap): string | null => {
    const p = suggestionFor(priorities, g);
    return p ? humanTitle(p.text).text : null;
  };
  const promptFor = (p: BriefPriority, g: FocusGap): string => prompts[p.itemId ?? ""] ?? priorityPrompt(p, g);
  const gapLabel = (g: FocusGap) => `${minutesText(g.minutes)} · ${gapRange(g)}`;
  /** A ruler hour in plain words: 8 AM, 12 PM, 2 PM. */
  const hourLabel = (h: number) => `${h % 12 || 12} ${h >= 12 ? "PM" : "AM"}`;

  async function block(g: FocusGap): Promise<void> {
    if (await copyBriefPrompt(calendarDraft(g, task(g), dateLabel))) {
      copied = g.id;
      setTimeout(() => (copied = null), 1400);
    }
  }

  function gapPeek(g: FocusGap): PeekContent {
    const p = suggestionFor(priorities, g);
    const between = [g.after, g.before].filter((e): e is BriefCalendarEvent => !!e).map((e) => ({ label: e.busy ? "Busy" : e.title, state: rangeText(e) }));
    const sections: PeekContent["sections"] = [
      between.length ? { label: "Between", lines: between } : { label: "Between", text: "Nothing else booked." },
    ];
    if (p) {
      sections.push({ label: "Suggested", text: `Priority ${p.n}: ${humanTitle(p.text).text}` });
      if (p.because) sections.push({ label: "Fit", text: p.because });
    } else {
      sections.push({ label: "Suggested", text: "Nothing assigned. Pick the hardest thing on your list." });
    }
    return {
      title: gapLabel(g),
      status: g.rank === 1 ? `Protect this one · ${gapWhere(g)}` : `Ranked #${g.rank} · ${g.cls} · ${gapWhere(g)}`,
      sections,
      prompt: p ? { id: priorityLaunchId(p), text: promptFor(p, g) } : undefined,
      actions: [{ label: "Block on calendar", run: () => void block(g), testid: "brief-runway-block" }],
    };
  }

  const morePeek = (): PeekContent => ({
    title: `${rest.length} more gap${rest.length === 1 ? "" : "s"}`,
    status: "Shorter stretches, longest first",
    sections: [{ label: "Also clear", lines: rest.map((g) => ({ label: gapLabel(g), state: task(g) ?? "" })) }],
  });

  function pillPeek(p: RunwayPill): PeekContent {
    const e = p.event;
    const notes = [rangeText(e)];
    if (e.projected) notes.push("projected from a recurring series");
    if (e.tentative) notes.push("Maybe");
    const sections: PeekContent["sections"] = [];
    if (e.attendees?.length) sections.push({ label: "With", lines: e.attendees.slice(0, 5).map((a) => ({ label: a, state: "" })) });
    return { sample: sample || e.projected, title: e.busy ? "Busy" : e.title, status: notes.join(" · "), sections };
  }

  const provisionalPeek = (): PeekContent => ({
    title: "Provisional",
    status: sample ? "No live calendar in this preview" : "Calendar not loaded",
    sections: [{ label: "Why dashed", text: "Today's calls are drawn from recurring series, not read from the calendar. The runway firms up once it loads." }],
  });
</script>

<div class="w" data-testid="brief-runway" data-protect={runway.protect?.id ?? ""} data-gaps={runway.gaps.length}>
  <div class="hd">
    <div class="hdt">
      <div class="eyebrow">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
        Focus time{#if provisional}<span data-testid="brief-runway-provisional"> · provisional</span>{/if}
      </div>
      <h3 data-testid="brief-runway-title">{title}</h3>
    </div>
    {#if provisional}
      <span class="tag" role="note" use:peek={{ state: brief, content: provisionalPeek }}>{sample ? "sample calendar" : "calendar not loaded"}</span>
    {/if}
  </div>

  <div class="rw" data-testid="brief-runway-bar">
    {#each runway.gaps as g (g.id)}
      <div
        class="gp {g.cls}"
        class:pro={g.rank === 1}
        role="button"
        tabindex="0"
        aria-label="{minutesText(g.minutes)} clear {gapWhere(g)}, {gapRange(g)}"
        data-testid="brief-runway-gap"
        data-rank={g.rank}
        data-cls={g.cls}
        style="left:{pct(g.startMin)}%;width:{pct(g.endMin) - pct(g.startMin)}%"
        use:peek={{ state: brief, content: () => gapPeek(g) }}
      ></div>
    {/each}
    {#each runway.pills as p (p.event.id)}
      <!-- A call is empty track with a thin tick at its middle; the title is for the hover and screen readers. -->
      <div
        class="mt"
        class:proj={p.event.projected}
        class:busy={p.event.busy}
        class:tent={p.event.tentative}
        role="group"
        aria-label="{p.event.busy ? 'Busy' : p.event.title}, {rangeText(p.event)}"
        data-testid="brief-runway-pill"
        style="left:{pct(p.startMin)}%;width:{pct(p.endMin) - pct(p.startMin)}%"
        use:peek={{ state: brief, content: () => pillPeek(p) }}
      >{#if !p.event.busy}<span class="vh" aria-hidden="true">{p.event.title}</span>{/if}</div>
    {/each}
    {#if needle != null}<div class="ndl" data-testid="brief-runway-now" style="left:{needle}%"></div>{/if}
  </div>
  <div class="rul" aria-hidden="true">
    {#each RULER_HOURS as h (h)}
      <span class:first={h === RULER_HOURS[0]} class:last={h === RULER_HOURS[RULER_HOURS.length - 1]} style="left:{pct(h * 60)}%">{hourLabel(h)}</span>
    {/each}
  </div>

  {#if shown.length}
    <div class="gaps" class:list={rows > 1} style="--n:{rows > 1 ? 1 : shown.length}">
      {#each shown as g (g.id)}
        {@const p = suggestionFor(priorities, g)}
        <div
          class="g"
          class:pro={g.rank === 1}
          role="button"
          tabindex="0"
          aria-label="{gapLabel(g)}{task(g) ? `, ${task(g)}` : ''}"
          data-testid="brief-runway-row"
          data-rank={g.rank}
          data-launch={p ? priorityLaunchId(p) : undefined}
          use:peek={{ state: brief, content: () => gapPeek(g) }}
        >
          <!-- What to do with the gap at the top; how long and when at the tile's foot. -->
          <div class="tx">
            <div class="tk" class:un={!p} data-testid="brief-runway-task">{task(g) ?? "Unassigned"}</div>
            {#if p?.because}<div class="fit">{p.because}</div>{/if}
            {#if copied === g.id}<div class="note" role="status">Event draft copied</div>{/if}
          </div>
          <div class="ft">
            <span class="du">{minutesText(g.minutes)}</span><span class="rg"><span class="sep">{" · "}</span>{gapRange(g)}</span>
            {#if g.rank === 1}<em class="pr">protect</em>{/if}
          </div>
        </div>
      {/each}
    </div>
    {#if rest.length}
      <div class="more" role="button" tabindex="0" data-testid="brief-runway-more" use:peek={{ state: brief, content: morePeek }}>+{rest.length} more</div>
    {/if}
  {/if}
</div>

<style>
  .hd {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
  }
  .hdt {
    min-width: 0;
  }
  /* Provisional: a mono caps chip, soft fill, no rim. */
  .tag {
    flex: none;
    display: inline-flex;
    align-items: center;
    height: 18px;
    margin-top: 8px;
    padding: 0 7px;
    border-radius: 999px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
    background: rgb(var(--b-ink) / 0.06);
    border: 0;
    white-space: nowrap;
    cursor: default;
  }

  /* The runway: one thin track. Free time is filled in page ink, calls are the empty
     stretches between, each marked by a thin tick. No rims, no blur filters. */
  .rw {
    position: relative;
    flex: none;
    height: 8px;
    margin-top: 22px;
    border-radius: 999px;
    background: rgb(var(--b-ink) / 0.06);
  }
  .gp {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 999px;
    background: rgb(var(--b-ink) / 0.55);
    cursor: default;
    transition: background 0.2s, filter 0.2s;
  }
  /* A taller hit area than the 8 px it draws. */
  .gp::after {
    content: "";
    position: absolute;
    top: -8px;
    bottom: -8px;
    left: 0;
    right: 0;
  }
  .gp.shallow {
    background: rgb(var(--b-ink) / 0.3);
  }
  .gp:hover,
  .gp:focus-visible {
    background: rgb(var(--b-ink) / 0.8);
    outline: none;
  }
  /* The one to protect: the card's single accent. */
  .gp.pro {
    background: var(--b-hot, #c9765a);
  }
  .gp.pro:hover,
  .gp.pro:focus-visible {
    background: var(--b-hot, #c9765a);
    filter: brightness(0.9);
  }
  /* A call: empty track, a thin dark tick at its middle. */
  .mt {
    position: absolute;
    top: -8px;
    bottom: -8px;
    cursor: default;
  }
  .mt::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 4px;
    bottom: 4px;
    width: 2px;
    translate: -50% 0;
    border-radius: 1px;
    background: rgb(var(--b-ink) / 0.5);
    transition: background 0.2s;
  }
  .mt:hover::before {
    background: rgb(var(--b-ink) / 0.9);
  }
  .mt.proj::before,
  .mt.tent::before,
  .mt.busy::before {
    background: rgb(var(--b-ink) / 0.25);
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .ndl {
    position: absolute;
    top: -6px;
    bottom: -6px;
    width: 1px;
    translate: -50% 0;
    background: var(--b-t1);
    z-index: 2;
    pointer-events: none;
  }
  .rul {
    position: relative;
    flex: none;
    height: 14px;
    margin-top: 10px;
    font-size: 11px;
    line-height: 14px;
    font-variant-numeric: tabular-nums;
    color: var(--b-t3);
  }
  .rul span {
    position: absolute;
    translate: -50% 0;
    white-space: nowrap;
  }
  .rul span.first {
    translate: 0 0;
  }
  .rul span.last {
    translate: -100% 0;
  }

  /* Ranked gaps: glass tiles that fill the rest of the card, three across in a one-row
     slot, a list in a tall one. */
  .gaps {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(var(--n, 3), minmax(0, 1fr));
    grid-auto-rows: 1fr;
    gap: 8px;
    margin-top: 18px;
  }
  .g {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    padding: 12px 14px;
    border-radius: 10px;
    background: var(--b-row-bg, rgb(var(--b-ink) / 0.12));
    border: 0;
    box-shadow: none;
    cursor: default;
    transition: background 0.2s;
  }
  .g:hover,
  .g:focus-visible {
    background: var(--b-row-hover, rgb(var(--b-ink) / 0.2));
    outline: none;
  }
  .tx {
    min-width: 0;
  }
  .tk {
    font-size: 13px;
    line-height: 1.35;
    color: var(--b-t1);
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
  }
  .tk.un {
    color: var(--b-t3);
  }
  .fit {
    margin-top: 4px;
    font-size: 12px;
    line-height: 1.35;
    color: var(--b-t2);
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .note {
    margin-top: 4px;
    font-size: 11px;
    color: var(--b-t2);
  }
  /* The foot: how long, and when underneath, muted; the protected gap carries the
     highlight label on the right. */
  .ft {
    margin-top: auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 8px;
    align-items: center;
    min-width: 0;
    white-space: nowrap;
  }
  .du {
    grid-area: 1 / 1;
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.01em;
    line-height: 1.3;
    color: var(--b-t1);
  }
  .rg {
    grid-area: 2 / 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 1px;
    font-size: 11px;
    line-height: 1.3;
    font-variant-numeric: tabular-nums;
    color: var(--b-t3);
  }
  /* The " · " joins duration and range for screen readers and copy; the line break does it here. */
  .sep {
    display: none;
  }
  .pr {
    grid-area: 1 / 2;
    justify-self: end;
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 7px;
    border-radius: 999px;
    font-family: var(--b-code);
    font-style: normal;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-on-hot, #fff);
    background: var(--b-hot, #c9765a);
  }
  /* A tall slot: one gap per row, the task on the left and the time on the right. */
  .list .g {
    flex-direction: row;
    align-items: center;
    gap: 12px;
  }
  .list .tx {
    flex: 1;
  }
  .list .tk {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
  .list .fit {
    display: block;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* In a row the foot reads on one line: tag, duration, range. */
  .list .ft {
    flex: none;
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .list .pr {
    order: -1;
    align-self: center;
    margin-right: 4px;
  }
  .list .rg {
    margin: 0;
  }
  .more {
    flex: none;
    margin-top: 8px;
    text-align: center;
    padding: 6px 10px;
    border-radius: 10px;
    font-size: 13px;
    color: var(--b-t2);
    background: var(--b-row-bg, rgb(var(--b-ink) / 0.12));
    cursor: default;
    transition: background 0.2s;
  }
  .more:hover,
  .more:focus-visible {
    background: var(--b-row-hover, rgb(var(--b-ink) / 0.2));
    outline: none;
  }
</style>
