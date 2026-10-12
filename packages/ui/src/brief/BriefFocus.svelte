<script lang="ts">
  /**
   * Where your day went: your own sessions from the last 24 hours, grouped by
   * product as glass tiles laid out like a treemap. The busiest product takes
   * the tall left tile and carries a 3 px ice bar at its share; every tile
   * shows the company logo, the product's human name and a mono session
   * count. Hovering a tile slides in up to five plain session titles, each
   * with the session peek (Resume in <engine>, Copy prompt, company chip).
   * Five product tiles at most, then a "+N more" tile whose peek lists the
   * rest. The footer counts context switches and gives the first and last
   * start. Only your sessions inside the brief's companies are counted or
   * named. Same gate as the picker's focus entry (3+ sessions across 2+
   * products): below it the card renders nothing.
   */
  import BriefLogo from "./BriefLogo.svelte";
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { FOCUS_CAP, focusSummary, hasFocus, sessionLabel, tileLayout, type FocusGroup } from "./brief-focus.js";
  import { clockLabel } from "./brief-time.js";
  import { sessionPeek } from "./brief-timeline.js";
  import type { BriefSession } from "./brief-types.js";

  interface Props {
    /** Sessions of the brief's window (recentSessions, else sessions); the card keeps your own inside `companies`. */
    sessions: BriefSession[];
    /** Company uids or slugs the brief may detail. */
    companies: string[];
    /** ISO time of the brief: the end of the 24-hour window. */
    now: string;
    cols: number;
    rows: number;
  }
  let { sessions, companies, now, cols, rows }: Props = $props();
  const brief = useBrief();

  const sum = $derived(focusSummary(sessions, companies, now));
  const show = $derived(hasFocus(sum));
  const shown = $derived(sum.groups.slice(0, FOCUS_CAP));
  const rest = $derived(sum.groups.slice(FOCUS_CAP));
  const restSessions = $derived(rest.reduce((n, g) => n + g.count, 0));
  const tiles = $derived(shown.length + (rest.length ? 1 : 0));
  const layout = $derived(tileLayout(tiles));
  // A one-row slot (W) keeps the tiles shallower; the card still sets its own height.
  const tall = $derived(rows > 1 || cols >= 3);

  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /** The session card (Resume, Copy prompt) for one title in a tile. */
  const titlePeek = (g: FocusGroup, s: BriefSession, i: number): PeekContent =>
    sessionPeek({ at: s.startedAt, title: sessionLabel(s.title), id: s.id, company: s.company }, i, g.sessions.length);

  /** Titles past the fifth in one product. */
  const moreTitlesPeek = (g: FocusGroup): PeekContent => ({
    title: `${g.sessions.length - FOCUS_CAP} more in ${g.name}`,
    status: plural(g.sessions.length, "session"),
    sections: [{ label: "Also", lines: g.sessions.slice(FOCUS_CAP).map((s) => ({ label: sessionLabel(s.title), state: clockLabel(s.startedAt) })) }],
  });

  /** Products past the fifth tile. */
  const moreTilesPeek = (): PeekContent => ({
    title: `${rest.length} more ${rest.length === 1 ? "product" : "products"}`,
    status: plural(restSessions, "session"),
    sections: [{ label: "Also", lines: rest.map((g) => ({ label: g.name, state: plural(g.count, "session") })) }],
  });
</script>

