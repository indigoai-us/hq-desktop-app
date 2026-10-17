<script lang="ts">
  /**
   * What was broken at your last brief and is fixed now, so you know which
   * fires went out without you. Green is earned: the card renders only when
   * something recovered, never as an "all green" filler.
   *
   * One recovery reads at a glance: the title, a quiet source line, then the
   * recovery as a track (a hatched red stretch up to the fix, solid after it,
   * mono caps clock labels) under one big light number: how long it was down
   * when the timeline says, else how long it has been green. A tall slot adds
   * the timeline (or the writer's what-broke / what-we-did / what-changes
   * lines) and one action that says what it does, "Write post-incident note";
   * the engine switch and copy show on hover. Several recoveries are open
   * rows under a big count, five then "+N more". Every row peeks its timeline
   * and evidence and offers the post-incident note prompt.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefLogo from "./BriefLogo.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { productName } from "./brief-origin.js";
  import {
    agoLabel,
    durationLabel,
    durationParts,
    moreRecoveredPeek,
    moreTimelinePeek,
    orderRecovered,
    plainTitle,
    postIncidentNotePrompt,
    recoveredPeek,
    recoverySpan,
    resolvedCap,
    resolvedHeadline,
    sourceLabel,
    timelineOf,
    utcClock,
    utcHm,
  } from "./brief-resolved.js";
  import type { BriefRecovered } from "./brief-types.js";

  interface Props {
    recovered: BriefRecovered[];
    /** Launch prompts by item id; a row without one gets the built-in post-incident note prompt. */
    prompts: Record<string, string>;
    /** ISO time of the brief, for "5h ago". */
    now: string;
    /** Grid rows of the slot: one-row slots show three rows, two-row slots five. */
    rows: number;
  }

  let { recovered, prompts, now, rows }: Props = $props();
  const brief = useBrief();
  const ordered = $derived(orderRecovered(recovered));
  const tall = $derived(rows > 1);
  const cap = $derived(resolvedCap(rows));
  const shown = $derived(ordered.slice(0, cap));
  const rest = $derived(ordered.slice(cap));
  const one = $derived(ordered.length === 1 ? ordered[0]! : null);
  const timeline = $derived(one ? timelineOf(one) : { shown: [], rest: [] });
  const span = $derived(one ? recoverySpan(one, now) : null);
  /** The big number: how long it was down when known, else how long it has been green. */
  const stat = $derived.by(() => {
    if (!span || !one) return null;
    const ago = agoLabel(one.at, now);
    // A one-row slot keeps "5h ago" on the source line, so its number is only ever the outage.
    if (span.downMs !== null) return { parts: durationParts(span.downMs), lead: "down", then: tall && ago ? `fixed ${ago}` : "then fixed" };
    if (tall && span.upMs !== null) return { parts: durationParts(span.upMs), lead: "green", then: "since the fix" };
    return null;
  });
  /** The source line repeats "5h ago" only when the big number does not already say it. */
  const showWhen = $derived(!tall || !stat);
  const count = $derived(/^(\d+)(.*)$/.exec(resolvedHeadline(ordered)));
  const promptFor = (r: BriefRecovered): string => prompts[r.id] ?? postIncidentNotePrompt(r);
  const product = (r: BriefRecovered): string => productName(r.origin.repo, r.origin.product);
</script>

