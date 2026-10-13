<script lang="ts">
  /**
   * What you shipped yesterday: one glass tile per product (never per repo),
   * each with the product's logo, how much merged, and a plain line worth
   * knowing. Holographic foil = an achievement; the edge follows your pointer.
   * A FIRST badge marks a first-of-its-kind ship; the flame counts consecutive
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
  // L shows two highlight lines, M one; one-row sizes show none.
  const lines = $derived(tall ? (cols >= 3 ? 2 : 1) : 0);
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
        What you shipped{#if streak}<span class="streak" title={streakTitle(streak)} data-testid="brief-shipped-streak"
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
              status: `${win.from} to ${win.to}`,
              sections: [{ label: "By product", lines: byProduct(win) }],
            }),
          }}
        >{win.from.slice(5)} to {win.to.slice(5)} · {win.total} PRs · {win.merged} merged</div>
      {/if}
    </div>
    <div class="tot">
      <div><span class="big" use:countUp={total}>0</span><small>merged</small></div>
      {#if opened != null}<div><span class="big dim" use:countUp={opened}>0</span><small>opened</small></div>{/if}
    </div>
  </div>
  {#if tiles.length}
    <div class="runs" class:one={!tall} style="--cols:{gridCols}">
      {#each shown as t (t.key)}
        <div
          class="run"
          role="group"
          aria-label={`${t.product} · ${t.headline}`}
          data-testid="brief-shipped-tile"
          onpointermove={track}
          use:peek={{ state: brief, content: () => tilePeek(t) }}
        >
          <div class="hd">
            <BriefOrigin origin={t.origin} product />
            {#if t.first}<span class="first" data-testid="brief-shipped-first" title="A first for this product">★ FIRST</span>{/if}
          </div>
          <div class="v" data-testid="brief-shipped-headline">{t.headline}</div>
          {#each t.highlights.slice(0, lines) as h, i (i)}
            <div class="s" data-testid="brief-shipped-highlight">{h.label}</div>
          {/each}
        </div>
      {/each}
      {#if rest.length}
        <div class="run more" role="button" tabindex="0" data-testid="brief-shipped-more" use:peek={{ state: brief, content: morePeek }}>
          +{rest.length} more
        </div>
      {/if}
    </div>
  {:else}
    <div class="sub" style="margin-top:12px" data-testid="brief-shipped-empty">Merged across the day; no product breakdown yet.</div>
  {/if}
</div>

<style>
  .top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .win {
    margin-top: 4px;
    font-family: var(--b-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
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
    color: rgb(var(--b-ink) / 0.56);
  }
  .tot small {
    font-size: 12px;
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
    font-size: 9.5px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
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
  .runs.one {
    flex: none;
    margin-top: 10px;
    grid-auto-rows: auto;
  }
  .run {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    border-radius: 14px;
    padding: 10px 12px;
    container-type: inline-size;
    /* Glass: lit from the top, hairline rim, soft drop. No inner shadow and no
       backdrop-filter (WKWebView draws it as a square that ignores the radius). */
    background: rgb(var(--b-ink) / 0.04);
    border: 1px solid rgb(var(--b-ink) / 0.09);
    box-shadow: none;
    min-width: 0;
  }
  .hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    margin-bottom: 5px;
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
  /* FIRST badge: warm foil, only on a first-of-its-kind ship. */
  .first {
    flex: none;
    display: inline-flex;
    align-items: center;
    font-family: var(--b-mono);
    font-size: 8px;
    letter-spacing: 0.08em;
    padding: 2px 6px;
    border-radius: 99px;
    color: #2a1408;
    background: linear-gradient(110deg, #ffb580, #ffe2c4 40%, #ff809f 60%, #ffb580);
    background-size: 220% 100%;
    animation: foil 3.5s ease-in-out infinite;
  }
  @keyframes foil {
    50% {
      background-position: 100% 0;
    }
  }
  /* Holographic foil, only on shipped work. */
  .run::before {
    content: "";
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s;
    background: linear-gradient(115deg, transparent 20%, rgba(255, 120, 200, 0.22) 35%, rgba(120, 220, 255, 0.22) 50%, rgba(180, 255, 150, 0.2) 62%, transparent 78%);
    background-size: 250% 250%;
    background-position: var(--hx, 50%) var(--hy, 50%);
    mix-blend-mode: var(--b-foil-blend, color-dodge);
  }
  .run::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1.2px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s;
    background: conic-gradient(from var(--ang, 0deg), #ff7ac6, #7ad7ff, #b6ff8a, #ffd36e, #ff7ac6);
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
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.25;
  }
  .s {
    font-size: 11px;
    color: rgb(var(--b-ink) / 0.56);
    margin-top: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The rest of the products, in one quiet tile; no foil (nothing shipped here). */
  .run.more {
    justify-content: center;
    align-items: center;
    font-size: 12px;
    color: rgb(var(--b-ink) / 0.78);
    cursor: default;
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
