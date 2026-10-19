<script lang="ts">
  /**
   * What the bot has found so far, as the brief assembling itself: one bento
   * tile per counter, in a fixed grid and a fixed order so nothing moves as
   * counts land. A tile with no value yet is a quiet hatched glass tile with
   * a dash; once its count arrives it fills with the colour field the finished
   * brief gives that kind (findingField) and the number ticks up as a big
   * light figure (countValue easing), with its caption beside it. A count that
   * came back empty stays monochrome. Sample cards are glass chips on their
   * own field that rise in, newest last, each naming its company through
   * CompanyLabel. Reduced motion: counters show their value and cards appear
   * in place.
   */
  import { onDestroy } from "svelte";
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import { countValue, type CountSample } from "../chat/first-run/knowledge-tree/scene-model.js";
  import {
    findingField,
    findingRows,
    findingState,
    pendingFindingRows,
    sampleCompany,
    sampleKindLabel,
    sampleTone,
    type BriefFindings,
    type BriefSample,
  } from "./brief-findings.js";

  interface Props {
    /** Null before the run has reported any counts: every tile waits. */
    findings: BriefFindings | null;
    samples?: readonly BriefSample[];
    /** Cards shown at once. */
    cards?: number;
    /** The full page bento or the band over a brief. */
    size?: "page" | "masthead";
    /** The companies the page knows, so a sample names its company with its label and icon. */
    companies?: readonly { uid: string; slug?: string | null; label: string; iconUrl?: string | null }[];
    /** Test seam; null follows prefers-reduced-motion. */
    reducedMotion?: boolean | null;
    /** Test seam for the counter clock, in seconds. */
    clock?: () => number;
  }
  let { findings, samples = [], cards = 3, size = "page", companies = [], reducedMotion = null, clock }: Props = $props();

  /** How long a counter takes to reach a new value. */
  const TWEEN_S = 1.2;
  const prefersReduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reduced = $derived(reducedMotion ?? prefersReduced);
  const now = () => (clock ? clock() : performance.now() / 1000);

  const allRows = $derived(findings ? findingRows(findings) : pendingFindingRows());
  /** The fixed counters fill the bento; connected apps ride in the samples card's header. */
  const rows = $derived(allRows.filter((r) => !r.key.startsWith("int:")));
  const apps = $derived(allRows.filter((r) => r.key.startsWith("int:")));
  /** Per counter, the values seen and when, for countValue. */
  const history = new Map<string, CountSample[]>();
  let t = $state(0);
  let raf = 0;

  $effect(() => {
    const at = now();
    let moving = false;
    for (const r of allRows) {
      if (r.value == null) continue;
      const h = history.get(r.key) ?? [{ t: at, v: 0 }];
      if (h.at(-1)!.v !== r.value) h.push({ t: at, v: r.value });
      history.set(r.key, h);
      if (at < h.at(-1)!.t + TWEEN_S) moving = true;
    }
    t = at;
    if (moving && !reduced && typeof requestAnimationFrame === "function") tickUntilSettled();
  });

  function tickUntilSettled(): void {
    cancelAnimationFrame(raf);
    const step = () => {
      t = now();
      const settled = [...history.values()].every((h) => t >= h.at(-1)!.t + TWEEN_S);
      if (!settled) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  onDestroy(() => cancelAnimationFrame(raf));

  /** The number a counter shows now. */
  function shown(key: string, value: number): number {
    if (reduced) return value;
    const h = history.get(key);
    if (!h) return value;
    return Math.round(countValue(h, t, TWEEN_S));
  }
  /**
   * The newest cards per company (person-scoped runs read every company), each
   * with its company resolved to the page's label and icon.
   */
  const sections = $derived.by(() => {
    const groups = new Map<string, BriefSample[]>();
    for (const sample of samples) {
      const key = sample.company || "Personal";
      groups.set(key, [...(groups.get(key) ?? []), sample].slice(-cards));
    }
    return [...groups].map(([company, items]) => ({
      company,
      co: company === "Personal" ? null : sampleCompany(company, companies),
      items: items.map((s) => ({ ...s, co: sampleCompany(s.company, companies) })),
    }));
  });
</script>

<div class="fd s-{size}" data-testid="brief-findings">
  <!-- A fixed grid in a fixed order: tiles never move as counts land. -->
  <div class="rows">
    {#each rows as r, i (r.key)}
      {@const state = findingState(r)}
      <div
        class="tile"
        data-state={state}
        data-field={findingField(r)}
        data-testid="brief-finding"
        data-key={r.key}
        style:animation-delay="{140 + i * 70}ms"
      >
        <!-- The colour field the count fills with (brief.css .slot[data-field]); faded in on arrival. -->
        <div class="slot fill" data-field={findingField(r)} aria-hidden="true"><div class="w"></div></div>
        <span class="top">
          <span class="name">{r.label}</span>
          <span class="pip" aria-hidden="true"></span>
        </span>
        <span class="count">
          <b data-testid="brief-finding-value">{r.value == null ? "—" : shown(r.key, r.value)}</b>
          {#if r.sub && r.value != null}<span class="cap">{r.sub.value} {r.sub.label}</span>{/if}
        </span>
      </div>
    {/each}
  </div>
  <!-- Proof of what the bot is reading: glass chips on their own field, one group per company. -->
  <div class="slot found" data-field="peri" style:animation-delay="{140 + rows.length * 70}ms">
    <div class="w">
      <div class="found-head">
        <span class="lbl">Found so far</span>
        {#if apps.length}
          <span class="apps">
            {#each apps as a (a.key)}
              <span class="app" data-testid="brief-finding" data-key={a.key} data-state={findingState(a)}
                ><span class="name">{a.label}</span> <b data-testid="brief-finding-value">{a.value == null ? "—" : shown(a.key, a.value)}</b></span
              >
            {/each}
          </span>
        {/if}
      </div>
      {#each sections as section (section.company)}
        <section aria-label={section.company} data-testid="brief-sample-section">
          <h3 class="sample-heading">{#if section.co}<CompanyLabel name={section.co.name} companyUid={section.co.uid} iconUrl={section.co.iconUrl} size={12} />{:else}Personal{/if}</h3>
          <ul class="cards">
            {#each section.items as s (`${s.company}|${s.at}|${s.title}`)}
              <li
                class="card"
                data-testid="brief-sample"
                data-tone={sampleTone(s.kind)}
                animate:flip={{ duration: reduced ? 0 : 420 }}
                in:fly={{ y: reduced ? 0 : 14, duration: reduced ? 0 : 520, opacity: reduced ? 1 : 0 }}
              >
                <span class="kind">{sampleKindLabel(s.kind)}</span>
                <span class="title">{s.title}</span>
                <span class="co"><CompanyLabel name={s.co.name} companyUid={s.co.uid} iconUrl={s.co.iconUrl} size={16} /></span>
              </li>
            {/each}
          </ul>
        </section>
      {:else}
        <p class="none">Items show up here as the bot reads them.</p>
      {/each}
    </div>
  </div>
</div>

<style>
  .sample-heading { font-size: 12px; font-weight: 500; margin: 4px 0 6px; }
  .fd {
    --mono: var(--b-code, "Geist Mono", ui-monospace, monospace);
    display: flex;
    flex-direction: column;
    gap: var(--b-gap, 8px);
    width: 100%;
    min-width: 0;
  }
  .rows {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    grid-auto-rows: minmax(112px, 1fr);
    gap: var(--b-gap, 8px);
  }
  .s-masthead .rows {
    grid-template-columns: repeat(6, minmax(0, 1fr));
    grid-auto-rows: minmax(70px, 1fr);
  }
  /* A tile: label and a pixel pip on top, the number at the bottom with its caption beside it. */
  .tile {
    --ink: var(--b-ink);
    position: relative;
    isolation: isolate;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
    padding: 14px 16px;
    border-radius: var(--b-r, 12px);
    /* The page's monochrome glass panel. */
    background: var(--b-panel, rgb(var(--b-ink) / 0.06));
    border: 1px solid var(--b-panel-line, transparent);
    color: rgb(var(--ink) / 0.92);
    text-align: left;
    animation: rise 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    transition: border-color 0.6s ease;
  }
  .s-masthead .tile {
    padding: 11px 13px;
    gap: 6px;
  }
  /* Not reported yet: a faint hatched track on the glass, waiting to fill. */
  .tile[data-state="pending"] {
    background-image: repeating-linear-gradient(135deg, rgb(var(--b-ink) / 0.05) 0 1px, transparent 1px 7px);
  }
  .tile[data-state="found"]:not([data-field="mono"]) {
    --ink: 255 255 255;
    border-color: transparent;
    text-shadow: 0 1px 2px rgba(70, 10, 50, 0.2);
  }
  /* The colour field sits under the tile's text and fades in when the count lands. */
  .tile > :global(.slot.fill) {
    position: absolute;
    inset: 0;
    z-index: -1;
    opacity: 0;
    animation: none;
    transition: opacity 0.8s ease;
  }
  .tile[data-state="found"] > :global(.slot.fill) {
    opacity: 1;
  }
  .tile > :global(.slot.fill > .w) {
    --b-deco: linear-gradient(transparent, transparent);
    height: 100%;
    border-radius: inherit;
    padding: 0;
    box-shadow: none;
  }
  .tile[data-field="mono"] > :global(.slot.fill) {
    display: none;
  }
  .top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }
  .name {
    min-width: 0;
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 500;
    line-height: 14px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    overflow-wrap: anywhere;
    color: rgb(var(--ink) / 0.6);
  }
  .tile[data-state="found"]:not([data-field="mono"]) .name {
    color: rgba(255, 255, 255, 0.86);
  }
  /* One pixel cell: faint while waiting, lit once the count has something in it. */
  .pip {
    flex: none;
    width: 8px;
    height: 8px;
    margin-top: 3px;
    border-radius: 1.5px;
    background: rgb(var(--ink) / 0.16);
    transition:
      background-color 0.6s ease,
      scale 0.15s;
  }
  .tile[data-state="found"] .pip {
    background: rgb(var(--ink) / 0.92);
  }
  .tile:hover .pip {
    scale: 1.35;
  }
  .count {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    white-space: nowrap;
  }
  .count b {
    flex: none;
    font-size: var(--b-fs-num, 32px);
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
    color: rgb(var(--ink) / 0.92);
  }
  .s-masthead .count b {
    font-size: 22px;
  }
  .tile[data-state="pending"] .count b {
    color: rgb(var(--ink) / 0.3);
  }
  .tile[data-state="zero"] .count b {
    color: rgb(var(--ink) / 0.5);
  }
  .cap {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11px;
    color: rgb(var(--ink) / 0.72);
  }
  .tile[data-state="found"]:not([data-field="mono"]) .cap {
    color: rgba(255, 255, 255, 0.86);
  }
  .s-masthead .cap {
    display: none;
  }

  /* The samples card: a periwinkle field, label top left, glass chips in a row. */
  .fd .found {
    animation-name: rise;
  }
  .fd .found > :global(.w) {
    gap: 12px;
    /* Room for a row of chips from the start, so the bento never grows when they arrive. */
    min-height: 150px;
    padding: 16px 18px 18px;
  }
  .fd.s-masthead .found > :global(.w) {
    min-height: 0;
    padding: 12px 14px 14px;
    gap: 8px;
  }
  .found-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }
  .lbl,
  .app,
  .kind {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 500;
    line-height: 14px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .lbl {
    color: rgba(255, 255, 255, 0.86);
  }
  .apps {
    display: flex;
    gap: 12px;
    min-width: 0;
    overflow: hidden;
  }
  .app {
    color: rgba(255, 255, 255, 0.72);
  }
  .app .name {
    color: inherit;
    font-size: inherit;
  }
  .app b {
    font-weight: 500;
    color: #fff;
  }
  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--b-gap, 8px);
  }
  .s-masthead .cards {
    grid-template-columns: minmax(0, 1fr);
  }
  /* A glass chip: white at 14% on the field, a little brighter under the pointer. No rim, no shadow. */
  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    padding: 10px 12px 11px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.14);
    transition: background-color 0.15s;
  }
  .card:hover {
    background: rgba(255, 255, 255, 0.22);
  }
  .s-masthead .card {
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
  }
  .kind {
    color: rgba(255, 255, 255, 0.78);
  }
  .card[data-tone="red"] .kind::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    margin: 0 6px 1px 0;
    border-radius: 1.5px;
    background: var(--b-hot, #c9765a);
  }
  .title {
    min-width: 0;
    font-size: 13px;
    line-height: 1.35;
    color: #fff;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .s-masthead .title {
    flex: 1;
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
  .co {
    min-width: 0;
    display: flex;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.82);
  }
  /* The logo as on the cards (BriefLogo): a round glass circle in the white ink, never the app's grey tile. */
  .co :global(.company-label-initials) {
    border-radius: 50%;
    color: inherit;
    background: rgba(255, 255, 255, 0.16);
    font-size: 7px;
    letter-spacing: 0.02em;
  }
  .s-masthead .co {
    flex: none;
    max-width: 30%;
  }
  .none {
    margin: 0;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.78);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tile,
    .found,
    .tile > :global(.slot.fill),
    .pip {
      animation: none;
      transition: none;
    }
  }
</style>
