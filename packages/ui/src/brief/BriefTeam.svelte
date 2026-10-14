<script lang="ts">
  /**
   * What the team is on, led by who needs you. The top: one light count with
   * a two-line caption (who needs you, else who you wait on, else how many are
   * active) beside a strip of initial circles for the whole team, the ones
   * who need you ringed in the accent, agents squared. Below: an open list
   * grouped by meaning (Needs you, You're waiting, On it), no boxes. Rows: 5
   * in a two-row or three-column slot, 3 in a W, then "+N more" whose peek
   * lists the rest. Each row: name, agent chip, a load tag only when earned
   * (heavy, storm), a green tick when a thank-you is due, the DM count on the
   * right, and a work-level line (the writer's status, else the latest DM,
   * else what they owe you or the win; never filler like "Agent"). Hover
   * swaps the count for DM (copies a draft prompt) and, when a thanks is
   * recorded, Thanks (starts a session that drafts the note and asks before
   * sending), and lights the person's circle in the strip. The peek shows
   * what is between you and the live DM thread. A wide slot sets the groups
   * side by side.
   */
  import { copyBriefPrompt, peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import type { BriefTeammate } from "./brief-types.js";
  import { onMount } from "svelte";
  import { shortAgo, teammateReplyPrompt } from "./brief-dms.js";
  import { teamFooter, teamGroups, teamHero, teamLimit, teamLine, teamOrder, thanksPrompt, toneTag } from "./brief-team.js";

  interface Props {
    team: BriefTeammate[];
    rows: number;
    /** Columns of the slot: a W3 (3 wide, one row) shows 5 rows like an M. */
    cols?: number;
  }
  let { team, rows, cols = 2 }: Props = $props();
  const brief = useBrief();
  /** Most actionable first: who needs you, who you wait on, then the rest (thanks due first). */
  const ordered = $derived(teamOrder(team));
  const shown = $derived(ordered.slice(0, teamLimit(rows, cols)));
  const rest = $derived(ordered.slice(shown.length));
  const groups = $derived(teamGroups(shown));
  const hero = $derived(teamHero(team));
  const foot = $derived(teamFooter(team));
  /** The strip: everyone up to six circles; past that five and a "+N". */
  const STRIP = 6;
  const faces = $derived(ordered.length > STRIP ? ordered.slice(0, STRIP - 1) : ordered);
  const extra = $derived(ordered.length - faces.length);
  let copied = $state<string | null>(null);
  /** The teammate under the pointer (row or circle): their circle lights, the rest step back. */
  let focus = $state<string | null>(null);

  /** Real senders (a uid, not a sample) have live DMs to read. */
  const live = (t: BriefTeammate) => !t.sample && /^(prs|agt)_/.test(t.id);
  const latest = (t: BriefTeammate) => {
    const l = brief.dms[t.id];
    return l?.state === "ready" ? (l.dms[0] ?? null) : null;
  };
  /** The row's line and whether it came from a DM (then the age shows); empty when there is nothing real to say. */
  const status = (t: BriefTeammate) => teamLine(t, latest(t)?.text ?? null);
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
          const line = teamLine(t, null).text;
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
  <div class="top">
    <!-- The lead: one light count, its meaning on two lines beside it. -->
    <h3 class="hero" data-testid="brief-team-hero" data-key={hero.key}>
      <span class="num">{hero.n}</span>
      <span class="cap"><span class="ln">{hero.line}</span><span class="ln">{hero.sub}</span></span>
    </h3>
    <!-- The whole team at a glance: who needs you ringed in the accent, agents squared. Mirrors the rows, so it is hidden from screen readers. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="strip" class:lit={focus !== null} aria-hidden="true" data-testid="brief-team-strip">
      {#each faces as t (t.id)}
        <span
          class="av"
          class:need={t.tone === "decision"}
          class:bot={t.isAgent}
          class:on={focus === t.id}
          data-id={t.id}
          title={t.name}
          onmouseenter={() => (focus = t.id)}
          onmouseleave={() => (focus = null)}>{t.name[0]}</span
        >
      {/each}
      {#if extra}<span class="av plus">+{extra}</span>{/if}
    </div>
  </div>
  <div class="ppl">
    {#each groups as g (g.key)}
      <div class="grp" data-group={g.key} data-testid="brief-team-group">
        <div class="gl">{g.label}</div>
        {#each g.rows as t (t.id)}
          {@const line = status(t)}
          {@const m = latest(t)}
          <div
            class="p"
            class:on={focus === t.id}
            role="group"
            aria-label={t.name}
            data-testid="brief-team-row"
            use:peek={{ state: brief, content: () => content(t) }}
            onmouseenter={() => (focus = t.id)}
            onmouseleave={() => (focus = null)}
            onfocusin={() => (focus = t.id)}
            onfocusout={() => (focus = null)}
          >
            <div class="n">
              {#if t.tone === "red"}<span class="dot" aria-hidden="true"></span>{/if}
              <span class="nm">{t.name}</span>
              {#if t.isAgent}<span class="tag" data-testid="brief-team-agent">agent</span>{/if}
              {#if loaded(t)}<span class="load" data-load={t.load} data-testid="brief-team-load">{t.load}</span>{/if}
              {#if t.thanks}
                <svg class="tick" viewBox="0 0 24 24" aria-label="Worth a thank-you" role="img" data-testid="brief-team-thanks"><title>{t.thanks}</title><path d="m5 12 4.5 4.5L19 7" /></svg>
              {/if}
            </div>
            <!-- The count sits where the buttons appear; hover swaps one for the other, so nothing moves. -->
            <div class="side">
              {#if t.dmCount}<span class="meta"><span class="cnt" data-testid="brief-team-count">{t.dmCount}</span> {t.dmCount === 1 ? "DM" : "DMs"}</span>{/if}
              <div class="acts">
                {#if t.thanks}
                  <button type="button" class="act" data-testid="brief-team-say-thanks" onclick={() => void brief.start(thanksId(t), thanksPrompt(t))}>THANKS</button>
                {/if}
                <button type="button" class="act" onclick={() => void draft(t)}>{copied === t.id ? "COPIED" : "DM"}</button>
              </div>
            </div>
            {#if line.fromDm && m}
              <div class="d" data-testid="brief-team-preview">{line.text} <span class="ago">· {shortAgo(m.at)}</span></div>
            {:else if line.text}
              <div class="d" data-testid="brief-team-status">{line.text}</div>
            {/if}
            {#if brief.notes[thanksId(t)]}<div class="d note" role="status">{brief.notes[thanksId(t)]}</div>{/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>
  {#if rest.length}
    <div class="more" role="button" tabindex="0" data-testid="brief-team-more" use:peek={{ state: brief, content: morePeek }}>+{rest.length} more</div>
  {/if}
  {#if rows > 1}
    <div class="foot" data-testid="brief-team-foot"><span>{foot}</span></div>
  {/if}
</div>

<style>
  .w {
    container: team / inline-size;
  }
  /* The lead row: the count and its caption on the left, the team's circles on the right. */
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    flex: none;
    min-width: 0;
  }
  .hero {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    margin: 0;
  }
  .num {
    flex: none;
    font-size: var(--b-fs-num, 32px);
    font-weight: 400;
    letter-spacing: -0.035em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--b-t1);
  }
  .cap {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .ln {
    font-size: 13px;
    font-weight: 500;
    letter-spacing: -0.01em;
    line-height: 1.3;
    color: var(--b-t1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ln + .ln {
    font-weight: 400;
    color: var(--b-t2);
  }
  /* Initial circles, side by side; agents are rounded squares. */
  .strip {
    display: flex;
    align-items: center;
    gap: 9px;
    flex: none;
  }
  .av {
    width: 28px;
    height: 28px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 50%;
    font-size: 12px;
    font-weight: 500;
    color: var(--b-t1);
    background: rgb(var(--b-ink) / 0.07);
    transition: opacity 0.25s, background 0.25s;
    cursor: default;
  }
  .av.bot {
    border-radius: 8px;
  }
  /* Needs you: a thin accent ring a step off the circle, the card's one colour. */
  .av.need {
    color: var(--b-hot);
    background: color-mix(in srgb, var(--b-hot) 9%, transparent);
    outline: 1.25px solid var(--b-hot);
    outline-offset: 2px;
  }
  .av.plus {
    font-family: var(--b-code);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--b-t3);
    background: rgb(var(--b-ink) / 0.04);
  }
  /* A row or circle under the pointer: its circle stays, the rest step back. */
  .strip.lit .av:not(.on) {
    opacity: 0.38;
  }
  .strip .av.on {
    background: rgb(var(--b-ink) / 0.12);
  }
  .strip .av.need.on {
    background: color-mix(in srgb, var(--b-hot) 20%, transparent);
  }

  /* The list: open, grouped by what each person asks of you; no boxes. */
  .ppl {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 18px;
    min-width: 0;
  }
  .grp {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .gl {
    margin-bottom: 4px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
  }
  .grp[data-group="need"] .gl {
    color: var(--b-hot);
  }
  .p {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 12px;
    row-gap: 0;
    margin: 0 -10px;
    padding: 6px 10px;
    border-radius: 8px;
    transition: background 0.25s;
  }
  .p:hover,
  .p.on {
    background: rgb(var(--b-ink) / 0.05);
  }
  .n {
    grid-column: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: 20px;
    font-size: 13px;
    font-weight: 500;
  }
  .nm {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--b-red);
  }
  /* Chips in the mono caps label style, a soft fill, no rim. */
  .tag,
  .load {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 18px;
    padding: 0 7px;
    border-radius: 999px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
    background: rgb(var(--b-ink) / 0.06);
  }
  /* Load in page ink; its weight is a small status dot. */
  .load::before {
    content: "";
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--b-warn);
  }
  .load[data-load="storm"]::before {
    background: var(--b-red);
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
  .side {
    grid-column: 2;
    grid-row: 1;
    position: relative;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    height: 20px;
    min-width: 34px;
  }
  .meta {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--b-t3);
    transition: opacity 0.2s;
  }
  .d {
    grid-column: 1 / -1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    line-height: 1.35;
    color: var(--b-t2);
  }
  .ago {
    color: var(--b-t3);
  }
  .d.note {
    color: var(--b-t1);
  }
  /* Actions take the count's place on the row that has your attention. */
  .acts {
    position: absolute;
    right: 0;
    top: 50%;
    translate: 6px -50%;
    display: flex;
    gap: 4px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s, translate 0.25s;
  }
  .p:hover .acts,
  .p:focus-within .acts {
    opacity: 1;
    translate: 0 -50%;
    pointer-events: auto;
  }
  .p:hover .meta,
  .p:focus-within .meta {
    opacity: 0;
  }
  /* DM / THANKS: small mono caps buttons, soft fill; filled in page ink on hover. */
  .act {
    all: unset;
    cursor: pointer;
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
    color: var(--b-t2);
    background: rgb(var(--b-ink) / 0.08);
    transition: background 0.2s, color 0.2s;
  }
  .act:hover,
  .act:focus-visible {
    color: var(--b-bg);
    background: rgb(var(--b-ink) / 0.88);
    outline: none;
  }
  /* The rest of the team: a mono caps line under the list, its peek lists them. */
  .more {
    flex: none;
    align-self: flex-start;
    margin: 8px -8px 0;
    padding: 0 8px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    border-radius: 6px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
    cursor: default;
    transition: background 0.2s, color 0.2s;
  }
  .more:hover,
  .more:focus-visible {
    color: var(--b-t1);
    background: rgb(var(--b-ink) / 0.06);
    outline: none;
  }
  /* A wide slot (three columns): the groups stand side by side, each under its label. */
  @container team (min-width: 560px) {
    .ppl {
      flex-direction: row;
      align-items: flex-start;
      gap: 28px;
    }
    .grp {
      flex: 1 1 0;
    }
  }
</style>
