<script lang="ts">
  /**
   * What you shipped yesterday: one glass tile per product (never per repo),
   * each with the product's logo, how much merged, and a plain line worth
   * knowing. Holographic foil = an achievement; the edge follows your pointer.
   * A first-of-its-kind ship says so in its peek (the Firsts card celebrates it); the flame counts consecutive
   * landing days. At most five tiles, then a "+N more" tile peeking the rest.
   */
  import BriefOrigin from "./BriefOrigin.svelte";
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { mergeMedianText, shippedStreak, shippedTiles, streakTitle, type ShippedTile } from "./brief-distill.js";
  import { productName } from "./brief-origin.js";
  import { countUp } from "./count-up.js";
  import type { BriefInput, BriefLine, BriefShipped } from "./brief-types.js";

  interface Props {
    shipped: BriefShipped[];
    merged: number | null;
    opened: number | null;
    cols: number;
    rows: number;
    prWindow?: BriefInput["prWindow"];
    /** Local dates (YYYY-MM-DD) with a landing, newest last; two or more in a row light the streak. */
    landedDays?: string[] | null;
    /** YYYY-MM-DD of the brief, so a streak that lapsed before yesterday stays off. */
    today?: string | null;
  }
  let { shipped, merged, opened, cols, rows, prWindow = null, landedDays = null, today = null }: Props = $props();
  const brief = useBrief();
  const tall = $derived(rows > 1);
  const tiles = $derived(shippedTiles(shipped));
  // L shows five tiles, M and W3 three, W two; the rest fold into one "+N more" tile.
  const cap = $derived(tall ? (cols >= 3 ? 5 : 3) : cols >= 3 ? 3 : 2);
  const shown = $derived(tiles.slice(0, cap));
  const rest = $derived(tiles.slice(shown.length));
  const cells = $derived(shown.length + (rest.length ? 1 : 0));
  // One-row cards keep every tile on one line; tall cards wrap at three (L) or two (M) columns.
  const gridCols = $derived(Math.max(1, tall ? Math.min(cols >= 3 ? 3 : 2, cells) : cells));
  // In one row, "+N more" is a slim column at the end rather than a full tile.
  const gridTemplate = $derived(!tall && rest.length ? `repeat(${shown.length}, minmax(0, 1fr)) 76px` : `repeat(${gridCols}, minmax(0, 1fr))`);
  // Each tile lists what was worth knowing under its count, as many as its height holds (up to five);
  // a short card simply shows fewer.
  const lines = 5;
  /** "Oct 4 – Oct 8" from two YYYY-MM-DD dates. */
  const dayRange = (from: string, to: string) => {
    const f = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${f(from)} – ${f(to)}`;
  };
  const streak = $derived(shippedStreak(landedDays, today));
  const total = $derived(merged ?? tiles.reduce((n, t) => n + t.merged, 0));

  function tilePeek(t: ShippedTile): PeekContent {
    const sections: PeekContent["sections"] = [];
    if (t.highlights.length) sections.push({ label: "Worth knowing", lines: t.highlights });
    const pace: BriefLine[] = [];
    if (t.release) pace.push({ label: t.release, state: "RELEASE", tone: "ok" });
    const median = mergeMedianText(t.mergeHoursMedian);
    if (median) pace.push({ label: median, state: "", tone: "neutral" });
    if (pace.length) sections.push({ label: "Pace", lines: pace });
    const status = [t.mix || t.why || "", t.first ? "a first" : ""].filter(Boolean).join(" · ");
    return {
      sample: t.sample,
      eyebrow: "Shipped · yesterday",
      origin: { companyUid: t.origin.companyUid, label: t.product },
      title: `${t.product} · ${t.headline}`,
      status: status || undefined,
      sections,
    };
  }

  const morePeek = (): PeekContent => ({
    title: `${rest.length} more product${rest.length === 1 ? "" : "s"}`,
    status: "Also shipped yesterday",
    sections: [{ label: "Products", lines: rest.map((t) => ({ label: t.product, state: t.headline, tone: "ok" as const, ...(t.first ? { tag: "first" } : {}) })) }],
  });

  /** The window's PRs by product, biggest first; repos that share a product add up. */
  function byProduct(win: NonNullable<BriefInput["prWindow"]>): BriefLine[] {
    const m = new Map<string, { total: number; merged: number }>();
    for (const r of win.byRepo) {
      const p = productName(r.repo);
      const cur = m.get(p) ?? { total: 0, merged: 0 };
      m.set(p, { total: cur.total + r.total, merged: cur.merged + r.merged });
    }
    return [...m]
      .sort((a, b) => b[1].merged - a[1].merged || a[0].localeCompare(b[0]))
      .map(([p, v]) => ({ label: p, state: `${v.merged}/${v.total}`, tone: "ok" as const }));
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /** "2026-10-11" as "Oct 11"; anything else as given. */
  function dayLabel(day: string): string {
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(day);
    return m ? `${MONTHS[Number(m[1]) - 1] ?? m[1]} ${Number(m[2])}` : day;
  }

  function track(event: PointerEvent): void {
    const el = event.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--hx", `${((event.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty("--hy", `${((event.clientY - r.top) / r.height) * 100}%`);
    el.style.setProperty("--ang", `${(Math.atan2(event.clientY - r.top - r.height / 2, event.clientX - r.left - r.width / 2) * 180) / Math.PI + 90}deg`);
  }
</script>

<div class="w c-green" data-testid="brief-shipped">
  <div class="top">
    <div>
      <div class="eyebrow">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg> Run complete · yesterday
      </div>
      <h3>
        What you shipped{#if streak}<span class="streak" data-testid="brief-shipped-streak"
            ><svg viewBox="0 0 12 14" aria-hidden="true"><path d="M6 0C7 3 10 5 10 9a4 4 0 0 1-8 0c0-2 1-3 2-4 0 2 1 3 2 3-1-3 0-6 0-8z" /></svg>{streak.days} days</span
          >{/if}
      </h3>
      {#if prWindow}
        {@const win = prWindow}
        <div
          class="win"
          role="group"
          aria-label="PRs in the window"
          use:peek={{
            state: brief,
            content: () => ({
              title: `${win.total} PRs · ${win.merged} merged`,
              status: `${dayLabel(win.from)} to ${dayLabel(win.to)}`,
              sections: [{ label: "By product", lines: byProduct(win) }],
            }),
          }}
        >{dayRange(win.from, win.to)} · {win.total} PRs</div>
      {/if}
    </div>
    <div class="tot">
      <div><span class="big" use:countUp={total}>0</span><small>merged</small></div>
      {#if opened != null}<div><span class="big dim" use:countUp={opened}>0</span><small>opened</small></div>{/if}
    </div>
  </div>
  {#if tiles.length}
    <div class="runs" class:one={!tall} style="grid-template-columns:{gridTemplate}">
      {#each shown as t (t.key)}
        <div
          class="run"
          role="group"
          aria-label={`${t.product} · ${t.headline}`}
          data-testid="brief-shipped-tile"
          onpointermove={track}
          use:peek={{ state: brief, content: () => tilePeek(t), place: "below" }}
        >
          <div class="hd">
            <BriefOrigin origin={t.origin} product />
          </div>
          <div class="v" data-testid="brief-shipped-headline">{t.headline}</div>
          {#each t.highlights.slice(0, lines) as h, i (i)}
            <div class="s" data-testid="brief-shipped-highlight">{h.label}</div>
          {/each}
        </div>
      {/each}
      {#if rest.length}
        <div class="run more" role="button" tabindex="0" data-testid="brief-shipped-more" use:peek={{ state: brief, content: morePeek, place: "below" }}>
          +{rest.length} more
        </div>
      {/if}
    </div>
  {:else}
    <div class="sub" style="margin-top:12px" data-testid="brief-shipped-empty">Merged across the day; no product breakdown yet.</div>
  {/if}
</div>

<style>
  /* The title block and the totals share one centre line. */
  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .top h3 {
    margin-top: 0;
  }
  .win {
    margin-top: 4px;
    font-size: 13px;
    color: var(--b-t3);
  }
  .tot {
    display: flex;
    gap: 16px;
    align-items: baseline;
  }
  .tot .big {
    font-size: var(--b-fs-num);
  }
  .tot .dim {
    color: rgb(var(--b-ink) / 0.7);
  }
  .tot small {
    font-size: 13px;
    color: rgb(var(--b-ink) / 0.56);
    margin-left: 6px;
  }
  /* Streak flame: consecutive landing days, only when earned (two or more). */
  .streak {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: 8px;
    font-family: var(--b-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0;
    color: var(--b-sun);
    vertical-align: middle;
  }
  .streak svg {
    width: 10px;
    height: 12px;
    fill: var(--b-sun);
  }
  .streak svg path {
    transform-origin: 50% 100%;
    animation: flick 1.6s ease-in-out infinite;
  }
  @keyframes flick {
    50% {
      transform: scaleY(0.86) skewX(3deg);
    }
  }
  .runs {
    flex: 1;
    display: grid;
    gap: 10px;
    margin-top: 12px;
    grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr));
    grid-auto-rows: 1fr;
    min-height: 0;
  }
  /* One row of tiles still fills the card's height, so there is no empty band under them. */
  .runs.one {
    margin-top: 14px;
  }
  .run {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    border-radius: 10px;
    padding: 12px 14px;
    container-type: inline-size;
    /* Glass tile, no rim (no backdrop-filter: WKWebView draws it as a square). */
    background: rgb(var(--b-ink) / 0.12);
    border: 0;
    box-shadow: none;
    min-width: 0;
  }
  .hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    margin-bottom: 10px;
    min-width: 0;
  }
  .hd :global(.org) {
    min-width: 0;
  }
  /* Too narrow for the product name: keep the logo, hide the text. */
  @container (max-width: 110px) {
    .hd :global(.org b) {
      display: none;
    }
  }
  /* Hover: light follows the pointer across the tile and catches its rim (white glass, no foil). */
  .run::before {
    content: "";
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s;
    /* A soft white light under the pointer, the same glass light the cards use; no colour. */
    background: radial-gradient(180px circle at var(--hx, 50%) var(--hy, 50%), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0) 70%);
  }
  .run::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s;
    /* The rim catches the light on the pointer's side and fades away from it, in white. */
    background: conic-gradient(from var(--ang, 0deg), rgba(255, 255, 255, 0.75), rgba(255, 255, 255, 0.2) 22%, rgba(255, 255, 255, 0.08) 50%, rgba(255, 255, 255, 0.2) 78%, rgba(255, 255, 255, 0.75));
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
  }
  .run:hover::before {
    opacity: 1;
  }
  .run:hover::after {
    opacity: 0.95;
  }
  .v {
    font-size: 15px;
    font-weight: 500;
    line-height: 1.25;
  }
  /* Highlights as a calm list: one line each, hairlines between, the count above them. */
  .s {
    font-size: 12px;
    line-height: 1.35;
    color: rgb(var(--b-ink) / 0.78);
    padding: 7px 0;
    border-top: 1px solid rgb(var(--b-ink) / 0.12);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .v + .s {
    margin-top: 10px;
  }
  /* The rest of the products: a slim, quiet column with no fill until hovered. */
  .run.more {
    justify-content: center;
    align-items: center;
    padding: 0 6px;
    background: transparent;
    font-size: 12px;
    color: rgb(var(--b-ink) / 0.72);
    cursor: default;
    transition: background 0.2s;
  }
  .run.more:hover {
    background: rgb(var(--b-ink) / 0.08);
  }
  .run.more::before,
  .run.more::after {
    display: none;
  }
  .run.more:hover,
  .run.more:focus-visible {
    background: rgb(var(--b-ink) / 0.08);
    outline: none;
  }
</style>
