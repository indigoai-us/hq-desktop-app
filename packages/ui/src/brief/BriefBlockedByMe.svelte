<script lang="ts">
  /**
   * What your calls unblock: "make these calls and these people and things
   * move". Two rows and up (M): a list of your calls, each an open row with
   * its title (wrapping, never cut), a quiet meta line (company logo, product
   * in mono caps, the age as a pill that turns warm past a day) and, under
   * it, who it frees: a Phosphor arrow, a monochrome glass circle (a
   * person's initial, a cube for work) and the name with what they do next,
   * wrapping instead of truncating. At most three calls and five party lines;
   * each call keeps at least one line, the rest folds into its own "+N more".
   * Hovering a call dims the others and reveals its Start button in place of
   * the age. One row (W, W3): the lead call and the chain of what it frees,
   * as initial chips after one arrow. Every call's peek is the decision's,
   * with its prompt and Start button; every party's peek says what they do
   * next and which calls free them.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefLogo from "./BriefLogo.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { decisionPeek } from "./brief-peeks.js";
  import { productName } from "./brief-origin.js";
  import {
    NARROW_CALL_CAP,
    NARROW_LINE_CAP,
    ageLabel,
    blockedHeadline,
    blockedLayout,
    blockedStats,
    chainNodes,
    initialOf,
    isFreed,
    isLate,
    morePartiesPeek,
    morePillsPeek,
    partyPeek,
    summarizeBlocked,
    titlesOf,
    type FreedParty,
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
  // A one-column card lists fewer calls and lines, and its chain names one party.
  const lay = $derived(cols <= 1 ? blockedLayout(s, NARROW_CALL_CAP, NARROW_LINE_CAP) : blockedLayout(s));
  const ch = $derived(chainNodes(s, cols >= 3 ? 3 : cols === 2 ? 2 : 1));
  const stats = $derived(blockedStats(s));
  /** Two calls or fewer on a two-column card: larger titles and more air, so the card is not half empty. */
  const roomy = $derived(!chain && cols >= 2 && lay.calls.length <= 2);

  // Hover focus: a call (by id) or a party (by key).
  let hot = $state<string | null>(null);
  let hotParty = $state<string | null>(null);
  const focus = $derived(!!(hot || hotParty));
  const callLit = (id: string, parties: FreedParty[]) => (hot ? hot === id : hotParty ? parties.some((p) => p.key === hotParty) : false);
  const partyLit = (p: FreedParty, callId: string) => (hot ? hot === callId : hotParty === p.key);
  const product = (d: BriefDecision) => productName(d.origin.repo, d.origin.product);
  const CUBE = "M4 8.5 12 4l8 4.5v7L12 20l-8-4.5zM4 8.5l8 4.5 8-4.5M12 13v7";
  const ARROW = "M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z";
</script>

