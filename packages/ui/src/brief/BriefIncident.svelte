<script lang="ts">
  /** A live incident. Pulse dot = live data. Hovering a box inspects it. */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefOrigin from "./BriefOrigin.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { countUp } from "./count-up.js";
  import type { BriefRisk } from "./brief-types.js";

  let { risk, prompt, rows }: { risk: BriefRisk; prompt: string | undefined; rows: number } = $props();
  const brief = useBrief();
  const tall = $derived(rows > 1);
  const m = $derived(risk.measure);
  const stuck = $derived(m ? m.total - m.healthy : 0);
  let probe = $state("");
</script>

<div
  class="w c-red"
  data-testid="brief-incident"
  role="group"
  aria-label={risk.title}
  use:peek={{ state: brief, content: () => ({ sample: risk.sample, title: risk.title, status: risk.summary, sections: risk.links.length ? [{ label: "Fixes in review", lines: risk.links.map((l) => ({ label: l.label, state: "REVIEW", tone: "warn" as const })) }] : [], prompt: prompt ? { id: risk.id, text: prompt } : undefined }) }}
>
  <div class="eyebrow"><span class="live"></span> {risk.title} · live</div>
  {#if m}
    <div class="big" style="margin-top:{tall ? 12 : 6}px;font-size:{tall ? 60 : 44}px" use:countUp={stuck}>0</div>
    <div class="sub">of {m.total} {m.unit} stuck.<br />{risk.summary}</div>
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
