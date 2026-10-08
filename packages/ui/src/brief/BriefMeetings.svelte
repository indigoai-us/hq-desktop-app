<script lang="ts">
  /** Yesterday's meetings and how many signals each left behind. */
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { countUp } from "./count-up.js";
  import type { BriefMeeting } from "./brief-types.js";

  let { meetings, rows }: { meetings: BriefMeeting[]; rows: number } = $props();
  const brief = useBrief();
  const decisions = $derived(meetings.reduce((n, m) => n + m.decisions, 0));
  const shown = $derived(meetings.slice(0, rows > 1 ? 6 : 3));
</script>

<div class="w" data-testid="brief-meetings">
  <div class="eyebrow">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="3" /><path d="M4 10h16M9 3.5v4M15 3.5v4" /></svg> Yesterday
  </div>
  <div class="hd">
    <span class="big" style="font-size:42px" use:countUp={decisions || meetings.length}>0</span>
    <span class="sub">{decisions ? "decisions logged" : meetings.length === 1 ? "meeting" : "meetings"}</span>
  </div>
  {#each shown as m (m.id)}
    <div
      class="row"
      role="group"
      aria-label={m.title}
      use:peek={{ state: brief, content: () => ({ title: m.title, status: `${m.decisions} decisions · ${m.actions} action items${m.risks ? ` · ${m.risks} risks` : ""}`, sections: m.summary ? [{ label: "Summary", text: m.summary }] : [] }) }}
    >
      <span class="bul" style="background:var(--b-ice)"></span>
      <div>{m.title} {#if m.with}<em>{m.with}</em>{/if}</div>
      {#if m.decisions}<span class="dd" aria-hidden="true">{#each Array.from({ length: Math.min(3, m.decisions) }, (_, i) => i) as i (i)}<i></i>{/each}</span>{/if}
    </div>
  {/each}
</div>

<style>
  .hd {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-top: 6px;
  }
  .dd {
    margin-left: auto;
    display: flex;
    gap: 3px;
    align-self: center;
  }
  .dd i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--b-ice);
    opacity: 0.8;
  }
</style>