{#if ordered.length}
  <div class="w c-green" class:tall data-testid="brief-resolved" data-count={ordered.length}>
    <div class="eyebrow">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg> Fixed since your last brief
    </div>

    {#if one && span}
      <h3 class="single" class:tall data-testid="brief-resolved-headline">{resolvedHeadline(ordered)}</h3>
      <div class="one" role="group" aria-label={plainTitle(one.title)} data-testid="brief-resolved-one" use:peek={{ state: brief, content: () => recoveredPeek(one, promptFor(one), now) }}>
        <div class="src">
          <BriefLogo company={brief.company(one.origin.companyUid)} fallback={one.origin.companyUid} size={16} />
          <b data-testid="brief-resolved-product">{product(one)}</b>
          <span class="via">{sourceLabel(one.source)}</span>
          {#if showWhen && agoLabel(one.at, now)}<span class="when">{agoLabel(one.at, now)}</span>{/if}
        </div>
        <div class="sub what">{one.what}</div>

        {#if span.fixedAt}
          <!-- The recovery at a glance: red (hatched) until the fix, green (solid) since. -->
          <div class="viz" data-testid="brief-resolved-track" data-down={span.downMs !== null ? durationLabel(span.downMs) : null}>
            {#if stat}
              <div class="dur" data-testid="brief-resolved-stat">
                <span class="dur-n">{#each stat.parts as p (p.u)}<b>{p.n}</b><i>{p.u}</i>{/each}</span>
                <span class="dur-c"><span>{stat.lead}</span><span>{stat.then}</span></span>
              </div>
            {/if}
            <div class="track" style:--split={span.split} aria-hidden="true">
              <span class="red" class:fade={!span.brokeAt}></span>
              <span class="green"></span>
              {#each span.marks as m, i (i)}<i class="mark" style:left="{m * 100}%"></i>{/each}
              <i class="fix"></i>
            </div>
            <div class="ticks" style:--split={span.split}>
              <span class="t0" data-testid="brief-resolved-broke">Red{#if span.brokeAt}<em>{utcHm(span.brokeAt)}</em>{/if}</span>
              <span class="t1" data-testid="brief-resolved-fixed">Fixed<em>{utcHm(span.fixedAt)}<span class="z">{" UTC"}</span></em></span>
              <span class="t2">Now</span>
            </div>
          </div>
        {/if}

        {#if tall && one.postIncident}
          <div class="pi" data-testid="brief-resolved-post-incident">
            <div><span>What broke</span>{one.postIncident.broke}</div>
            <div><span>What we did</span>{one.postIncident.did}</div>
            <div><span>What changes</span>{one.postIncident.changes}</div>
          </div>
        {:else if tall && timeline.shown.length}
          <div class="tlv" data-testid="brief-resolved-timeline">
            {#each timeline.shown as e, i (`${e.at}-${i}`)}
              <div class="te" class:last={i === timeline.shown.length - 1 && !timeline.rest.length} data-testid="brief-resolved-timeline-entry">
                <span class="clk">{utcClock(e.at) ?? ""}</span><p>{e.text}</p>
              </div>
            {/each}
            {#if timeline.rest.length}
              <div class="more-tl" role="group" aria-label="More timeline" data-testid="brief-resolved-timeline-more" use:peek={{ state: brief, content: () => moreTimelinePeek(one) }}>
                +{timeline.rest.length} more
              </div>
            {/if}
          </div>
        {/if}
      </div>
      {#if tall}
        <div class="start">
          {#if brief.notes[one.id]}<span class="launch-note">{brief.notes[one.id]}</span>{:else}<BriefLaunch id={one.id} prompt={promptFor(one)} label="Write post-incident note" compact />{/if}
        </div>
      {/if}
    {:else}
      <h3 class="count" data-testid="brief-resolved-headline">{#if count}<b class="count-n">{count[1]}</b>{count[2]}{:else}{resolvedHeadline(ordered)}{/if}</h3>
      <div class="list">
        {#each shown as r (r.id)}
          <div class="rec" role="group" aria-label={plainTitle(r.title)} data-testid="brief-resolved-row" use:peek={{ state: brief, content: () => recoveredPeek(r, promptFor(r), now) }}>
            <BriefLogo company={brief.company(r.origin.companyUid)} fallback={r.origin.companyUid} size={18} />
            <div class="txt">
              <div class="t">{plainTitle(r.title)}</div>
              <div class="d">
                <b data-testid="brief-resolved-product">{product(r)}</b>
                <em>{r.what}</em>
              </div>
            </div>
            {#if agoLabel(r.at, now)}<span class="when">{agoLabel(r.at, now)}</span>{/if}
          </div>
        {/each}
        {#if rest.length}
          <div class="rec more" role="group" aria-label="More recovered" data-testid="brief-resolved-more" use:peek={{ state: brief, content: () => moreRecoveredPeek(rest, now) }}>
            +{rest.length} more
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* The house label style: mono, all caps, tracked. */
  .when,
  .via,
  .ticks,
  .dur-c,
  .clk,
  .pi span,
  .more-tl,
  .rec.more {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  h3.single {
    font-size: var(--b-fs-title);
  }
  h3.single.tall {
    font-size: var(--b-fs-title-lg);
  }

  .w {
    container: resolved / inline-size;
  }
  /* One recovery. */
  .one {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    margin-top: 8px;
  }
  .one > * {
    flex-shrink: 0;
  }
  /* When the slot is shorter than the story, whole timeline lines drop out of sight (they wrap
     into a hidden column) rather than running under the action; the peek has every line. */
  .one > :is(.tlv, .pi) {
    flex-shrink: 1;
    min-height: 0;
    overflow: hidden;
  }
  .src {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    white-space: nowrap;
  }
  .src b {
    font-size: 12px;
    font-weight: 500;
    color: var(--b-t1);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .via,
  .when {
    color: var(--b-t3);
  }
  .via {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* A narrow card keeps the product and the age; the source waits for the peek. */
  @container resolved (max-width: 300px) {
    .via {
      display: none;
    }
  }
  .what {
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The recovery: a big light number over a slim track. Centred in what room the card has. */
  .viz {
    margin-top: 14px;
    min-width: 0;
    container-type: inline-size;
  }
  .tall .viz {
    margin-block: auto;
    padding-top: 14px;
  }
  .dur {
    display: flex;
    align-items: flex-end;
    gap: 12px;
    margin-bottom: 14px;
  }
  .dur-n {
    display: inline-flex;
    align-items: baseline;
    white-space: nowrap;
    color: var(--b-t1);
  }
  .dur-n b {
    font-size: 30px;
    font-weight: 300;
    letter-spacing: -0.04em;
    line-height: 0.9;
  }
  .tall .dur-n b {
    font-size: 40px;
  }
  .dur-n i {
    font-style: normal;
    font-size: 14px;
    font-weight: 400;
    margin: 0 8px 0 2px;
    color: var(--b-t2);
  }
  .dur-n i:last-child {
    margin-right: 0;
  }
  .dur-c {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-bottom: 2px;
    line-height: 1.1;
    color: var(--b-t2);
    min-width: 0;
  }
  .dur-c span:first-child {
    color: var(--b-t1);
  }
  /* The track: inset by the fix dot's radius so the dot and the labels never clip. */
  .track {
    position: relative;
    height: 6px;
    margin: 0 6px;
  }
  .track > * {
    position: absolute;
    top: 0;
    bottom: 0;
  }
  .red {
    left: 0;
    width: calc(var(--split) * 100%);
    border-radius: 3px 0 0 3px;
    background:
      repeating-linear-gradient(-45deg, color-mix(in srgb, var(--b-red) 85%, transparent) 0 1.5px, transparent 1.5px 5px),
      rgb(var(--b-ink) / 0.12);
  }
  /* The start is unknown: the red stretch fades in from nothing rather than claiming a time. */
  .red.fade {
    -webkit-mask: linear-gradient(90deg, transparent, #000 60%);
    mask: linear-gradient(90deg, transparent, #000 60%);
  }
  .green {
    left: calc(var(--split) * 100%);
    right: 0;
    border-radius: 0 3px 3px 0;
    background: rgb(var(--b-ink) / 0.92);
  }
  .mark,
  .fix {
    top: 50%;
    bottom: auto;
    border-radius: 50%;
    transform: translate(-50%, -50%);
  }
  .mark {
    width: 6px;
    height: 6px;
    background: rgb(var(--b-ink) / 0.92);
  }
  .fix {
    left: calc(var(--split) * 100%);
    width: 12px;
    height: 12px;
    background: #fff;
  }
  .ticks {
    position: relative;
    height: 12px;
    margin: 9px 6px 0;
    line-height: 12px;
    color: var(--b-t3);
    white-space: nowrap;
  }
  .ticks > span {
    position: absolute;
    top: 0;
  }
  .ticks em {
    font-style: normal;
    margin-left: 6px;
    color: var(--b-t1);
  }
  .t0 {
    left: -6px;
  }
  .t1 {
    left: calc(var(--split) * 100% - 6px);
  }
  .t2 {
    right: -6px;
  }
  /* The fix clock names its zone where there is room for it. */
  .z {
    display: none;
  }
  @container (min-width: 380px) {
    .z {
      display: inline;
    }
  }
  /* A narrow card names the moments and leaves the clocks to the peek. */
  @container (max-width: 300px) {
    .ticks em {
      display: none;
    }
  }

  .pi {
    display: flex;
    flex-flow: column wrap;
    gap: 6px;
    margin-top: 16px;
    font-size: 13px;
    line-height: 1.35;
    color: var(--b-t1);
  }
  .pi div {
    width: 100%;
    display: flex;
    gap: 12px;
    align-items: baseline;
    min-width: 0;
  }
  .pi span {
    flex: none;
    width: 96px;
    color: var(--b-t3);
  }

  /* Timeline: a mono clock and one line per entry, the last one (the fix) in full ink. */
  .tlv {
    display: flex;
    flex-flow: column wrap;
    gap: 5px;
    margin-top: 16px;
    min-width: 0;
  }
  .te {
    width: 100%;
    display: flex;
    gap: 12px;
    align-items: baseline;
    min-width: 0;
    font-size: 12px;
    line-height: 1.3;
    color: var(--b-t2);
  }
  .te.last {
    color: var(--b-t1);
  }
  .clk {
    flex: none;
    width: 72px;
    color: var(--b-t3);
  }
  .te p {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .more-tl {
    align-self: flex-start;
    margin-left: 84px;
    padding: 0 8px;
    height: 20px;
    line-height: 20px;
    border-radius: 6px;
    color: var(--b-t2);
    background: rgb(var(--b-ink) / 0.14);
    transition: background 0.15s;
  }
  .more-tl:hover {
    background: rgb(var(--b-ink) / 0.22);
  }

  /* The one action: says what it does, mono caps on soft glass; filled white on hover.
     The engine switch and copy wait for the pointer (they also live in the peek). */
  .start {
    margin-top: 16px;
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .start :global(.launch) {
    gap: 4px;
    text-shadow: none;
  }
  .start :global(.launch .go) {
    height: 28px;
    padding: 0 10px 0 12px;
    gap: 8px;
    border-radius: 6px;
    font-size: 10px;
    color: var(--b-t1);
    background: rgb(var(--b-ink) / 0.14);
    box-shadow: none;
  }
  .start :global(.launch .go svg) {
    width: 12px;
    margin-left: 0;
    opacity: 0.85;
  }
  .start :global(.launch .go:hover),
  .start :global(.launch .go:focus-visible) {
    color: #18181b;
    background: #fff;
    outline: none;
  }
  .start :global(.launch .go:hover svg) {
    margin-left: 0;
    opacity: 1;
  }
  .start :global(.launch .eng) {
    height: 28px;
    padding: 2px;
    border-radius: 6px;
    background: rgb(var(--b-ink) / 0.14);
  }
  .start :global(.launch .eng button) {
    height: 24px;
    padding: 0 6px;
    border-radius: 5px;
    color: rgb(var(--b-ink) / 0.75);
  }
  .start :global(.launch .eng button:hover) {
    background: rgb(var(--b-ink) / 0.22);
    color: var(--b-t1);
  }
  .start :global(.launch .eng button[aria-pressed="true"]) {
    background: #fff;
    color: #18181b;
  }
  .start :global(.launch .copy) {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: rgb(var(--b-ink) / 0.14);
    color: var(--b-t1);
  }
  .start :global(.launch .copy:hover) {
    background: rgb(var(--b-ink) / 0.22);
  }
  .start :global(.launch :is(.eng, .copy)) {
    opacity: 0;
    visibility: hidden;
    transition:
      opacity 0.2s,
      visibility 0.2s;
  }
  .w:is(:hover, :focus-within) .start :global(.launch :is(.eng, .copy)) {
    opacity: 1;
    visibility: visible;
  }

  /* Several recoveries: a big light count, then open rows (glass only under the pointer). */
  h3.count {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--b-t2);
  }
  h3.count .count-n {
    font-size: 40px;
    font-weight: 300;
    letter-spacing: -0.04em;
    line-height: 0.9;
    color: var(--b-t1);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 12px -8px 0;
    min-height: 0;
  }
  .rec {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 6px 8px;
    border-radius: 6px;
    min-width: 0;
    transition: background 0.15s;
  }
  .rec:hover {
    background: rgb(var(--b-ink) / 0.14);
  }
  .txt {
    flex: 1;
    min-width: 0;
  }
  .t {
    font-size: 13px;
    font-weight: 500;
    line-height: 1.25;
    color: var(--b-t1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .d {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin-top: 2px;
    font-size: 11px;
    line-height: 1.3;
    color: var(--b-t3);
    min-width: 0;
  }
  .d b {
    font-weight: 500;
    color: var(--b-t2);
    white-space: nowrap;
  }
  .d em {
    font-style: normal;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rec .when {
    flex: none;
    align-self: flex-start;
    margin-top: 2px;
  }
  .rec.more {
    align-self: flex-start;
    height: 22px;
    margin: 4px 0 0 8px;
    padding: 0 8px;
    color: var(--b-t2);
    background: rgb(var(--b-ink) / 0.14);
  }
  .rec.more:hover {
    background: rgb(var(--b-ink) / 0.22);
  }
</style>
