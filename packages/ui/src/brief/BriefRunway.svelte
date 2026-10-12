<script lang="ts">
  /**
   * Focus time: where today's one clear block is, which priority fits it, and
   * that it is worth protecting. The runway runs 8:00 to 18:00: every call is
   * a glass pill (dashed when projected, hatched when a busy hold), and the
   * padded gaps between them are classed deep / solid / shallow. The longest
   * gap carries a soft outer glow and takes priority 1; the next gap takes
   * priority 2, and so on. Hover a gap for its neighbours, the suggested
   * task, Start in <engine>, and an event draft that blocks it (copied to the
   * clipboard; the brief never writes the calendar).
   */
  import { copyBriefPrompt, peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { humanTitle } from "./brief-distill.js";
  import {
    calendarDraft,
    clockMin,
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
      <div
        class="mt"
        class:proj={p.event.projected}
        class:busy={p.event.busy}
        class:tent={p.event.tentative}
        role="group"
        aria-label="{p.event.busy ? 'Busy' : p.event.title}, {rangeText(p.event)}"
        data-testid="brief-runway-pill"
        style="left:{pct(p.startMin)}%;width:{Math.max(2.2, pct(p.endMin) - pct(p.startMin))}%"
        use:peek={{ state: brief, content: () => pillPeek(p) }}
      >{#if !p.event.busy}<span>{p.event.title}</span>{/if}</div>
    {/each}
    {#if needle != null}<div class="ndl" data-testid="brief-runway-now" style="left:{needle}%"></div>{/if}
  </div>
  <div class="rul" aria-hidden="true">
    {#each RULER_HOURS as h (h)}
      <span class:first={h === RULER_HOURS[0]} class:last={h === RULER_HOURS[RULER_HOURS.length - 1]} style="left:{pct(h * 60)}%">{clockMin(h * 60)}</span>
    {/each}
  </div>

  {#if shown.length}
    <div class="gaps" style="--n:{rows > 1 ? 1 : shown.length}">
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
          <b>{gapLabel(g)}{#if g.rank === 1}<em class="pr">protect</em>{/if}</b>
          <div class="tk" data-testid="brief-runway-task">{task(g) ?? "Unassigned"}</div>
          {#if rows > 1 && p?.because}<div class="fit">{p.because}</div>{/if}
          {#if copied === g.id}<div class="note" role="status">Event draft copied</div>{/if}
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
  .tag {
    flex: none;
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.04em;
    padding: 3px 7px;
    border-radius: 6px;
    border: 1px solid var(--b-line);
    color: var(--b-t3);
    white-space: nowrap;
    cursor: default;
  }

  /* The runway: a flat glass track. Shadows fall outward only; no blur filters. */
  .rw {
    position: relative;
    height: 46px;
    margin-top: 14px;
    border-radius: 14px;
    background: rgba(0, 0, 0, 0.22);
    border: 1px solid rgba(255, 255, 255, 0.06);
  }
  .gp {
    position: absolute;
    top: 5px;
    bottom: 5px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    cursor: default;
    transition: background 0.2s, border-color 0.2s, box-shadow 0.2s;
  }
  .gp.deep {
    background: rgba(255, 255, 255, 0.06);
  }
  .gp.solid {
    background: rgba(255, 255, 255, 0.035);
  }
  .gp.shallow {
    background: transparent;
    border-color: rgba(255, 255, 255, 0.05);
  }
  .gp:hover,
  .gp:focus-visible {
    border-color: rgba(255, 255, 255, 0.3);
    outline: none;
  }
  /* The one to protect: a green edge. */
  .gp.pro {
    border-color: rgba(52, 199, 89, 0.5);
    box-shadow: none;
  }
  .gp.pro:hover,
  .gp.pro:focus-visible {
    border-color: rgba(52, 199, 89, 0.8);
    box-shadow: none;
  }
  /* Calls: raised glass pills, no colour. */
  .mt {
    position: absolute;
    top: 9px;
    bottom: 9px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: none;
    font-family: var(--b-mono);
    font-size: 9px;
    color: var(--b-t2);
    display: grid;
    place-items: center;
    overflow: hidden;
    white-space: nowrap;
    padding: 0 5px;
    cursor: default;
    z-index: 1;
  }
  .mt span {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .mt.proj {
    background: rgba(255, 255, 255, 0.03);
    border: 1px dashed rgba(255, 255, 255, 0.35);
    box-shadow: none;
    color: var(--b-t3);
  }
  .mt.tent {
    border-style: dashed;
  }
  .mt.busy {
    background: repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0 3px, transparent 3px 7px);
    box-shadow: none;
  }
  .ndl {
    position: absolute;
    top: -4px;
    bottom: -4px;
    width: 1px;
    background: #fff;
    box-shadow: 0 0 6px #fff;
    z-index: 2;
    pointer-events: none;
  }
  .rul {
    position: relative;
    height: 14px;
    margin-top: 4px;
    font-family: var(--b-mono);
    font-size: 9px;
    color: var(--b-t3);
  }
  .rul span {
    position: absolute;
    translate: -50% 0;
  }
  .rul span.first {
    translate: 0 0;
  }
  .rul span.last {
    translate: -100% 0;
  }

  /* Ranked gaps: glass tiles, three across in a one-row slot, a list in a tall one. */
  .gaps {
    display: grid;
    grid-template-columns: repeat(var(--n, 3), minmax(0, 1fr));
    gap: 8px;
    margin-top: 10px;
  }
  .g {
    position: relative;
    min-width: 0;
    padding: 8px 10px;
    border-radius: 12px;
    font-size: 11.5px;
    line-height: 1.3;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.09);
    box-shadow: none;
    cursor: default;
    transition: border-color 0.2s, background 0.2s;
  }
  .g:hover,
  .g:focus-visible {
    border-color: rgba(255, 255, 255, 0.22);
    outline: none;
  }
  .g.pro {
    border-color: rgba(52, 199, 89, 0.35);
  }
  .g b {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
    font-family: var(--b-mono);
    font-size: 10.5px;
    letter-spacing: 0.02em;
    white-space: nowrap;
    overflow: hidden;
  }
  .pr {
    font-style: normal;
    font-size: 8.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--b-ok);
  }
  .tk {
    color: var(--b-t1);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fit {
    color: var(--b-t2);
    font-size: 10.5px;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    margin-top: 3px;
    font-size: 10.5px;
    color: var(--b-ok);
  }
  .more {
    margin-top: 8px;
    text-align: center;
    padding: 5px 12px;
    border-radius: 10px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.78);
    cursor: default;
  }
  .more:hover,
  .more:focus-visible {
    background: rgba(255, 255, 255, 0.045);
    outline: none;
  }
</style>
