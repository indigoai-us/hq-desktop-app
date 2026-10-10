<script lang="ts">
  /** A live incident. Pulse dot = live data. Hovering a box inspects it. */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefOrigin from "./BriefOrigin.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { countUp } from "./count-up.js";
  import { redAge, riskPeek } from "./brief-peeks.js";
  import type { BriefRisk } from "./brief-types.js";

  let { risk, prompt, rows, now = new Date().toISOString() }: { risk: BriefRisk; prompt: string | undefined; rows: number; now?: string } = $props();
  const brief = useBrief();
  const tall = $derived(rows > 1);
  const m = $derived(risk.measure);
  const stuck = $derived(m ? m.total - m.healthy : 0);
  const ci = $derived(risk.ci ?? null);
  // Red main CI: a short eyebrow, the workflow as the title, then what and since when.
  const eyebrow = $derived(ci ? `${ci.repo} main CI red` : risk.title);
  const age = $derived(ci ? redAge(ci, now) : null);
  let probe = $state("");
</script>

<div
  class="w c-red"
  data-testid="brief-incident"
  role="group"
  aria-label={risk.title}
  use:peek={{ state: brief, content: () => riskPeek(risk, prompt) }}
>
  <div class="eyebrow inc-eyebrow" data-testid="brief-incident-eyebrow" title={risk.title}><span class="live"></span> {eyebrow} · live</div>
  {#if m}
    <div class="big" style="margin-top:{tall ? 12 : 6}px;font-size:{tall ? 60 : 44}px" use:countUp={stuck}>0</div>
    <div class="sub">of {m.total} {m.unit} stuck.<br />{risk.summary}</div>
  {:else if ci}
    <h3 data-testid="brief-incident-title">{ci.workflow ?? risk.title}</h3>
    <div class="facts" data-testid="brief-incident-facts">
      {#if ci.job}<div><span>Job</span>{ci.job}</div>{/if}
      {#if age}<div><span>Since</span>{age}</div>{/if}
      {#if ci.note && ci.note !== ci.workflow}<div class="note">{ci.note}</div>{/if}
      {#if !tall && risk.links.length}<div><span>Fixes</span>{risk.links.length} in review</div>{/if}
    </div>
  {:else}
    <h3>{risk.summary}</h3>
  {/if}
  {#if tall}
    {#if risk.links.length}
      <div class="prs">{#each risk.links as l (l.label)}<span class="chip"><BriefOrigin origin={{ ...l.origin, repo: l.label }} /></span>{/each}</div>
      <div class="sub" style="font-size:11.5px;margin-top:6px">{risk.links.length} fix{risk.links.length === 1 ? "" : "es"} in review</div>
    {/if}
    {#if prompt}<div class="start">{#if brief.notes[risk.id]}<span class="launch-note">{brief.notes[risk.id]}</span>{:else}<BriefLaunch id={risk.id} {prompt} compact />{/if}</div>{/if}
    {#if m}<div class="probe">{probe || "HOVER A BOX TO INSPECT"}</div>{/if}
  {/if}
  {#if m}
    <div class="dots" class:wide={!tall}>
      {#each Array.from({ length: m.total }, (_, i) => i) as i (i)}
        <i
          role="img"
          aria-label={i < m.healthy ? "Healthy box" : "Stuck box"}
          class:ok={i < m.healthy}
          onmouseenter={() => (probe = `BOX ${i + 1} OF ${m.total} · ${i < m.healthy ? "HEALTHY" : m.cause}`)}
          onmouseleave={() => (probe = "")}
        ></i>
      {/each}
    </div>
  {/if}
</div>

<style>
  .live {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #fff;
    animation: pulse 1.8s infinite;
  }
  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.7);
    }
    70% {
      box-shadow: 0 0 0 9px rgba(255, 255, 255, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(255, 255, 255, 0);
    }
  }
  .inc-eyebrow {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .facts {
    display: grid;
    gap: 4px;
    margin-top: 8px;
    font-size: 12.5px;
    line-height: 1.35;
    color: rgba(255, 255, 255, 0.92);
  }
  .facts span {
    display: inline-block;
    min-width: 52px;
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.6);
  }
  .facts .note {
    color: rgba(255, 255, 255, 0.76);
  }
  .prs {
    display: flex;
    gap: 6px;
    margin-top: 10px;
    flex-wrap: wrap;
  }
  .start {
    margin-top: 10px;
  }
  .probe {
    font-family: var(--b-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    color: rgba(255, 255, 255, 0.85);
    min-height: 14px;
    margin-top: 8px;
  }
  .dots {
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 4px;
    margin-top: auto;
    padding-top: 10px;
  }
  .dots.wide {
    grid-template-columns: repeat(19, 1fr);
    gap: 3px;
  }
  .dots i {
    aspect-ratio: 1;
    border-radius: 2px;
    background: rgba(0, 0, 0, 0.28);
    cursor: crosshair;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .dots i.ok {
    background: #fff;
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.8);
  }
  .dots i:hover {
    transform: scale(1.6);
    box-shadow: 0 0 0 2px #fff, 0 0 12px rgba(255, 255, 255, 0.8);
  }
</style>
