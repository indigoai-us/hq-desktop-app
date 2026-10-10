<script lang="ts">
  /** Yesterday's meetings and how many signals each left behind. */
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { countUp } from "./count-up.js";
  import type { BriefMeeting } from "./brief-types.js";

  let { meetings, rows }: { meetings: BriefMeeting[]; rows: number } = $props();
  const brief = useBrief();
  const decisions = $derived(meetings.reduce((n, m) => n + m.decisions, 0));
  const shown = $derived(meetings.slice(0, rows > 1 ? 6 : 3));

  // Zoom in on what came out of the meeting, not its counts.
  function meetingPeek(m: BriefMeeting): PeekContent {
    const sections: PeekContent["sections"] = [];
    if (m.decided?.length) sections.push({ label: "Decided", lines: m.decided.map((d) => ({ label: d, state: "" })) });
    if (m.todo?.length) sections.push({ label: "To do", lines: m.todo.map((t) => ({ label: t, state: "" })) });
    if (!sections.length && m.summary) sections.push({ label: "Summary", text: m.summary });
    const rest = m.decisions - (m.decided?.length ?? 0) + m.actions - (m.todo?.length ?? 0);
    return {
      title: m.title,
      status: rest > 0 ? `${rest} more in Meetings` : undefined,
      sections,
      actions: [],
    };
  }
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
      use:peek={{ state: brief, content: () => meetingPeek(m) }}
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
