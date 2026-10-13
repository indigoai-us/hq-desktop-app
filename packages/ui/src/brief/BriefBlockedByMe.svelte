<script lang="ts">
  /**
   * What your calls unblock: the people and work stopped until you act.
   * Two rows (M): a bipartite graph, your calls on the left and who they free
   * on the right, bezier edges weighted by what sits behind them; hovering a
   * call dims the others, brightens its edges and lifts its parties. One row
   * (W, W3): the chain form, your top call flowing along a dashed link into
   * the nodes it frees; the flow stops once you clear it. Neutral tile, violet
   * only on the "you" node. Every pill's peek is the decision's, with its
   * prompt and Start button; every party's peek says what they do next.
   */
  import BriefLogo from "./BriefLogo.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { decisionPeek } from "./brief-peeks.js";
  import { monogram, monogramHue, productName } from "./brief-origin.js";
  import {
    MORE_KEY,
    ageLabel,
    blockedHeadline,
    blockedLayout,
    chainNodes,
    isLate,
    morePartiesPeek,
    morePillsPeek,
    partyPeek,
    summarizeBlocked,
    titlesOf,
    type FreedParty,
    type LaidEdge,
  } from "./brief-blocked-by-me.js";
  import type { BriefDecision } from "./brief-types.js";

  interface Props {
    decisions: BriefDecision[];
    prompts: Record<string, string>;
    cols: number;
    rows: number;
  }
  let { decisions, prompts, cols, rows }: Props = $props();
  const brief = useBrief();

  const s = $derived(summarizeBlocked(decisions));
  const titles = $derived(titlesOf(s));
  const headline = $derived(blockedHeadline(s));
  const chain = $derived(rows === 1);
  const lay = $derived(blockedLayout(s));
  const ch = $derived(chainNodes(s, cols >= 3 ? 3 : 2));
  const byId = $derived(new Map(s.decisions.map((d) => [d.id, d])));

  // Fixed row heights make every edge endpoint computable without measuring the DOM.
  const PILL_H = 48;
  const PILL_GAP = 8;
  const PARTY_H = 30;
  const PARTY_GAP = 6;
  const pillY = (i: number) => PILL_H / 2 + i * (PILL_H + PILL_GAP);
  const partyY = (j: number) => PARTY_H / 2 + j * (PARTY_H + PARTY_GAP);
  const partyRows = $derived(lay.parties.length + (lay.moreParties.length ? 1 : 0));
  const graphH = $derived(Math.max(lay.pills.length * (PILL_H + PILL_GAP) - PILL_GAP, partyRows * (PARTY_H + PARTY_GAP) - PARTY_GAP, PILL_H));

  // Hover focus: a call (by id) or a party (by key, MORE_KEY for the tile).
  let hot = $state<string | null>(null);
  let hotParty = $state<string | null>(null);
  const focus = $derived(!!(hot || hotParty));
  const edgeOn = (e: LaidEdge) => (hot ? e.decisionId === hot : hotParty ? e.partyKey === hotParty : false);
  const partyLit = (key: string) => (hot ? lay.edges.some((e) => e.decisionId === hot && e.partyKey === key) : hotParty === key);
  const pillLit = (id: string) => (hotParty ? lay.edges.some((e) => e.partyKey === hotParty && e.decisionId === id) : hot === id);
  const product = (d: BriefDecision) => productName(d.origin.repo, d.origin.product);
</script>

