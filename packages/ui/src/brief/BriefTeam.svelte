<script lang="ts">
  /** What the team is on. Each row reveals a DM-draft action on hover; the peek shows what is between you. */
  import { copyBriefPrompt, peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import type { BriefTeammate } from "./brief-types.js";

  let { team, rows }: { team: BriefTeammate[]; rows: number } = $props();
  const brief = useBrief();
  const GRAD = ["#a855f7,#6d28d9", "#38bdf8,#1d4ed8", "#34d399,#047857", "#fb923c,#c2410c", "#f472b6,#be185d", "#a3e635,#4d7c0f"];
  const DOT: Record<string, string> = { ok: "var(--b-ok)", warn: "var(--b-warn)", decision: "var(--b-violet)", red: "var(--b-red)", neutral: "rgba(255,255,255,.32)" };
  const shown = $derived(team.slice(0, rows > 2 ? 6 : 3));
  const needYou = $derived(team.filter((t) => t.tone === "decision").length);
  let copied = $state<string | null>(null);

  function dmPrompt(t: BriefTeammate): string {
    const about = t.detail?.next ?? t.doing;
    return `Draft a short, friendly DM to ${t.name} in my voice. Context: ${t.doing}. ${about} Do not send it; show me the draft.`;
  }

  function content(t: BriefTeammate): PeekContent {
    const sections: PeekContent["sections"] = [];
    if (t.detail?.between.length) sections.push({ label: "Between you", lines: t.detail.between });
    if (t.detail?.owns.length) sections.push({ label: "Owns", lines: t.detail.owns.map((o) => ({ label: o, state: "" })) });
    if (t.detail?.next) sections.push({ label: "Suggested", text: t.detail.next });
    return { title: t.name, status: t.detail?.status ?? t.doing, sections, prompt: { id: `dm:${t.id}`, text: dmPrompt(t) } };
  }

  async function draft(t: BriefTeammate): Promise<void> {
    if (await copyBriefPrompt(dmPrompt(t))) {
      copied = t.id;
      setTimeout(() => (copied = null), 1400);
    }
  }
</script>

<div class="w" data-testid="brief-team">
  <div class="eyebrow">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2" /><path d="M3 19c.8-3 3.2-4.6 6-4.6s5.2 1.6 6 4.6M16 5.2a3 3 0 0 1 0 5.6M18 14.6c1.6.6 2.6 2 3 4.4" /></svg> Team
  </div>
  <h3>What they're on</h3>
  <div class="ppl">
    {#each shown as t, i (t.id)}
      <div class="p" role="group" aria-label={t.name} use:peek={{ state: brief, content: () => content(t) }}>
        <div class="mono" style="background:linear-gradient(145deg,{GRAD[i % GRAD.length]});--s:{DOT[t.tone]}">{t.name[0]}</div>
        <div class="txt"><div class="n">{t.name}</div><div class="d">{t.doing}</div></div>
        <button type="button" class="act" style="--g:{GRAD[i % GRAD.length]}" title="Copy a DM-draft prompt" onclick={() => void draft(t)}>{copied === t.id ? "COPIED" : "DM"}</button>
      </div>
    {/each}
  </div>
  {#if rows > 2}
    <div class="foot"><span>{team.length} active</span><span>{needYou} need you</span></div>
  {/if}
</div>

<style>
  .ppl {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 18px;
  }
  .p {
    position: relative;
    display: flex;
    gap: 11px;
    align-items: center;
    padding: 6px 8px;
    margin: -6px -8px;
    border-radius: 12px;
    transition: background 0.25s;
  }
  .p:hover {
    background: rgba(255, 255, 255, 0.045);
  }
  .mono {
    position: relative;
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: 12px;
    display: grid;
    place-items: center;
    font-weight: 500;
    font-size: 14px;
    color: #fff;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3), 0 4px 10px rgba(0, 0, 0, 0.4);
  }
  .mono::after {
    content: "";
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--s);
    border: 2px solid var(--b-card);
  }
  .txt {
    min-width: 0;
  }
  .n {
    font-size: 13px;
    font-weight: 500;
  }
  .d {
    font-size: 11.5px;
    color: rgba(255, 255, 255, 0.56);
    line-height: 1.3;
  }
  .act {
    all: unset;
    cursor: pointer;
    position: absolute;
    right: 8px;
    top: 50%;
    margin-top: -12px;
    opacity: 0;
    translate: 6px 0;
    transition: opacity 0.3s, translate 0.3s, background 0.2s;
    font-family: var(--b-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.56);
    padding: 5px 8px;
    border-radius: 8px;
    background: var(--b-card-hi);
    box-shadow: var(--b-well);
  }
  .p:hover .act,
  .p:focus-within .act {
    opacity: 1;
    translate: 0 0;
  }
  /* DM takes on the teammate's colour. */
  .act:hover {
    color: #fff;
    background: linear-gradient(145deg, var(--g));
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }
</style>
