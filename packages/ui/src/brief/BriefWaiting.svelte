<script lang="ts">
  /** Who you are waiting on. The hourglass runs because you are waiting. */
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { countUp } from "./count-up.js";
  import type { BriefWaiting } from "./brief-types.js";

  let { waiting, prompts }: { waiting: BriefWaiting[]; prompts: Record<string, string> } = $props();
  const brief = useBrief();
</script>

<div class="w c-amber" data-testid="brief-waiting">
  <svg class="glass" viewBox="0 0 34 40" fill="none" aria-hidden="true">
    <path d="M7 3h20M7 37h20M9 3c0 9 8 11 8 17S9 28 9 37M25 3c0 9-8 11-8 17s8 8 8 17" stroke="rgba(255,255,255,.8)" stroke-width="1.6" stroke-linecap="round" />
    <path class="top" d="M11 7h12c-1 5-6 7-6 9 0-2-5-4-6-9z" fill="rgba(255,255,255,.85)" />
    <path class="bot" d="M11 35h12c-1-4-5-6-6-6s-5 2-6 6z" fill="rgba(255,255,255,.85)" />
    <line class="stream" x1="17" y1="17" x2="17" y2="30" stroke="#fff" stroke-width="1.4" />
  </svg>
  <div class="eyebrow">Waiting on</div>
  <div class="big" style="font-size:42px;margin-top:6px" use:countUp={waiting.length}>0</div>
  {#each waiting.slice(0, 3) as w (w.id)}
    <div class="row" role="group" aria-label={`${w.who} ${w.what}`} use:peek={{ state: brief, content: () => ({ sample: w.sample, title: `${w.who} ${w.what}`, status: "You are waiting", sections: [], prompt: prompts[w.id] ? { id: w.id, text: prompts[w.id]! } : undefined }) }}>
      <span class="bul" style="background:#fff"></span><div>{w.who} <em>{w.what}</em></div>
    </div>
  {/each}
</div>

<style>
  .glass {
    position: absolute;
    top: 16px;
    right: 16px;
    width: 30px;
    height: 36px;
  }
  .glass .top {
    transform-box: fill-box;
    transform-origin: 50% 100%;
    animation: drain 4s linear infinite;
  }
  .glass .bot {
    transform-box: fill-box;
    transform-origin: 50% 100%;
    animation: fill 4s linear infinite;
  }
  .glass .stream {
    stroke-dasharray: 2 3;
    animation: fall 0.5s linear infinite;
  }
  @keyframes drain {
    to {
      transform: scaleY(0.15);
    }
  }
  @keyframes fill {
    from {
      transform: scaleY(0.15);
    }
  }
  @keyframes fall {
    to {
      stroke-dashoffset: -5;
    }
  }
  .row em {
    color: rgba(255, 255, 255, 0.76) !important;
  }
</style>