<!-- A call: logo, product and age over its title (wraps, never cut); Start takes the age's place on hover. -->
{#snippet call(d: BriefDecision, testid: string, index: number | undefined, dim: boolean)}
  {@const done = !!brief.cleared[d.id]}
  {@const age = ageLabel(d.ageHours)}
  {@const prompt = prompts[d.id]}
  <div
    class="call"
    class:done
    class:dim
    data-testid={testid}
    data-index={index}
    role="group"
    aria-label={titles[d.id]}
    onmouseenter={() => (hot = d.id)}
    onmouseleave={() => (hot = null)}
    use:peek={{ state: brief, content: () => decisionPeek(d, prompts[d.id]) }}
  >
    <span class="cm">
      <BriefLogo company={brief.company(d.origin.companyUid)} fallback={d.origin.companyUid} size={16} />
      {#if product(d)}<span class="prod" data-testid="brief-blocked-product">{product(d)}</span>{/if}
      <span class="end">
        {#if done}
          <span class="age" data-testid="brief-blocked-age">Done</span>
        {:else}
          {#if age}<span class="age" class:late={isLate(d)} data-testid="brief-blocked-age">{age}</span>{/if}
          {#if prompt}
            <span class="acts" data-testid="brief-blocked-acts"><span class="verb">Start in</span><BriefLaunch id={d.id} {prompt} compact /></span>
          {/if}
        {/if}
      </span>
    </span>
    <span class="ct" data-testid="brief-blocked-title">{titles[d.id]}</span>
  </div>
{/snippet}

<!-- A freed party: arrow, then the party (glass circle, name and what they do next, wrapping), then its
     state and, on a call's last line, the "+N more" it folds. Party and "+N more" are siblings, each with its own peek. -->
{#snippet party(p: FreedParty, callId: string, dim: boolean, folded: FreedParty[])}
  {@const freed = isFreed(p, brief.cleared)}
  <div class="fr" class:freed class:lift={focus && partyLit(p, callId)} class:dim>
    <svg class="ar" viewBox="0 0 256 256" aria-hidden="true" data-testid="brief-blocked-arrow"><path d={ARROW} /></svg>
    <span
      class="who"
      data-testid="brief-blocked-party"
      data-kind={p.kind}
      data-key={p.key}
      data-freed={freed}
      role="group"
      aria-label={p.name}
      onmouseenter={() => (hotParty = p.key)}
      onmouseleave={() => (hotParty = null)}
      use:peek={{ state: brief, content: () => partyPeek(p, titles) }}
    >
      <span class="ini" aria-hidden="true">
        {#if p.kind === "person"}{initialOf(p.name)}{:else}<svg class="cube" viewBox="0 0 24 24" data-testid="brief-blocked-work"><path d={CUBE} /></svg>{/if}
      </span>
      <span class="ptx"><span class="pn" data-testid="brief-blocked-name">{p.name}</span>{#if p.what}{" "}<span class="pw" data-testid="brief-blocked-what">{p.what}</span>{/if}</span>
    </span>
    {#if freed || (!p.what && p.kind === "work") || folded.length}
      <span class="tail">
        {#if freed}
          <span class="st" data-testid="brief-blocked-state">Freed</span>
        {:else if !p.what && p.kind === "work"}
          <span class="st" data-testid="brief-blocked-state">{p.state}</span>
        {/if}
        {#if folded.length}
          <span class="chip" data-testid="brief-blocked-more" role="button" tabindex="0" use:peek={{ state: brief, content: () => morePartiesPeek(folded, titles) }}>+{folded.length} more</span>
        {/if}
      </span>
    {/if}
  </div>
{/snippet}

<div class="w" class:roomy class:narrow={cols <= 1} data-testid="brief-blocked" data-form={chain ? "chain" : "graph"}>
  <div class="eyebrow">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 1 0-5.6l2.4-2.4a4 4 0 0 1 5.6 5.6L16.6 13M14 10a4 4 0 0 1 0 5.6l-2.4 2.4a4 4 0 0 1-5.6-5.6L7.4 11" /></svg>
    What your calls unblock · {s.decisions.length} call{s.decisions.length === 1 ? "" : "s"}
  </div>
  <h3 data-testid="brief-blocked-headline">{headline}</h3>

  {#if chain}
    {#if ch.lead}
      {@const lead = ch.lead}
      {@const done = !!brief.cleared[lead.id]}
      <div class="chain" class:done data-testid="brief-blocked-chain">
        {@render call(lead, "brief-blocked-you", undefined, false)}
        <div class="flow">
          <svg class="ar" viewBox="0 0 256 256" aria-hidden="true" data-testid="brief-blocked-arrow"><path d={ARROW} /></svg>
          {#each ch.nodes as p (p.key)}
            {@const freed = isFreed(p, brief.cleared)}
            <span
              class="node"
              class:freed
              data-testid="brief-blocked-node"
              data-kind={p.kind}
              data-state={freed ? "FREED" : p.state}
              role="group"
              aria-label={p.name}
              use:peek={{ state: brief, content: () => partyPeek(p, titles) }}
            >
              <span class="ini" aria-hidden="true">
                {#if p.kind === "person"}{initialOf(p.name)}{:else}<svg class="cube" viewBox="0 0 24 24" data-testid="brief-blocked-work"><path d={CUBE} /></svg>{/if}
              </span>
              <span class="t">{p.name}</span>
            </span>
          {/each}
          {#if ch.more.length}
            <span class="more chip" data-testid="brief-blocked-more" role="button" tabindex="0" use:peek={{ state: brief, content: () => morePartiesPeek(ch.more, titles) }}>+{ch.more.length} more</span>
          {/if}
        </div>
      </div>
    {/if}
  {:else}
    <div class="list" class:focus data-testid="brief-blocked-graph">
      {#each lay.calls as c, i (c.decision.id)}
        {@const dim = focus && !callLit(c.decision.id, c.parties)}
        <div class="pair" class:lit={focus && !dim}>
          {@render call(c.decision, "brief-blocked-pill", i, dim)}
          {#if c.parties.length}
            <div class="frees">
              {#each c.parties as p, j (p.key)}
                {@render party(p, c.decision.id, dim, j === c.parties.length - 1 ? c.folded : [])}
              {/each}
            </div>
          {/if}
        </div>
      {/each}
      {#if lay.moreCalls.length}
        <div class="morecalls" class:dim={focus} role="button" tabindex="0" data-testid="brief-blocked-more-pills" use:peek={{ state: brief, content: () => morePillsPeek(lay.moreCalls, s, titles) }}>
          <span class="chip">+{lay.moreCalls.length} more call{lay.moreCalls.length === 1 ? "" : "s"}</span>
        </div>
      {/if}
    </div>
    <!-- The numbers take whatever height the slot has left; they show only when they fit whole. -->
    {#if stats.length}
      <div class="room">
        <div class="sum" class:dim={focus} data-testid="brief-blocked-sum">
          {#each stats as st (st.key)}
            <div class="stat" class:late={st.late} data-testid="brief-blocked-stat" data-stat={st.key}>
              <b>{st.value}</b>
              <span>{st.label}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  /* Headline: 20px on the list form (the M card family), 16px on the one-row card; whole words, never cut. */
  .w h3 {
    font-size: var(--b-fs-title-lg, 20px);
    font-weight: 500;
    line-height: 1.25;
    letter-spacing: -0.015em;
    color: #fff;
    hyphens: none;
    overflow-wrap: normal;
    word-break: normal;
    text-wrap: pretty;
  }
  .w[data-form="chain"] h3,
  .w.narrow h3 {
    font-size: 16px;
    line-height: 1.3;
  }

  /* ---- a call: open row, title over a quiet meta line ---- */
  .call {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    transition: opacity 0.3s;
  }
  .ct {
    min-width: 0;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.3;
    color: #fff;
    /* Titles wrap whole words, never clipped or cut with an ellipsis. */
    white-space: normal;
    overflow-wrap: break-word;
    text-wrap: pretty;
  }
  .roomy .ct {
    font-size: 17px;
    line-height: 1.28;
    letter-spacing: -0.01em;
  }
  .roomy .ptx {
    font-size: 14px;
    line-height: 19px;
  }
  .call.done .ct {
    text-decoration: line-through;
    text-decoration-color: rgba(255, 255, 255, 0.55);
    color: rgba(255, 255, 255, 0.78);
  }
  .cm {
    container: cm / inline-size;
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    min-height: 22px;
  }
  /* Product: the mono label style, all caps, quiet. */
  .prod {
    min-width: 0;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    line-height: 1.3;
    color: rgba(255, 255, 255, 0.8);
    overflow-wrap: break-word;
  }
  .end {
    position: relative;
    margin-left: auto;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    min-height: 22px;
  }
  /* Age: a small glass pill; warm past a day. */
  .age {
    height: 20px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: rgba(255, 255, 255, 0.9);
    background: rgba(255, 255, 255, 0.16);
    transition: opacity 0.2s;
  }
  .age.late {
    color: #ffe08a;
    background: rgba(255, 205, 110, 0.32);
  }
  /* Start takes the age's place on the hovered call, so nothing moves. */
  .acts {
    position: absolute;
    right: 0;
    top: 50%;
    translate: 0 -50%;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
  }
  .call:hover .acts,
  .call:focus-within .acts {
    opacity: 1;
    pointer-events: auto;
  }
  .call:hover .age,
  .call:focus-within .age {
    opacity: 0;
  }
  .verb {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.75);
    white-space: nowrap;
  }
  @container cm (max-width: 230px) {
    .verb {
      display: none;
    }
  }
  /* Row button: mono caps on soft glass, filled white with dark text on hover. The peek keeps the engine switch and copy. */
  .acts :global(.launch .go) {
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
    box-shadow: none;
    transition: background 0.2s, color 0.2s;
  }
  .acts :global(.launch .go:hover),
  .acts :global(.launch .go:focus-visible) {
    color: #18181b;
    background: #fff;
    outline: none;
  }
  .acts :global(.launch .eng),
  .acts :global(.launch .copy) {
    display: none;
  }

  /* ---- list form ---- */
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 12px;
    min-height: 0;
  }
  .roomy .list {
    gap: 12px;
  }
  /* One call and what it frees. Open at rest; a soft glass row while it has your pointer. */
  .pair {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0 -10px;
    padding: 7px 10px;
    border-radius: 10px;
    transition: background 0.2s;
  }
  .roomy .pair {
    gap: 9px;
    padding: 10px;
  }
  .pair:hover,
  .pair:focus-within {
    background: rgba(255, 255, 255, 0.14);
  }
  .frees {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .fr {
    display: grid;
    grid-template-columns: 13px minmax(0, 1fr) auto;
    align-items: start;
    column-gap: 8px;
    min-width: 0;
    transition: opacity 0.3s;
  }
  .who {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    align-items: start;
    column-gap: 8px;
    min-width: 0;
  }
  .tail {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 22px;
  }
  .dim {
    opacity: 0.45;
  }
  /* Phosphor arrow-right (regular): what the call sets moving. */
  .ar {
    width: 13px;
    height: 13px;
    flex: none;
    margin-top: 4.5px;
    fill: rgba(255, 255, 255, 0.75);
  }
  /* Monochrome glass circle: a person's initial, a cube for work. */
  .ini {
    width: 22px;
    height: 22px;
    flex: none;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    color: #fff;
    background: rgba(255, 255, 255, 0.2);
    transition: background 0.2s;
  }
  .fr.lift .ini {
    background: rgba(255, 255, 255, 0.32);
  }
  .cube {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linejoin: round;
  }
  /* Name and what they do next: one wrapping line of text, never truncated. */
  .ptx {
    min-width: 0;
    padding-top: 2px;
    font-size: 13px;
    line-height: 18px;
    white-space: normal;
    overflow-wrap: break-word;
  }
  .pn {
    font-weight: 500;
    color: #fff;
  }
  .pw {
    color: rgba(255, 255, 255, 0.82);
  }
  /* A work line's state (NEXT, AFTER CUT) or Freed: the mono label style. */
  .st {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: rgba(255, 255, 255, 0.75);
  }
  .fr.freed {
    opacity: 0.62;
  }
  /* "+N more": a small glass pill. */
  .chip {
    height: 20px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    color: rgba(255, 255, 255, 0.9);
    background: rgba(255, 255, 255, 0.16);
    transition: background 0.2s;
  }
  .chip[role="button"] {
    cursor: default;
  }
  .chip:hover,
  .morecalls:focus-visible .chip,
  .chip:focus-visible {
    background: rgba(255, 255, 255, 0.22);
    outline: none;
  }
  .morecalls {
    padding: 2px 0 0;
    cursor: default;
    transition: opacity 0.3s;
  }
  .morecalls:focus-visible {
    outline: none;
  }

  /* ---- the numbers, at the foot of a tall card ----
     The room takes the height the slot has left and adds none of its own (size containment), so
     a short slot never grows for it; the band shows only when it fits whole. */
  .room {
    flex: 1 1 0;
    min-height: 0;
    container: room / size;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }
  .sum {
    display: none;
    grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
    gap: 12px;
    padding-top: 14px;
    transition: opacity 0.3s;
  }
  @container room (min-height: 96px) {
    .sum {
      display: grid;
    }
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .stat b {
    font-size: var(--b-fs-num, 32px);
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.04em;
    font-variant-numeric: tabular-nums;
    color: #fff;
  }
  /* Past a day: the number stays white like every hero number; a small warm dot leads its label. */
  .stat.late span::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 6px;
    border-radius: 50%;
    vertical-align: 1px;
    background: #ffe08a;
  }
  .stat span {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    line-height: 1.3;
    color: rgba(255, 255, 255, 0.8);
  }

  /* ---- one-row card: the lead call, then the chain it frees ---- */
  /* Right under the headline, not pushed to the foot: the card reads top-down with no empty middle. */
  .chain {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 18px;
    min-width: 0;
  }
  .chain .call {
    gap: 4px;
  }
  .chain .cm {
    min-height: 22px;
  }
  /* One arrow, then what it frees in a single column: every line starts at the same edge. */
  .flow {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr);
    align-items: center;
    gap: 8px 10px;
    min-width: 0;
  }
  .flow .ar {
    grid-column: 1;
    grid-row: 1;
    margin-top: 0;
  }
  .flow > .node,
  .flow > .more {
    grid-column: 2;
  }
  .node {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.3;
    color: #fff;
    transition: opacity 0.3s;
  }
  .node .t {
    min-width: 0;
    white-space: normal;
    overflow-wrap: break-word;
  }
  .node.freed,
  .chain.done .flow {
    opacity: 0.62;
  }
  /* "+N more": a quiet mono caps line under the list, not another pill. */
  .flow .more {
    justify-self: start;
    height: auto;
    padding: 0;
    background: none;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.7);
    cursor: default;
  }
  .flow .more:hover,
  .flow .more:focus-visible {
    background: none;
    color: #fff;
  }
</style>
