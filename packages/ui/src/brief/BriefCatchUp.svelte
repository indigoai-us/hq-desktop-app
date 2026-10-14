<script lang="ts">
  /**
   * Welcome back: the 10,000-ft view after days away. The top says how long you
   * were gone (a big light number, and an orbit from your last brief to today
   * with one dot per day, each peeking that day's numbers) and what moved (up
   * to four big numbers: the calls waiting on you first, then merged, meetings,
   * sessions). Under it, priority 1 is featured in the writer's words with its
   * why, its product and the start action; the rest of what changed follows as
   * a ranked list of glass rows, each with its peek and launch prompt, then
   * "+N more" whose peek lists the rest. What shipped is the merged number
   * (its peek lists products), not a row. The items are exactly what the
   * catalogue's measure() counted.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefOrigin from "./BriefOrigin.svelte";
  import { buildContext, rankDecisions } from "./brief-catalogue.js";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import {
    CATCH_UP_TILES,
    ORBIT,
    awayDays,
    catchUpGreet,
    catchUpLead,
    catchUpStats,
    catchUpTiles,
    moreTilesPeek,
    orbitPoint,
    type CatchUpTile,
    type HeroLead,
  } from "./brief-hero.js";
  import { briefPriorities } from "./brief-peeks.js";
  import { briefPrompts } from "./brief-prompts.js";
  import type { BriefDecision, BriefInput } from "./brief-types.js";

  interface Props {
    input: BriefInput;
    daysAway: number;
    /** Priority 1 in the writer's words. Left out: derived from the input; null: no lead line. */
    lead?: HeroLead | null;
    /** The decisions the catalogue ranked first (rankDecisions), top first; derived from the input when absent. */
    decisions?: BriefDecision[] | null;
    /** Launch prompts by item id (plan.prompts); derived from the input when absent. */
    prompts?: Record<string, string> | null;
  }
  let { input, daysAway, lead, decisions = null, prompts = null }: Props = $props();
  const brief = useBrief();
  const leadRow = $derived(lead === undefined ? (briefPriorities(input)[0] ?? null) : lead);
  const greet = $derived(catchUpGreet(input.lastBriefAt, input.now));
  const ranked = $derived(decisions ?? rankDecisions(buildContext(input)));
  const all = $derived(catchUpTiles(input, { decisions: ranked, prompts: prompts ?? briefPrompts(input) }));
  // What shipped is the merged number up top (its peek lists the products), not a row.
  const tiles = $derived(all.filter((t) => t.id !== "shipped"));
  const top = $derived(catchUpLead(tiles, leadRow));
  const others = $derived(tiles.filter((t) => t !== top?.tile));
  // Five items on the face (the featured one counts); "+N more" opens the rest in the peek.
  const room = $derived(CATCH_UP_TILES - (top?.tile ? 1 : 0));
  const shown = $derived(others.slice(0, room));
  const rest = $derived(others.slice(room));
  const stats = $derived(catchUpStats(input, ranked));
  const away = $derived(daysAway > 0 ? `${daysAway} day${daysAway === 1 ? "" : "s"} at a glance` : "what changed at a glance");

  // The orbit: one dot per day away, oldest at the bottom left, today filled at the top right.
  const days = $derived(awayDays(input, daysAway));
  const maxWeight = $derived(Math.max(1, ...days.map((d) => d.weight)));
  const dots = $derived(
    days.map((d, i) => {
      const [x, y] = orbitPoint(0.04 + (0.96 * i) / days.length);
      return { ...d, x, y, size: Math.round(7 + (5 * d.weight) / maxWeight) };
    }),
  );
  const todayAt = orbitPoint(1);
  const startAt = orbitPoint(0.04);
  const p = (pt: readonly number[]) => `${pt[0]} ${pt[1]}`;
  const orbitPath = `M ${p(ORBIT.p0)} C ${p(ORBIT.p1)}, ${p(ORBIT.p2)}, ${p(ORBIT.p3)}`;

  const decisionOf = (t: CatchUpTile | null) => (t ? (ranked.find((d) => d.id === t.id) ?? null) : null);
  const leadDecision = $derived(decisionOf(top?.tile ?? null));
  const leadPrompt = $derived(top?.tile?.peek.prompt ?? null);
  const showSub = (t: CatchUpTile) => !!t.sub && !t.origins.some((o) => o.product === t.sub || o.repo === t.sub);
  const rank = (i: number) => String(i + (top ? 2 : 1)).padStart(2, "0");
