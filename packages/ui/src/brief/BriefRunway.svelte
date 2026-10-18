<script lang="ts">
  /**
   * Focus time: where today's one clear block is, which priority fits it, and
   * that it is worth protecting. The hero is the protected block's length. The
   * runway under it is the workday to scale, 8 AM to 6 PM: every free stretch
   * is a solid block in page ink, every call a hatched sliver, padding and
   * scraps the faint track between. The longest gap is the one terracotta
   * block and takes priority 1; the next gap takes priority 2, and so on.
   * Each shown gap drops a stem into its caption (what to do with it), so the
   * captions read left to right in time order, under their own stretch of the
   * day. Hover a block or a caption for its neighbours, the suggested task,
   * Start in <engine>, and an event draft that blocks it (copied to the
   * clipboard; the brief never writes the calendar).
   */
  import { copyBriefPrompt, peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { humanTitle } from "./brief-distill.js";
  import {
    calendarDraft,
    captionLayout,
    focusRunway,
    gapRange,
    gapWhere,
    minutesText,
    pct,
    priorityLaunchId,
    priorityPrompt,
    RULER_HOURS,
    runwayHero,
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
  const hero = $derived(runwayHero(runway));
  /** The headline as a caption: one line per sentence. */
  const lines = $derived(hero ? hero.lines : title.split(/(?<=\.)\s+/));
  const tall = $derived(rows > 1);
  // At most five captions in a tall slot; a "+N more" chip by the hero opens the rest in the peek.
  const cap = $derived(tall ? 5 : cols >= 3 ? 3 : 2);
  /** The longest gaps make the cut; they are captioned in time order, under their own blocks. */
  const shown = $derived(
    runway.ranked.slice(0, cap).sort((a, b) => a.startMin - b.startMin),
  );
  const rest = $derived(runway.ranked.slice(cap));
  const needle = $derived(runway.nowMin != null && runway.nowMin >= WORKDAY_START_MIN && runway.nowMin <= WORKDAY_END_MIN ? pct(runway.nowMin) : null);
  const dateLabel = $derived(new Date(now).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }));
  let copied = $state<string | null>(null);
  /** The gap under the pointer or focus: its block and its caption light together. */
  let hot = $state<string | null>(null);
  const gapLabel = (g: FocusGap) => `${minutesText(g.minutes)} · ${gapRange(g)}`;
  /** The captions' width in px (a nominal one until measured). */
  let capW = $state(0);
  /** Each caption keeps room for its mono meta on one line (and the protect chip), and a readable task. */
  const minPx = (g: FocusGap) => Math.max(140, 30 + 7.1 * (g.rank === 1 ? gapRange(g).length + 10 : gapLabel(g).length));
  const layout = $derived(
    captionLayout(
      shown.map((g) => ({ start: pct(g.startMin), end: pct(g.endMin) })),
      shown.map((g) => (minPx(g) / (capW > 0 ? capW : 634)) * 100),
    ),
  );
  /** Grid columns: a spacer before each caption, then the caption. */
  const columns = $derived(
    layout
      .flatMap((at, i) => [at.left - (i ? layout[i - 1]!.left + layout[i - 1]!.width : 0), at.width])
      .map((x) => `${Math.max(0, Math.floor(x * 1000) / 1000)}%`)
      .join(" "),
  );
  /** The suggested task in plain words: no repo, PR or commit prefix. */
  const task = (g: FocusGap): string | null => {
    const p = suggestionFor(priorities, g);
    return p ? humanTitle(p.text).text : null;
  };
  const promptFor = (p: BriefPriority, g: FocusGap): string => prompts[p.itemId ?? ""] ?? priorityPrompt(p, g);
  /** A ruler hour in plain words: 8 AM, 12 PM, 2 PM. */
  const hourLabel = (h: number) => `${h % 12 || 12} ${h >= 12 ? "PM" : "AM"}`;
  /** Every hour of the workday, for the faint dotted gridlines. */
  const hours = Array.from({ length: (WORKDAY_END_MIN - WORKDAY_START_MIN) / 60 - 1 }, (_, i) => WORKDAY_START_MIN / 60 + 1 + i);
  const light = (id: string) => ({ onmouseenter: () => (hot = id), onmouseleave: () => (hot = null), onfocus: () => (hot = id), onblur: () => (hot = null) });

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
    sections: [{ label: "Why faint", text: "Today's calls are drawn from recurring series, not read from the calendar. The runway firms up once it loads." }],
  });
</script>

