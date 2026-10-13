<script lang="ts">
  /**
   * What was broken at your last brief and is fixed now, so you know which
   * fires went out without you. Green is earned: the card renders only when
   * something recovered, never as an "all green" filler. One recovery shows
   * its timeline (or the writer's what-broke / what-we-did / what-changes
   * lines); several show rows with the product logo, a plain title, a mono
   * "when" and what fixed it, five then "+N more". Every row peeks its
   * timeline and evidence and offers the post-incident note prompt.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefLogo from "./BriefLogo.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { productName } from "./brief-origin.js";
  import {
    agoLabel,
    moreRecoveredPeek,
    moreTimelinePeek,
    orderRecovered,
    plainTitle,
    postIncidentNotePrompt,
    recoveredPeek,
    resolvedCap,
    resolvedHeadline,
    timelineOf,
    utcClock,
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
  const promptFor = (r: BriefRecovered): string => prompts[r.id] ?? postIncidentNotePrompt(r);
  const product = (r: BriefRecovered): string => productName(r.origin.repo, r.origin.product);
</script>

{#if ordered.length}
  <div class="w c-green" data-testid="brief-resolved" data-count={ordered.length}>
    <div class="eyebrow">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg> Fixed since your last brief
    </div>
    <h3 class:single={!!one} class:tall data-testid="brief-resolved-headline">{resolvedHeadline(ordered)}</h3>

    {#if one}
      <div class="one" role="group" aria-label={plainTitle(one.title)} data-testid="brief-resolved-one" use:peek={{ state: brief, content: () => recoveredPeek(one, promptFor(one), now) }}>
        <div class="src">
          <BriefLogo company={brief.company(one.origin.companyUid)} fallback={one.origin.companyUid} size={20} />
          <b data-testid="brief-resolved-product">{product(one)}</b>
          {#if agoLabel(one.at, now)}<span class="when">{agoLabel(one.at, now)}</span>{/if}
        </div>
        <div class="sub what">{one.what}</div>
        {#if tall && one.postIncident}
          <div class="pi" data-testid="brief-resolved-post-incident">
            <div><span>What broke</span>{one.postIncident.broke}</div>
            <div><span>What we did</span>{one.postIncident.did}</div>
            <div><span>What changes</span>{one.postIncident.changes}</div>
          </div>
        {:else if tall && timeline.shown.length}
          <div class="tlv" data-testid="brief-resolved-timeline">
            {#each timeline.shown as e, i (`${e.at}-${i}`)}
              <div class="te" data-testid="brief-resolved-timeline-entry"><i></i><p><span>{utcClock(e.at) ?? ""}</span>{e.text}</p></div>
            {/each}
            {#if timeline.rest.length}
              <div class="te more-tl" role="group" aria-label="More timeline" data-testid="brief-resolved-timeline-more" use:peek={{ state: brief, content: () => moreTimelinePeek(one) }}>
                <i class="hollow"></i><p>+{timeline.rest.length} more</p>
              </div>
            {/if}
          </div>
        {/if}
      </div>
      {#if tall}
        <div class="start">
          {#if brief.notes[one.id]}<span class="launch-note">{brief.notes[one.id]}</span>{:else}<BriefLaunch id={one.id} prompt={promptFor(one)} compact />{/if}
          <span class="hint">Post-incident note</span>
        </div>
      {/if}
    {:else}
      <div class="list">
        {#each shown as r (r.id)}
          <div class="rec" role="group" aria-label={plainTitle(r.title)} data-testid="brief-resolved-row" use:peek={{ state: brief, content: () => recoveredPeek(r, promptFor(r), now) }}>
            <BriefLogo company={brief.company(r.origin.companyUid)} fallback={r.origin.companyUid} size={20} />
            <div class="txt">
              <div class="t">{plainTitle(r.title)}</div>
              <div class="d">
                <b data-testid="brief-resolved-product">{product(r)}</b>
                {#if agoLabel(r.at, now)}<span class="when">{agoLabel(r.at, now)}</span>{/if}
                <em>{r.what}</em>
              </div>
            </div>
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
  h3.single.tall {
    font-size: var(--b-fs-title-lg);
  }
  h3.single {
    font-size: var(--b-fs-title);
  }
  /* One recovery: source line, what fixed it, then the timeline or the writer's three lines. */
  .one {
    display: flex;
    flex-direction: column;
    min-width: 0;
    margin-top: 10px;
  }
  .src {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .src b {
    font-size: 11.5px;
    font-weight: 500;
    color: rgb(var(--b-ink) / 0.9);
    white-space: nowrap;
  }
  .when {
    font-family: var(--b-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: rgb(var(--b-ink) / 0.65);
    white-space: nowrap;
  }
  .what {
    margin-top: 6px;
  }
  .pi {
    display: grid;
    gap: 5px;
    margin-top: 12px;
    font-size: 12.5px;
    line-height: 1.35;
    color: rgb(var(--b-ink) / 0.92);
  }
  .pi div {
    display: flex;
    gap: 10px;
    align-items: baseline;
  }
  .pi span {
    flex: none;
    min-width: 86px;
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgb(var(--b-ink) / 0.6);
  }
  /* Timeline, as in the approved masthead: white dots on a faint rail, mono UTC clock above each line. */
  .tlv {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 14px;
    position: relative;
  }
  .tlv::before {
    content: "";
    position: absolute;
    left: 5px;
    top: 6px;
    bottom: 6px;
    width: 2px;
    background: rgb(var(--b-ink) / 0.25);
  }
  .te {
    display: flex;
    gap: 14px;
    font-size: 12.5px;
    line-height: 1.3;
    position: relative;
    min-width: 0;
  }
  .te i {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--b-t1);
    flex: none;
    margin-top: 2px;
    box-shadow: 0 0 0 3px rgb(var(--b-ink) / 0.2);
  }
  .te i.hollow {
    background: rgb(var(--b-ink) / 0.3);
    box-shadow: none;
  }
  .te p {
    margin: 0;
    min-width: 0;
  }
  .te span {
    font-family: var(--b-mono);
    font-size: 10px;
    color: rgb(var(--b-ink) / 0.65);
    display: block;
    margin-bottom: 1px;
  }
  .more-tl p {
    font-family: var(--b-mono);
    font-size: 10.5px;
    letter-spacing: 0.06em;
    color: rgb(var(--b-ink) / 0.8);
    align-self: center;
  }
  .start {
    margin-top: auto;
    padding-top: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .hint {
    font-family: var(--b-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgb(var(--b-ink) / 0.6);
  }
  /* Several recoveries: glass rows (gradient and hairline rim, no inner shadow, no backdrop-filter). */
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
    min-height: 0;
  }
  .rec {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 8px 10px;
    border-radius: 12px;
    min-width: 0;
    background: rgb(var(--b-ink) / 0.07);
    border: 1px solid rgb(var(--b-ink) / 0.14);
    transition: background 0.2s;
  }
  .rec:hover {
    background: rgb(var(--b-ink) / 0.07);
  }
  .txt {
    flex: 1;
    min-width: 0;
  }
  .t {
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .d {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin-top: 2px;
    font-size: 11.5px;
    color: rgb(var(--b-ink) / 0.76);
    min-width: 0;
  }
  .d b {
    font-weight: 500;
    color: rgb(var(--b-ink) / 0.9);
    white-space: nowrap;
  }
  .d em {
    font-style: normal;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rec.more {
    justify-content: center;
    padding: 6px 10px;
    font-family: var(--b-mono);
    font-size: 10.5px;
    letter-spacing: 0.06em;
    color: rgb(var(--b-ink) / 0.8);
  }
</style>