{#if show}
  <div class="w" class:tall data-testid="brief-focus" data-sessions={sum.total} data-products={sum.groups.length}>
    <div class="eyebrow">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="17" rx="2" /><rect x="14.5" y="3.5" width="6" height="7" rx="2" /><rect x="14.5" y="13.5" width="6" height="7" rx="2" /></svg>
      Where your day went · {plural(sum.total, "session")}
    </div>
    <h3 data-testid="brief-focus-head">{sum.headline}</h3>
    <div class="tm" style="--tm-cols:{layout.columns};--tm-rows:{layout.rows}">
      {#each shown as g, i (g.name)}
        <div
          class="tile"
          class:lead={i === 0 && layout.spanFirst}
          class:wide={layout.spanLast && i === tiles - 1}
          data-testid="brief-focus-tile"
          data-product={g.name}
          data-count={g.count}
        >
          <div class="id">
            <BriefLogo company={brief.company(g.company)} fallback={g.company ?? g.name} size={18} />
            <b>{g.name}</b>
          </div>
          <span class="n">{plural(g.count, "session")}</span>
          <div class="ss">
            {#each g.sessions.slice(0, FOCUS_CAP) as s, j (s.id)}
              <button type="button" class="st" data-testid="brief-focus-session" use:peek={{ state: brief, content: () => titlePeek(g, s, j) }}>{sessionLabel(s.title)}</button>
            {/each}
            {#if g.sessions.length > FOCUS_CAP}
              <button type="button" class="st more" data-testid="brief-focus-session-more" use:peek={{ state: brief, content: () => moreTitlesPeek(g) }}
                >+{g.sessions.length - FOCUS_CAP} more</button
              >
            {/if}
          </div>
          {#if i === 0}<i class="bar" style="width:{Math.round(g.share * 100)}%" data-testid="brief-focus-bar" aria-hidden="true"></i>{/if}
        </div>
      {/each}
      {#if rest.length}
        <div
          class="tile rest"
          class:wide={layout.spanLast}
          role="group"
          aria-label="{rest.length} more {rest.length === 1 ? 'product' : 'products'}"
          data-testid="brief-focus-more"
          use:peek={{ state: brief, content: moreTilesPeek }}
        >
          <b>+{rest.length} more</b>
          <span class="n">{plural(restSessions, "session")}</span>
        </div>
      {/if}
    </div>
    <div class="foot" data-testid="brief-focus-foot">
      <span>{plural(sum.switches, "context switch", "context switches")}</span>
      {#if sum.first && sum.last}<span>first {clockLabel(sum.first)} · last {clockLabel(sum.last)}</span>{/if}
    </div>
  </div>
{/if}

<style>
  .tm {
    flex: 1;
    display: grid;
    gap: 6px;
    margin-top: 12px;
    min-height: 0;
    grid-template-columns: var(--tm-cols, 2fr 1fr 1fr);
    grid-template-rows: repeat(var(--tm-rows, 2), minmax(64px, 1fr));
  }
  .tall .tm {
    grid-template-rows: repeat(var(--tm-rows, 2), minmax(78px, 1fr));
  }
  .tile {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    border-radius: 14px;
    padding: 9px 11px 10px;
    /* Glass: lit from the top, hairline rim, soft drop. No inner shadow and no
       backdrop-filter (WKWebView draws it as a square that ignores the radius). */
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.025) 42%, rgba(255, 255, 255, 0.015)),
      radial-gradient(120% 60% at 20% 0%, rgba(255, 255, 255, 0.06), transparent 60%);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-top-color: rgba(255, 255, 255, 0.18);
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.3),
      0 8px 20px -8px rgba(0, 0, 0, 0.5);
    transition: background 0.3s;
  }
  .tile:hover,
  .tile:focus-within {
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.13), rgba(255, 255, 255, 0.05) 42%, rgba(255, 255, 255, 0.03)),
      radial-gradient(120% 60% at 20% 0%, rgba(255, 255, 255, 0.08), transparent 60%);
  }
  .tile.lead {
    grid-row: span 2;
  }
  .tile.wide {
    grid-column: span 2;
  }
  .id {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .id b {
    font-size: 12.5px;
    font-weight: 500;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .n {
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
    transition: opacity 0.3s;
  }
  /* The session titles slide in over the count line; the name and logo stay. */
  .ss {
    position: absolute;
    left: 11px;
    right: 11px;
    top: 30px;
    bottom: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 1px;
    opacity: 0;
    translate: 0 6px;
    pointer-events: none;
    transition: opacity 0.3s, translate 0.3s;
  }
  .tile:hover .ss,
  .tile:focus-within .ss {
    opacity: 1;
    translate: 0 0;
    pointer-events: auto;
  }
  .tile:hover .n,
  .tile:focus-within .n {
    opacity: 0;
  }
  .st {
    all: unset;
    display: block;
    max-width: 100%;
    font-size: 10.5px;
    line-height: 1.35;
    color: var(--b-t2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: default;
  }
  .st:hover,
  .st:focus-visible {
    color: #fff;
  }
  .st.more {
    color: var(--b-t3);
  }
  .bar {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 3px;
    background: var(--b-ice);
    opacity: 0.6;
    pointer-events: none;
  }
  .rest {
    justify-content: center;
    cursor: default;
  }
  .rest b {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--b-t2);
  }
</style>
