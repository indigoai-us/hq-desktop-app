<script lang="ts">
  /**
   * What the team is on. Rows: 5 in a two-row or three-column slot, 3 in a
   * W, then a "+N more" row whose peek lists the rest. Each row: monogram with
   * a status dot, name, agent chip, DM count, a load tag only when earned
   * (heavy, storm), a green tick when a thank-you is due, and a work-level
   * line (the writer's status first, else the latest DM, never a PR number).
   * Hover reveals DM (copies a draft prompt) and, when a thanks is recorded,
   * Thanks (starts a session that drafts the note and asks before sending).
   * The peek shows what is between you and the live DM thread.
   */
  import { copyBriefPrompt, peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import type { BriefTeammate } from "./brief-types.js";
  import { onMount } from "svelte";
  import { shortAgo, teammateReplyPrompt } from "./brief-dms.js";
  import { teamFooter, teamLimit, teamStatus, thanksPrompt, toneTag } from "./brief-team.js";

  interface Props {
    team: BriefTeammate[];
    rows: number;
    /** Columns of the slot: a W3 (3 wide, one row) shows 5 rows like an M. */
    cols?: number;
  }
  let { team, rows, cols = 2 }: Props = $props();
  const brief = useBrief();
  const GRAD = ["#a855f7,#6d28d9", "#38bdf8,#1d4ed8", "#34d399,#047857", "#fb923c,#c2410c", "#f472b6,#be185d", "#a3e635,#4d7c0f"];
  const DOT: Record<string, string> = { ok: "var(--b-ok)", warn: "var(--b-warn)", decision: "var(--b-decision)", red: "var(--b-red)", neutral: "rgb(var(--b-ink) / .32)" };
  const shown = $derived(team.slice(0, teamLimit(rows, cols)));
  const rest = $derived(team.slice(shown.length));
  const foot = $derived(teamFooter(team));
  let copied = $state<string | null>(null);

  /** Real senders (a uid, not a sample) have live DMs to read. */
  const live = (t: BriefTeammate) => !t.sample && /^(prs|agt)_/.test(t.id);
  const latest = (t: BriefTeammate) => {
    const l = brief.dms[t.id];
    return l?.state === "ready" ? (l.dms[0] ?? null) : null;
  };
  /** The row's line and whether it came from a DM (then the age shows). */
  const status = (t: BriefTeammate) => teamStatus(t, latest(t)?.text ?? null);
  const loaded = (t: BriefTeammate) => t.load === "heavy" || t.load === "storm";
  const thanksId = (t: BriefTeammate) => `thanks:${t.id}`;

  function dmPrompt(t: BriefTeammate): string {
    const l = brief.dms[t.id];
    if (l?.state === "ready") return teammateReplyPrompt(t.name, l.dms, t.isAgent);
    const about = t.detail?.next ? ` ${t.detail.next}` : "";
    return `Draft a short, friendly DM to ${t.name} in my voice.${about} Do not send it; show me the draft.`;
  }

  onMount(() => {
    for (const t of shown) if (live(t)) void brief.loadDms(t.id);
  });

  /** Sections every teammate peek shares: owes, thanks, between, owns, suggested. */
  function sections(t: BriefTeammate): PeekContent["sections"] {
    const out: PeekContent["sections"] = [];
    if (t.owes?.length) out.push({ label: "Owes you", lines: t.owes.map((o) => ({ label: o, state: "" })) });
    if (t.thanks) out.push({ label: "Worth a thank-you", tone: "ok", lines: [{ label: t.thanks, state: "", tone: "ok", prompt: { id: thanksId(t), text: thanksPrompt(t) } }] });
    if (t.detail?.between.length) out.push({ label: "Between you", lines: t.detail.between });
    if (t.detail?.owns.length) out.push({ label: "Owns", lines: t.detail.owns.map((o) => ({ label: o, state: "" })) });
    if (t.detail?.next) out.push({ label: "Suggested", text: t.detail.next });
    return out;
  }

  function content(t: BriefTeammate): PeekContent {
    const line = status(t);
    const st = t.detail?.status ?? (line.fromDm ? (t.isAgent ? "Agent" : undefined) : line.text || undefined);
    if (live(t)) {
      return { title: t.name, status: st, sections: sections(t), dms: { uid: t.id, name: t.name, isAgent: !!t.isAgent } };
    }
    return { sample: t.sample, title: t.name, status: st, sections: sections(t), prompt: { id: `dm:${t.id}`, text: dmPrompt(t) } };
  }

  const morePeek = (): PeekContent => ({
    title: `${rest.length} more`,
    status: "Also on the team",
    sections: [
      {
        label: "Team",
        lines: rest.map((t) => {
          const line = teamStatus(t, null).text;
          return { label: line ? `${t.name} — ${line}` : t.name, state: toneTag(t.tone), tone: t.tone === "decision" ? ("decision" as const) : t.tone === "warn" ? ("warn" as const) : undefined };
        }),
      },
    ],
  });

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
      {@const line = status(t)}
      {@const m = latest(t)}
      <div class="p" role="group" aria-label={t.name} data-testid="brief-team-row" use:peek={{ state: brief, content: () => content(t) }}>
        <div class="mono" style="background:{GRAD[i % GRAD.length].split(',')[1]};--s:{DOT[t.tone]}">{t.name[0]}</div>
        <div class="txt">
          <div class="n">
            <span class="nm">{t.name}</span>
            {#if t.isAgent}<span class="tag" data-testid="brief-team-agent">agent</span>{/if}
            {#if t.dmCount}<span class="cnt" data-testid="brief-team-count">{t.dmCount}</span>{/if}
            {#if loaded(t)}<span class="load" data-load={t.load} data-testid="brief-team-load">{t.load}</span>{/if}
            {#if t.thanks}
              <svg class="tick" viewBox="0 0 24 24" aria-label="Worth a thank-you" role="img" data-testid="brief-team-thanks"><title>{t.thanks}</title><path d="m5 12 4.5 4.5L19 7" /></svg>
            {/if}
          </div>
          {#if line.fromDm && m}
            <div class="d" data-testid="brief-team-preview">{line.text} <span class="ago">· {shortAgo(m.at)}</span></div>
          {:else}
            <div class="d" data-testid="brief-team-status">{line.text}</div>
          {/if}
          {#if brief.notes[thanksId(t)]}<div class="d note" role="status">{brief.notes[thanksId(t)]}</div>{/if}
        </div>
        <div class="acts">
          {#if t.thanks}
            <button type="button" class="act" style="--g:#34d399,#047857" data-testid="brief-team-say-thanks" onclick={() => void brief.start(thanksId(t), thanksPrompt(t))}>THANKS</button>
          {/if}
          <button type="button" class="act" style="--g:{GRAD[i % GRAD.length]}" onclick={() => void draft(t)}>{copied === t.id ? "COPIED" : "DM"}</button>
        </div>
      </div>
    {/each}
    {#if rest.length}
      <div class="more" role="button" tabindex="0" data-testid="brief-team-more" use:peek={{ state: brief, content: morePeek }}>+{rest.length} more</div>
    {/if}
  </div>
  {#if rows > 1}
    <div class="foot" data-testid="brief-team-foot"><span>{foot}</span></div>
  {/if}
</div>

<style>
  .ppl {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 16px;
  }
  .p {
    position: relative;
    display: flex;
    gap: 11px;
    align-items: center;
    padding: 6px 8px;
    margin: -6px -8px;
    border-radius: 6px;
    transition: background 0.25s;
  }
  .p:hover {
    background: rgb(var(--b-ink) / 0.045);
  }
  .mono {
    position: relative;
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: 6px;
    display: grid;
    place-items: center;
    font-weight: 500;
    font-size: 13px;
    color: #fff;
    box-shadow: none;
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
    flex: 1;
  }
  .n {
    font-size: 13px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .nm {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Glass chips: flat translucent fill with a lit top edge, no inset wells. */
  .tag,
  .cnt,
  .load {
    flex: none;
    font-family: var(--b-mono);
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0;
    padding: 0 6px;
    border-radius: 999px;
    line-height: 16px;
    color: var(--b-t2);
    background: rgb(var(--b-ink) / 0.06);
    border: 1px solid rgb(var(--b-ink) / 0.1);
  }
  .cnt {
    text-transform: none;
    font-size: 11px;
  }
  .load[data-load="heavy"] {
    color: var(--b-warn);
    border-color: rgba(255, 211, 122, 0.3);
  }
  .load[data-load="storm"] {
    color: var(--b-red);
    border-color: rgba(255, 69, 58, 0.35);
  }
  .tick {
    flex: none;
    width: 13px;
    height: 13px;
    stroke: var(--b-ok);
    fill: none;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ago {
    color: rgb(var(--b-ink) / 0.4);
  }
  .d {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11px;
    color: rgb(var(--b-ink) / 0.56);
    line-height: 1.3;
  }
  .d.note {
    color: var(--b-t1);
  }
  /* Actions appear only on the row that has your attention. */
  .acts {
    position: absolute;
    right: 8px;
    top: 50%;
    translate: 6px -50%;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.3s, translate 0.3s;
  }
  .p:hover .acts,
  .p:focus-within .acts {
    opacity: 1;
    translate: 0 -50%;
  }
  .act {
    all: unset;
    cursor: pointer;
    font-family: var(--b-mono);
    font-size: 11px;
    letter-spacing: 0;
    color: rgb(var(--b-ink) / 0.7);
    padding: 5px 8px;
    border-radius: 8px;
    background: rgb(var(--b-ink) / 0.07);
    border: 1px solid rgb(var(--b-ink) / 0.1);
    transition: background 0.2s, color 0.2s;
  }
  /* Each action takes on its own colour: the teammate's for DM, green for thanks. */
  .act:hover,
  .act:focus-visible {
    color: #fff;
    background: var(--g);
    border-color: transparent;
    box-shadow: none;
    outline: none;
  }
  .more {
    align-self: stretch;
    text-align: center;
    padding: 5px 10px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--b-t2);
    background: rgb(var(--b-ink) / 0.05);
    border: 1px solid rgb(var(--b-ink) / 0.08);
    cursor: default;
  }
  .more:hover,
  .more:focus-visible {
    background: rgb(var(--b-ink) / 0.09);
    outline: none;
  }
</style>