</script>

<div class="w" data-testid="brief-catchup">
  <div class="eyebrow">Welcome back · {away}</div>
  <div class="cu">
    <div class="sum">
      <p class="greet" data-testid="brief-catchup-greet">{greet}</p>
      <div class="away">
        {#if daysAway > 0}
          <div class="num"><span class="big" data-testid="brief-catchup-days">{daysAway}</span><span class="unit">{daysAway === 1 ? "day" : "days"} away</span></div>
        {/if}
        <div class="orbit" data-testid="brief-catchup-orbit">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path class="o2" d="M 0 94 C 34 90, 62 56, 76 0" />
            <path class="o1" d={orbitPath} />
          </svg>
          {#each dots as d, i (d.date)}
            {#if d.peek}
              {@const content = d.peek}
              <span
                class="dot"
                style="left:{d.x}%;top:{d.y}%;--d:{d.size}px;--i:{i}"
                role="button"
                tabindex="0"
                aria-label={content.title}
                data-testid="brief-catchup-day"
                use:peek={{ state: brief, content: () => content }}
              ><i></i><b>{d.tag}</b></span>
            {:else}
              <span class="dot" style="left:{d.x}%;top:{d.y}%;--d:{d.size}px;--i:{i}" data-testid="brief-catchup-day"><i></i><b>{d.tag}</b></span>
            {/if}
          {:else}
            <!-- Not away a full day: the curve runs from the last brief to now. -->
            <span class="dot" style="left:{startAt[0]}%;top:{startAt[1]}%"><i></i><b>Last brief</b></span>
          {/each}
          <span class="dot now" style="left:{todayAt[0]}%;top:{todayAt[1]}%;--i:{dots.length}"><i></i><b>Today</b></span>
        </div>
      </div>
      {#if stats.length}
        <div class="stats" data-testid="brief-catchup-stats">
          {#each stats as s (s.key)}
            {#if s.peek}
              {@const content = s.peek}
              <div class="st" class:focus={s.focus} role="button" tabindex="0" aria-label={`${s.value} ${s.label.toLowerCase()}`} data-testid="brief-catchup-stat" data-stat={s.key} use:peek={{ state: brief, content: () => content, place: "below" }}>
                <span class="sl">{s.label}</span><span class="sv">{s.value}</span>
              </div>
            {:else}
              <div class="st" class:focus={s.focus} data-testid="brief-catchup-stat" data-stat={s.key}><span class="sl">{s.label}</span><span class="sv">{s.value}</span></div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>

    <div class="items">
      {#if top}
        {@const t = top.tile}
        {#if t}
          <div
            class="lead"
            class:done={brief.cleared[t.id]}
            role="group"
            aria-label={top.text}
            data-testid="brief-catchup-tile"
            data-featured="true"
            data-tone={t.tone}
            use:peek={{ state: brief, content: () => t.peek }}
          >
            <div class="lh">
              <span class="kick">Start here</span>
              <span class="tag tone-{t.tone}">{t.tag}</span>
              {#if t.origins.length}<span class="lo"><BriefOrigin origin={t.origins[0]!} product /></span>{/if}
            </div>
            <div class="lt" data-testid="brief-catchup-lead">{top.text}</div>
            {#if top.because}<div class="first" data-testid="brief-catchup-first">{top.because}</div>{/if}
            {#if leadPrompt}
              <div class="la">
                {#if brief.cleared[t.id]}
                  <span class="donechip">Done</span>
                {:else}
                  <BriefLaunch id={leadPrompt.id} prompt={leadPrompt.text} choices={leadDecision?.action === "decide" ? (leadDecision.choices ?? null) : null} />
                {/if}
                {#if brief.notes[leadPrompt.id]}<span class="launch-note" role="status">{brief.notes[leadPrompt.id]}</span>{/if}
              </div>
            {/if}
          </div>
        {:else}
          <!-- Priority 1 with no item behind it on this card: the writer's words and why. -->
          <div class="lead" role="group" aria-label={top.text} data-featured="true">
            <div class="lh"><span class="kick">Start here</span></div>
            <div class="lt" data-testid="brief-catchup-lead">{top.text}</div>
            {#if top.because}<div class="first" data-testid="brief-catchup-first">{top.because}</div>{/if}
          </div>
        {/if}
      {/if}

      {#if shown.length}
        <div class="list">
          {#each shown as t, i (t.id)}
            <div class="row" role="group" aria-label={t.text} data-testid="brief-catchup-tile" data-tone={t.tone} use:peek={{ state: brief, content: () => t.peek }}>
              <span class="rk">{rank(i)}</span>
              <span class="rt">
                <span class="tx">{t.text}</span>
                {#if showSub(t)}<span class="ts">{t.sub}</span>{/if}
              </span>
              {#if t.origins.length}
                <span class="orgs">{#each t.origins.slice(0, 2) as o, j (`${o.companyUid ?? ""}:${o.repo ?? ""}:${o.product ?? ""}:${j}`)}<BriefOrigin origin={o} product />{/each}</span>
              {/if}
              <span class="tag tone-{t.tone}">{t.tag}</span>
            </div>
          {/each}
          {#if rest.length}
            <div class="row more" role="button" tabindex="0" data-testid="brief-catchup-more" use:peek={{ state: brief, content: () => moreTilesPeek(rest) }}>+{rest.length} more</div>
          {/if}
        </div>
      {/if}

      {#if !all.length}
        <p class="sub quiet" data-testid="brief-catchup-quiet">Nothing broke, nothing waits on you, and nothing shipped while you were away.</p>
      {/if}
    </div>
  </div>
  <p class="sub end">Everything else can wait for a normal brief tomorrow.</p>
</div>

<style>
  .w {
    container: catchup / inline-size;
  }
  .cu {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .sum {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* The featured block sits in the list's rhythm: the same 6px gap as the rows under it. */
  .items {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* How long you were gone: a big light number with a small unit, the orbit to its right. */
  .away {
    position: relative;
    flex: 1 1 auto;
    min-height: 96px;
    margin-top: 12px;
    display: flex;
    align-items: flex-end;
  }

  .num {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: baseline;
    gap: 8px;
    white-space: nowrap;
  }
  .big {
    font-size: 72px;
    font-weight: 300;
    line-height: 0.82;
    letter-spacing: -0.045em;
    color: #fff;
    font-variant-numeric: tabular-nums;
  }
  .unit {
    font-size: 15px;
    font-weight: 400;
    color: rgb(var(--b-ink) / 0.82);
  }
  /* What changed, as the card's soft title: it says since when; the featured block names the lead. */
  .greet {
    margin: 0;
    max-width: 30ch;
    font-size: var(--b-fs-title-lg);
    font-weight: 500;
    line-height: 1.25;
    letter-spacing: -0.015em;
    color: #fff;
    text-wrap: balance;
  }


  /* The orbit: a thin white curve from your last brief to today, a fainter dashed one
     beside it, hollow day dots sized by how busy each day was, today filled. */
  .orbit {
    position: absolute;
    top: 6px;
    bottom: 10px;
    left: max(34%, 200px);
    right: 6px;
  }
  .orbit svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    fill: none;
  }
  .orbit path {
    vector-effect: non-scaling-stroke;
    stroke-linecap: round;
  }
  .o1 {
    stroke: rgb(var(--b-ink) / 0.55);
    stroke-width: 1;
  }
  .o2 {
    stroke: rgb(var(--b-ink) / 0.28);
    stroke-width: 1;
    stroke-dasharray: 2 5;
  }
  .dot {
    position: absolute;
    width: 28px;
    height: 28px;
    margin: -14px 0 0 -14px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    outline: none;
    animation: dot-in 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    animation-delay: calc(0.35s + var(--i, 0) * 0.07s);
  }
  .dot i {
    box-sizing: border-box;
    width: var(--d, 8px);
    height: var(--d, 8px);
    border-radius: 50%;
    border: 1.5px solid rgb(var(--b-ink) / 0.9);
    transition: background 0.2s, transform 0.2s;
  }
  .dot[role="button"] {
    cursor: default;
  }
  .dot[role="button"]:hover i,
  .dot[role="button"]:focus-visible i {
    background: #fff;
    transform: scale(1.25);
  }
  .dot b {
    position: absolute;
    top: 100%;
    left: 50%;
    translate: -50% -2px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: rgb(var(--b-ink) / 0.72);
  }
  .dot.now i {
    width: 11px;
    height: 11px;
    border: 0;
    background: #fff;
    box-shadow: 0 0 0 5px rgb(var(--b-ink) / 0.22);
  }
  /* Today sits at the top end of the curve: its label goes to the left, clear of the line. */
  .dot.now b {
    top: 50%;
    left: auto;
    right: 100%;
    translate: 0 -50%;
    color: #fff;
  }
  @keyframes dot-in {
    from {
      opacity: 0;
      transform: scale(0.4);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }

  /* What moved: label over a big light number; the calls waiting on you read first, the rest quieter. */
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
    gap: 4px;
    margin: 16px -12px 0;
  }
  .st {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px 12px;
    border-radius: 10px;
    outline: none;
    transition: background 0.2s;
  }
  .st[role="button"]:hover,
  .st[role="button"]:focus-visible {
    background: rgb(var(--b-ink) / 0.12);
  }
  .sl {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: rgb(var(--b-ink) / 0.68);
  }
  .sv {
    font-size: 34px;
    font-weight: 300;
    line-height: 1;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
    color: rgb(var(--b-ink) / 0.74);
  }
  .st.focus .sl {
    color: rgb(var(--b-ink) / 0.9);
  }
  .st.focus .sv {
    color: #fff;
  }

  /* Priority 1, featured: a mono kicker, the writer's words large, why, then start. */
  .lead {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px 18px 18px;
    border-radius: 12px;
    background: rgb(var(--b-ink) / 0.16);
    transition: background 0.25s;
    outline: none;
  }
  .lead:hover,
  .lead:focus-within {
    background: rgb(var(--b-ink) / 0.22);
  }
  .lh {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    min-height: 20px;
  }
  .kick,
  .tag,
  .rk,
  .more {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .kick {
    flex: none;
    height: 20px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    border-radius: 6px;
    color: #fff;
    background: rgb(var(--b-ink) / 0.2);
  }
  .tag {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: rgb(var(--b-ink) / 0.72);
  }
  .lo {
    flex: none;
    margin-left: auto;
  }
  .lo :global(.org.product b),
  .orgs :global(.org.product b) {
    font-size: 12px;
    color: rgb(var(--b-ink) / 0.85);
  }
  .lt {
    margin-top: 6px;
    font-size: 24px;
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: -0.02em;
    color: #fff;
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
  .first {
    font-size: 14px;
    line-height: 1.4;
    color: rgb(var(--b-ink) / 0.82);
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .lead.done .lt {
    text-decoration: line-through;
    text-decoration-color: rgb(var(--b-ink) / 0.5);
  }
  .la {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 10px;
  }
  /* The start control on the glass: mono caps, soft white at rest, solid white on hover. */
  .la :global(.launch) {
    gap: 4px;
    text-shadow: none;
  }
  .la :global(.launch .go) {
    height: 30px;
    padding: 0 12px;
    border-radius: 6px;
    color: #fff;
    background: rgb(var(--b-ink) / 0.24);
    box-shadow: none;
    transition: background 0.15s, color 0.15s;
  }
  .la :global(.launch .go:hover),
  .la :global(.launch .go:focus-visible),
  .la :global(.launch .go.choice:is(:hover, :focus-within)) {
    color: #18181b;
    background: #fff;
    outline: none;
  }
  .la :global(.launch .eng) {
    height: 30px;
    border-radius: 6px;
    background: rgb(var(--b-ink) / 0.14);
  }
  .la :global(.launch .eng button) {
    border-radius: 4px;
    color: rgb(var(--b-ink) / 0.7);
  }
  .la :global(.launch .eng button:hover) {
    color: #fff;
  }
  .la :global(.launch .eng button[aria-pressed="true"]) {
    background: rgba(255, 255, 255, 0.95);
    color: #4a2a6e;
  }
  .la :global(.launch .copy) {
    border-radius: 6px;
    background: rgb(var(--b-ink) / 0.14);
    color: rgb(var(--b-ink) / 0.85);
  }
  .la :global(.launch .copy:hover) {
    background: rgb(var(--b-ink) / 0.24);
    color: #fff;
  }
  .la :global(.launch-note) {
    margin: 0;
  }
  .donechip {
    height: 30px;
    padding: 0 12px;
    display: inline-flex;
    align-items: center;
    border-radius: 6px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #fff;
    background: rgb(var(--b-ink) / 0.2);
  }

  /* The rest, ranked: glass rows with a mono rank, the title (and a quiet line), product, kind. */
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto auto;
    align-items: center;
    column-gap: 12px;
    min-height: 44px;
    box-sizing: border-box;
    padding: 8px 14px 8px 12px;
    border-radius: 10px;
    background: rgb(var(--b-ink) / 0.12);
    transition: background 0.2s;
    outline: none;
  }
  .row:hover,
  .row:focus-visible {
    background: rgb(var(--b-ink) / 0.2);
  }
  .rk {
    color: rgb(var(--b-ink) / 0.55);
  }
  .rt {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tx {
    font-size: 14px;
    font-weight: 500;
    line-height: 1.3;
    color: #fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ts {
    font-size: 12px;
    line-height: 1.3;
    color: rgb(var(--b-ink) / 0.72);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .orgs {
    display: flex;
    gap: 10px;
    min-width: 0;
  }
  .row .tag {
    justify-self: end;
  }
  /* A live incident is the one row that earns the hot dot. */
  .row[data-tone="red"] .tag::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 6px;
    border-radius: 50%;
    vertical-align: 1px;
    background: var(--b-hot);
    box-shadow: 0 0 0 1.5px rgb(var(--b-ink) / 0.9);
  }
  .row.more {
    display: flex;
    justify-content: center;
    min-height: 32px;
    padding: 6px 12px;
    color: rgb(var(--b-ink) / 0.78);
    background: transparent;
    cursor: default;
  }
  .row.more:hover,
  .row.more:focus-visible {
    background: rgb(var(--b-ink) / 0.12);
  }
  .quiet {
    margin: 0;
    color: rgb(var(--b-ink) / 0.82);
  }
  .end {
    margin: 0;
    padding-top: 16px;
    font-size: 12px;
    color: rgb(var(--b-ink) / 0.7);
  }

  /* A narrower card: the row's product steps aside (its peek still names it). */
  @container catchup (max-width: 620px) {
    .orgs {
      display: none;
    }
    .big {
      font-size: 60px;
    }
  }
  /* The full-width hero (the card alone on a quiet catch-up): the numbers on the left,
     the featured call and the list on the right. */
  @container catchup (min-width: 960px) {
    .cu {
      flex-direction: row;
      gap: 28px;
    }
    .sum {
      flex: 1 1 0;
    }
    .items {
      flex: 1.15 1 0;
      justify-content: flex-start;
    }
  }
</style>