<div class="w" class:tall data-testid="brief-runway" data-protect={runway.protect?.id ?? ""} data-gaps={runway.gaps.length}>
  <div class="hd">
    <div class="hdt">
      <div class="eyebrow">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
        Focus time{#if provisional}<span data-testid="brief-runway-provisional"> · provisional</span>{/if}
      </div>
      <!-- The hero: how long the protected block runs, big; the rest of the line beside it, one sentence a line. -->
      <div class="hero">
        {#if !hero && runway.protect}<span class="num" data-testid="brief-runway-hero">{minutesText(runway.protect.minutes)}</span>{/if}
        <h3 data-testid="brief-runway-title">
          {#if hero}<span class="num" data-testid="brief-runway-hero">{hero.num}</span>{" "}{/if}<span class="cap"
            >{#each lines as l, i (i)}{#if i}{" "}{/if}<span class="ln">{l}</span>{/each}</span
          >
        </h3>
      </div>
    </div>
    {#if provisional || rest.length}
      <div class="aside">
        {#if provisional}
          <span class="tag" role="note" use:peek={{ state: brief, content: provisionalPeek }}>{sample ? "sample calendar" : "calendar not loaded"}</span>
        {/if}
        {#if rest.length}
          <div class="more" role="button" tabindex="0" data-testid="brief-runway-more" use:peek={{ state: brief, content: morePeek }}>+{rest.length} more</div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="day">
    <div class="rul" aria-hidden="true">
      {#each RULER_HOURS as h (h)}
        <span class:first={h === RULER_HOURS[0]} class:last={h === RULER_HOURS[RULER_HOURS.length - 1]} style="left:{pct(h * 60)}%">{hourLabel(h)}</span>
      {/each}
    </div>
    <div class="rw" data-testid="brief-runway-bar">
      {#each hours as h (h)}<i class="hl" aria-hidden="true" style="left:{pct(h * 60)}%"></i>{/each}
      {#each runway.pills as p (p.event.id)}
        <!-- A call: a hatched sliver over its own time; the title is for the hover and screen readers. -->
        <div
          class="mt"
          class:proj={p.event.projected}
          class:busy={p.event.busy}
          class:tent={p.event.tentative}
          class:done={runway.nowMin != null && p.endMin <= runway.nowMin}
          role="group"
          aria-label="{p.event.busy ? 'Busy' : p.event.title}, {rangeText(p.event)}"
          data-testid="brief-runway-pill"
          style="left:{pct(p.startMin)}%;width:{pct(p.endMin) - pct(p.startMin)}%"
          use:peek={{ state: brief, content: () => pillPeek(p) }}
        >{#if !p.event.busy}<span class="vh" aria-hidden="true">{p.event.title}</span>{/if}</div>
      {/each}
      {#each runway.gaps as g (g.id)}
        <div
          class="gp {g.cls}"
          class:pro={g.rank === 1}
          class:on={hot === g.id}
          role="button"
          tabindex="0"
          aria-label="{minutesText(g.minutes)} clear {gapWhere(g)}, {gapRange(g)}"
          data-testid="brief-runway-gap"
          data-rank={g.rank}
          data-cls={g.cls}
          style="left:{pct(g.startMin)}%;width:{pct(g.endMin) - pct(g.startMin)}%"
          {...light(g.id)}
          use:peek={{ state: brief, content: () => gapPeek(g) }}
        ></div>
      {/each}
      {#if needle != null}<div class="ndl" data-testid="brief-runway-now" style="left:{needle}%"></div>{/if}
    </div>
  </div>

  {#if shown.length}
    <div class="gaps" class:list={tall} class:dense={tall && shown.length > 3} bind:clientWidth={capW} style:grid-template-columns={tall ? undefined : columns}>
      {#each shown as g, i (g.id)}
        {@const p = suggestionFor(priorities, g)}
        {@const at = layout[i]!}
        {@const moved = !tall && at.moved}
        <div
          class="g"
          class:pro={g.rank === 1}
          class:on={hot === g.id}
          class:moved
          class:end={!tall && at.side === "end"}
          role="button"
          tabindex="0"
          aria-label="{gapLabel(g)}{task(g) ? `, ${task(g)}` : ''}"
          data-testid="brief-runway-row"
          data-rank={g.rank}
          data-launch={p ? priorityLaunchId(p) : undefined}
          style:grid-column={tall ? undefined : 2 * i + 2}
          {...light(g.id)}
          use:peek={{ state: brief, content: () => gapPeek(g) }}
        >
          <!-- On a crowded day a caption may miss its block: an elbow leads from the block to it. -->
          {#if moved}
            <i class="lk" class:back={at.left < at.reach} aria-hidden="true" style="--span:{Math.abs(at.left - at.reach) / at.width}"></i>
          {/if}
          <!-- The protected caption's length is the hero's number: said once, kept for screen readers. -->
          <div class="mta">
            {#if g.rank === 1}<em class="pr">protect</em>{/if}<span class="du" class:vh={g.rank === 1}>{minutesText(g.minutes)}<span class="sep">{" · "}</span></span><span class="rg">{gapRange(g)}</span>
          </div>
          <div class="tx">
            <div class="tk" class:un={!p} data-testid="brief-runway-task">{task(g) ?? "Unassigned"}</div>
            {#if copied === g.id}<div class="note" role="status">Event draft copied</div>{:else if p?.because}<div class="fit">{p.because}</div>{/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .hd {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    flex: none;
  }
  .hdt {
    min-width: 0;
  }
  /* The hero: the protected block's length, big and light; the rest of the line beside it. */
  .hero {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .hero h3 {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
    margin: 0;
  }
  .num {
    flex: none;
    font-size: var(--b-fs-num, 32px);
    font-weight: 400;
    letter-spacing: -0.035em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--b-t1);
    white-space: nowrap;
  }
  .cap {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .ln {
    font-size: 13px;
    font-weight: 500;
    letter-spacing: -0.01em;
    line-height: 1.3;
    color: var(--b-t1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ln + .ln {
    font-weight: 400;
    color: var(--b-t2);
  }
  .aside {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* Chips: mono caps, soft fill, no rim. Provisional reads; +N more opens the rest. */
  .tag,
  .more {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 8px;
    border-radius: 999px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t2);
    background: var(--b-row-bg, rgb(var(--b-ink) / 0.06));
    white-space: nowrap;
    cursor: default;
    transition: background 0.2s, color 0.2s;
  }
  /* The provisional note is quiet text, not a chip. */
  .tag {
    height: auto;
    padding: 0;
    color: var(--b-t3);
    background: none;
  }
  .more:hover,
  .more:focus-visible {
    color: var(--b-t1);
    background: var(--b-row-hover, rgb(var(--b-ink) / 0.1));
    outline: none;
  }

  /* The day: the workday to scale, a mono ruler over it. Free time is solid, calls are
     hatched, the faint track between is padding and scraps. No rims, no blur filters. */
  /* Spare height grows the blocks a little, then opens the air above the ruler, so the
     stems always meet their blocks. */
  .day {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    min-height: 56px;
    margin-top: 16px;
  }
  .rul {
    position: relative;
    flex: none;
    height: 12px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    line-height: 12px;
    text-transform: uppercase;
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
  .rw {
    position: relative;
    flex: 1 1 auto;
    min-height: 36px;
    max-height: 84px;
    margin-top: 8px;
    border-radius: 8px;
    background: rgb(var(--b-ink) / 0.04);
  }
  .tall .rw {
    max-height: 120px;
  }
  /* Hour gridlines: faint dots over everything, the day's scale even across a block. */
  .hl {
    z-index: 1;
    position: absolute;
    top: 6px;
    bottom: 6px;
    width: 1px;
    translate: -50% 0;
    background: radial-gradient(circle, rgb(var(--b-ink) / 0.16) 0.6px, transparent 0.9px) center top / 1px 4px repeat-y;
    pointer-events: none;
  }
  /* A free stretch: a solid block in page ink, deeper for longer. */
  .gp {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 6px;
    background: rgb(var(--b-ink) / 0.2);
    cursor: default;
    transition: background 0.2s, filter 0.2s;
  }
  .gp.solid {
    background: rgb(var(--b-ink) / 0.16);
  }
  .gp.shallow {
    background: rgb(var(--b-ink) / 0.11);
  }
  .gp:hover,
  .gp:focus-visible,
  .gp.on {
    background: rgb(var(--b-ink) / 0.3);
    outline: none;
  }
  /* The one to protect: the card's single accent. */
  .gp.pro {
    background: var(--b-hot, #c9765a);
  }
  .gp.pro:hover,
  .gp.pro:focus-visible,
  .gp.pro.on {
    background: var(--b-hot, #c9765a);
    filter: brightness(0.92);
  }
  /* A call: hatched over its own time; projected, tentative and busy holds fainter. */
  .mt {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 4px;
    background: repeating-linear-gradient(135deg, rgb(var(--b-ink) / 0.24) 0 1px, transparent 1px 5px), rgb(var(--b-ink) / 0.03);
    cursor: default;
    transition: opacity 0.2s;
  }
  .mt:hover {
    background: repeating-linear-gradient(135deg, rgb(var(--b-ink) / 0.42) 0 1px, transparent 1px 5px), rgb(var(--b-ink) / 0.05);
  }
  .mt.proj,
  .mt.tent,
  .mt.busy {
    background: repeating-linear-gradient(135deg, rgb(var(--b-ink) / 0.13) 0 1px, transparent 1px 5px);
  }
  /* Calls already behind the needle step back. */
  .mt.done {
    opacity: 0.5;
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  /* Now: a thin ink needle with a dot on top, over the blocks. */
  .ndl {
    position: absolute;
    top: -5px;
    bottom: -3px;
    width: 1.5px;
    translate: -50% 0;
    border-radius: 1px;
    background: var(--b-t1);
    z-index: 2;
    pointer-events: none;
  }
  .ndl::before {
    content: "";
    position: absolute;
    top: -3px;
    left: 50%;
    width: 7px;
    height: 7px;
    translate: -50% 0;
    border-radius: 50%;
    background: var(--b-t1);
  }

  /* Captions: one per shown gap, in time order. In a one-row slot each starts under its own
     block (the columns come from captionLayout), hung from it by a thin stem. */
  .gaps {
    position: relative;
    flex: none;
    display: grid;
    margin-top: 12px;
  }
  .g {
    --stem: rgb(var(--b-ink) / 0.24);
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 7px;
    min-width: 0;
    padding: 0 14px 0 14px;
    border-radius: 0;
    cursor: default;
  }
  .g.pro {
    --stem: var(--b-hot, #c9765a);
  }
  /* The stem: from the block's foot down the caption's edge, just inside the block's
     rounded corner so the two meet. */
  .g::before {
    content: "";
    position: absolute;
    left: 3px;
    top: -12px;
    bottom: 1px;
    width: 1.5px;
    border-radius: 1px;
    background: var(--stem);
    transition: background 0.2s;
  }
  .g.moved::before {
    top: -6px;
  }
  /* Hung from the block's end: the stem on the right, the text reading back towards it. */
  .g.end {
    padding: 0 11px 0 14px;
    text-align: right;
  }
  .g.end::before {
    left: auto;
    right: 3px;
  }
  .g.end .mta {
    justify-content: flex-end;
  }
  .g:hover::before,
  .g:focus-visible::before,
  .g.on::before {
    background: rgb(var(--b-ink) / 0.6);
  }
  .g.pro:hover::before,
  .g.pro:focus-visible::before,
  .g.pro.on::before {
    background: var(--b-hot, #c9765a);
  }
  .g:focus-visible {
    outline: none;
  }
  /* The elbow: down from the block, across, down into the stem. --span is its run as a
     share of this caption's width. */
  .lk {
    position: absolute;
    top: -12px;
    left: 3px;
    width: calc(var(--span) * 100%);
    height: 6.75px;
    translate: -100% 0;
    background:
      linear-gradient(var(--stem), var(--stem)) left top / 1.5px 100% no-repeat,
      linear-gradient(var(--stem), var(--stem)) left bottom / 100% 1.5px no-repeat;
    pointer-events: none;
  }
  .lk.back {
    translate: 0 0;
    left: 3px;
    background:
      linear-gradient(var(--stem), var(--stem)) right top / 1.5px 100% no-repeat,
      linear-gradient(var(--stem), var(--stem)) left bottom / 100% 1.5px no-repeat;
  }
  /* Meta: mono caps, the protect chip first, then how long and when. */
  .mta {
    display: flex;
    align-items: center;
    gap: 0;
    min-width: 0;
    height: 18px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: var(--b-t3);
  }
  .du {
    flex: none;
    color: var(--b-t2);
  }
  .sep {
    white-space: pre;
  }
  .rg {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pr {
    flex: none;
    display: inline-flex;
    align-items: center;
    height: 18px;
    margin-right: 8px;
    padding: 0 7px;
    border-radius: 999px;
    font-style: normal;
    color: var(--b-on-hot, #fff);
    background: var(--b-hot, #c9765a);
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
  .fit,
  .note {
    margin-top: 3px;
    font-size: 12px;
    line-height: 1.35;
    color: var(--b-t3);
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .note {
    color: var(--b-t2);
  }
  .g:hover .tk,
  .g:focus-visible .tk,
  .g.on .tk {
    text-decoration: underline;
    text-decoration-color: rgb(var(--b-ink) / 0.3);
    text-underline-offset: 3px;
  }

  /* A tall slot: one caption a row, a soft ink tile, the stem down its left; task left,
     meta right. */
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .list .g {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 14px;
    padding: 8px 14px 8px 16px;
    border-radius: 6px;
    background: var(--b-row-bg, rgb(var(--b-ink) / 0.06));
    transition: background 0.2s;
  }
  .list .g:hover,
  .list .g:focus-visible,
  .list .g.on {
    background: var(--b-row-hover, rgb(var(--b-ink) / 0.1));
  }
  .list .g::before {
    left: 6px;
    top: 8px;
    bottom: 8px;
  }
  .list .mta {
    grid-area: 1 / 2;
  }
  .list .tx {
    grid-area: 1 / 1;
  }
  .list .tk {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
  .list .fit,
  .list .note {
    display: block;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* Four or five rows: one line each; the fit is in the hover. */
  .dense .g {
    padding-top: 9px;
    padding-bottom: 9px;
  }
  .dense .fit {
    display: none;
  }
  .list .g:hover .tk,
  .list .g:focus-visible .tk,
  .list .g.on .tk {
    text-decoration: none;
  }
</style>