<div class="w" data-testid="brief-blocked" data-form={chain ? "chain" : "graph"}>
  <div class="eyebrow">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 1 0-5.6l2.4-2.4a4 4 0 0 1 5.6 5.6L16.6 13M14 10a4 4 0 0 1 0 5.6l-2.4 2.4a4 4 0 0 1-5.6-5.6L7.4 11" /></svg>
    What your calls unblock · {s.decisions.length} call{s.decisions.length === 1 ? "" : "s"}
  </div>
  <h3 data-testid="brief-blocked-headline">{headline}</h3>

  {#if chain}
    {#if ch.lead}
      {@const lead = ch.lead}
      {@const done = !!brief.cleared[lead.id]}
      {@const age = ageLabel(lead.ageHours)}
      <div class="chain" data-testid="brief-blocked-chain">
        <div
          class="node you"
          class:done
          data-testid="brief-blocked-you"
          role="group"
          aria-label={titles[lead.id]}
          use:peek={{ state: brief, content: () => decisionPeek(lead, prompts[lead.id]) }}
        >
          <span class="t">{titles[lead.id]}</span>
          <small>{done ? "DONE" : age ? `YOU · ${age}` : "YOU"}</small>
        </div>
        {#each ch.nodes as p (p.key)}
          <div class="link" class:stop={done}></div>
          <div class="node" class:person={p.kind === "person"} data-testid="brief-blocked-node" role="group" aria-label={p.name} use:peek={{ state: brief, content: () => partyPeek(p, titles) }}>
            <span class="t">{p.name}</span>
            <small class={p.tone && !done ? `tone-${p.tone}` : ""}>{done ? "FREED" : p.state}</small>
          </div>
        {/each}
        {#if ch.more.length}
          <div class="link" class:stop={done}></div>
          <div class="node more" data-testid="brief-blocked-more" role="button" tabindex="0" use:peek={{ state: brief, content: () => morePartiesPeek(ch.more, titles) }}>
            <span class="t">+{ch.more.length} more</span>
            <small>WAITING</small>
          </div>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="graph" class:focus style:--h="{graphH}px" data-testid="brief-blocked-graph">
      <div class="pills">
        {#each lay.pills as d, i (d.id)}
          {@const done = !!brief.cleared[d.id]}
          {@const age = ageLabel(d.ageHours)}
          <div
            class="pill"
            class:done
            class:dim={focus && !pillLit(d.id)}
            data-testid="brief-blocked-pill"
            data-index={i}
            role="group"
            aria-label={titles[d.id]}
            onmouseenter={() => (hot = d.id)}
            onmouseleave={() => (hot = null)}
            use:peek={{ state: brief, content: () => decisionPeek(d, prompts[d.id]) }}
          >
            <div class="pt">{titles[d.id]}</div>
            <div class="pm">
              <span class="po">
                <BriefLogo company={brief.company(d.origin.companyUid)} fallback={d.origin.companyUid} size={14} />
                {#if product(d)}<b>{product(d)}</b>{/if}
              </span>
              <span class="age" class:amber={isLate(d) && !done} data-testid="brief-blocked-age">{done ? "DONE" : age}</span>
            </div>
          </div>
        {/each}
        {#if lay.morePills.length}
          <div class="pill more" role="button" tabindex="0" data-testid="brief-blocked-more-pills" use:peek={{ state: brief, content: () => morePillsPeek(lay.morePills, s, titles) }}>
            +{lay.morePills.length} more call{lay.morePills.length === 1 ? "" : "s"}
          </div>
        {/if}
      </div>
      <svg class="edges" viewBox="0 0 100 {graphH}" preserveAspectRatio="none" aria-hidden="true">
        {#each lay.edges as e (`${e.decisionId}>${e.partyKey}`)}
          {@const d = byId.get(e.decisionId)}
          <path
            class="edge"
            class:late={d ? isLate(d) : false}
            class:on={edgeOn(e)}
            class:done={!!brief.cleared[e.decisionId]}
            vector-effect="non-scaling-stroke"
            style:stroke-width="{1 + e.weight * 0.7}px"
            d="M0 {pillY(e.from)} C45 {pillY(e.from)}, 55 {partyY(e.to)}, 100 {partyY(e.to)}"
          />
        {/each}
      </svg>
      <div class="parties">
        {#each lay.parties as p (p.key)}
          <div
            class="party"
            class:lift={partyLit(p.key)}
            class:dim={focus && !partyLit(p.key)}
            data-testid="brief-blocked-party"
            data-kind={p.kind}
            role="group"
            aria-label={p.name}
            onmouseenter={() => (hotParty = p.key)}
            onmouseleave={() => (hotParty = null)}
            use:peek={{ state: brief, content: () => partyPeek(p, titles) }}
          >
            {#if p.kind === "person"}
              <span class="ava" style:--h={monogramHue(p.name)} aria-hidden="true">{monogram(p.name)}</span>
            {:else}
              <span class="tile" aria-hidden="true">
                {#if p.origin}
                  <BriefLogo company={brief.company(p.origin.companyUid)} fallback={p.origin.companyUid} size={16} />
                {:else}
                  <svg class="ico" viewBox="0 0 24 24"><path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5zM4 8.5l8 4.5 8-4.5M12 13v7" /></svg>
                {/if}
              </span>
            {/if}
            <span class="pn">{p.name}</span>
            {#if p.what}<span class="pw">{p.what}</span>{/if}
          </div>
        {/each}
        {#if lay.moreParties.length}
          <div
            class="party more"
            class:lift={partyLit(MORE_KEY)}
            class:dim={focus && !partyLit(MORE_KEY)}
            data-testid="brief-blocked-more"
            role="button"
            tabindex="0"
            onmouseenter={() => (hotParty = MORE_KEY)}
            onmouseleave={() => (hotParty = null)}
            use:peek={{ state: brief, content: () => morePartiesPeek(lay.moreParties, titles) }}
          >
            <span class="pn">+{lay.moreParties.length} more</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  h3 {
    font-size: 15px;
  }

  /* Glass tile: lit from the top, hairline rim, soft drop. No backdrop-filter, no well. */
  .pill,
  .node,
  .tile {
    background: rgb(var(--b-ink) / 0.04);
    border: 1px solid rgb(var(--b-ink) / 0.09);
    box-shadow: none;
  }

  /* ---- two-row graph ---- */
  .graph {
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) 40px minmax(0, 1fr);
    align-items: start;
    margin-top: 14px;
    min-height: 0;
  }
  .pills {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .pill {
    height: 48px;
    padding: 7px 10px;
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-width: 0;
    transition: background 0.2s, opacity 0.3s;
  }
  .pill:hover {
    background: rgb(var(--b-ink) / 0.07);
  }
  .pill.dim {
    opacity: 0.45;
  }
  .pill.done .pt {
    text-decoration: line-through;
    text-decoration-color: rgb(var(--b-ink) / 0.4);
    color: var(--b-t2);
  }
  .pill.more {
    height: 28px;
    justify-content: center;
    align-items: center;
    font-size: 11.5px;
    color: var(--b-t2);
    cursor: default;
  }
  .pt {
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pm {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }
  .po {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    font-family: var(--b-mono);
    font-size: 9.5px;
    color: var(--b-t3);
  }
  .po b {
    font-weight: 500;
    color: var(--b-t2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .age {
    flex: none;
    font-family: var(--b-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--b-t3);
  }
  .age.amber {
    color: var(--b-warn);
  }

  .edges {
    display: block;
    width: 100%;
    height: var(--h);
    overflow: visible;
  }
  .edge {
    fill: none;
    stroke: rgb(var(--b-ink) / 0.3);
    transition: stroke 0.25s, opacity 0.25s;
  }
  .edge.late {
    stroke: rgba(250, 204, 21, 0.55);
  }
  .edge.done {
    opacity: 0.2;
  }
  .graph.focus .edge {
    opacity: 0.12;
  }
  .graph.focus .edge.on {
    opacity: 1;
    stroke: #fff;
  }
  .graph.focus .edge.late.on {
    stroke: var(--b-warn);
  }

  .parties {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .party {
    height: 30px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    border-radius: 10px;
    min-width: 0;
    transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1), background 0.2s, opacity 0.3s;
  }
  .party.lift {
    transform: translateX(-4px);
    background: rgb(var(--b-ink) / 0.06);
  }
  .party.dim {
    opacity: 0.45;
  }
  .party.more {
    color: var(--b-t2);
    cursor: default;
  }
  .party.more .pn {
    font-weight: 400;
    font-size: 11.5px;
  }
  .ava {
    width: 22px;
    height: 22px;
    flex: none;
    border-radius: 7px;
    display: grid;
    place-items: center;
    font-size: 9.5px;
    font-weight: 500;
    letter-spacing: 0;
    color: #fff;
    background: hsl(var(--h) 45% 42%);
    box-shadow: none;
  }
  .tile {
    width: 22px;
    height: 22px;
    flex: none;
    border-radius: 7px;
    display: grid;
    place-items: center;
    color: var(--b-t2);
  }
  .tile .ico {
    width: 12px;
    height: 12px;
  }
  .pn {
    flex: none;
    max-width: 62%;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pw {
    min-width: 0;
    font-family: var(--b-mono);
    font-size: 9.5px;
    color: var(--b-t3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ---- one-row chain ---- */
  .chain {
    display: flex;
    align-items: center;
    gap: 0;
    margin-top: auto;
    padding-top: 12px;
    min-width: 0;
  }
  .node {
    flex: 1 1 0;
    min-width: 0;
    padding: 8px 11px;
    border-radius: 12px;
    font-size: 12px;
    line-height: 1.25;
    transition: opacity 0.3s;
  }
  .node .t {
    font-weight: 500;
    overflow: hidden;
    white-space: normal;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
  }
  .node small {
    display: block;
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.04em;
    color: var(--b-t3);
    margin-top: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The accent is earned once: the call that is yours. */
  .node.you {
    flex: 1.3 1 0;
    border-color: rgba(255, 153, 102, 0.45);
    background: rgba(255, 153, 102, 0.08);
  }
  .node.you small {
    color: rgb(var(--b-ink) / 0.7);
  }
  .node.you.done {
    opacity: 0.55;
  }
  .node.you.done .t {
    text-decoration: line-through;
    text-decoration-color: rgb(var(--b-ink) / 0.4);
  }
  .node.more {
    flex: 0.8 1 0;
    color: var(--b-t2);
    cursor: default;
  }
  .node.more .t {
    font-weight: 400;
  }
  /* The dashed flow moves toward the node that is waiting; it stops once the call is made. */
  .link {
    flex: 0 0 22px;
    min-width: 14px;
    height: 2px;
    background: repeating-linear-gradient(90deg, rgb(var(--b-ink) / 0.35) 0 5px, transparent 5px 10px);
    background-size: 20px 2px;
    animation: flow 1s linear infinite;
  }
  .link.stop {
    animation: none;
    opacity: 0.35;
  }
  @keyframes flow {
    from {
      background-position: -20px 0;
    }
    to {
      background-position: 0 0;
    }
  }
</style>
