<script lang="ts">
  /** What you shipped yesterday. Holographic foil = an achievement; the edge follows your pointer. */
  import BriefOrigin from "./BriefOrigin.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { shippedDigest } from "./brief-distill.js";
  import { countUp } from "./count-up.js";

  import type { BriefInput, BriefShipped } from "./brief-types.js";

  let {
    shipped,
    merged,
    opened,
    cols,
    rows,
    prWindow = null,
  }: {
    shipped: BriefShipped[];
    merged: number | null;
    opened: number | null;
    cols: number;
    rows: number;
    prWindow?: BriefInput["prWindow"];
  } = $props();
  const brief = useBrief();
  const n = $derived(cols >= 3 && rows === 1 ? Math.min(3, shipped.length) : rows > 1 ? 6 : Math.min(cols >= 2 ? 3 : 2, shipped.length));
  const shown = $derived(shipped.slice(0, n));

  function track(event: PointerEvent): void {
    const el = event.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--hx", `${((event.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty("--hy", `${((event.clientY - r.top) / r.height) * 100}%`);
    el.style.setProperty("--ang", `${(Math.atan2(event.clientY - r.top - r.height / 2, event.clientX - r.left - r.width / 2) * 180) / Math.PI + 90}deg`);
  }
</script>

<div class="w" data-testid="brief-shipped">
  <div class="top">
    <div>
      <div class="eyebrow" style="color:var(--b-ok)">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg> Run complete · yesterday
      </div>
      <h3>What you shipped</h3>
      {#if prWindow}
        {@const win = prWindow}
        <div
          class="win"
          role="group"
          aria-label="PRs in the window"
          use:peek={{
            state: brief,
            content: () => ({
              title: `${win.total} PRs · ${win.merged} merged`,
              status: `${win.from} to ${win.to}`,
              sections: [{ label: "By repo", lines: win.byRepo.map((r) => ({ label: r.repo, state: `${r.merged}/${r.total}`, tone: "ok" as const })) }],
            }),
          }}
        >{win.from.slice(5)} to {win.to.slice(5)} · {win.total} PRs · {win.merged} merged</div>
      {/if}
    </div>
    <div class="tot">
      <div><span class="big" use:countUp={merged ?? shipped.length}>0</span><small>{merged != null ? "merged" : "shipped"}</small></div>
      {#if opened != null}<div><span class="big dim" use:countUp={opened}>0</span><small>opened</small></div>{/if}
    </div>
  </div>
  <div class="runs" style="--cols:{Math.max(1, Math.min(3, shown.length))}">
    {#each shown as s (s.id)}
      <div
        class="run"
        role="group"
        aria-label={`${s.title} · ${s.status}`}
        onpointermove={track}
        use:peek={{ state: brief, content: () => {
          const d = shippedDigest(s.lines);
          return { sample: s.sample, title: `${s.title} · ${s.status}`, status: d.mix, sections: [{ label: "Worth knowing", lines: d.highlights }] };
        } }}
      >
        <BriefOrigin origin={s.origin} />
        <div class="v">{s.title} · {s.status}</div>
        {#if rows === 1 && cols < 3}{:else}<div class="s">{s.note}</div>{/if}
        {#if rows > 1}
          <div class="rl">
            {#each s.lines.slice(0, 2) as l, i (i)}<div><span>{l.label}</span><em class="tone-{l.tone ?? 'neutral'}">{l.state}</em></div>{/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .win {
    margin-top: 4px;
    font-family: var(--b-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: rgba(255, 255, 255, 0.32);
  }
  .tot {
    display: flex;
    gap: 16px;
    align-items: baseline;
  }
  .tot .big {
    font-size: 36px;
  }
  .tot .dim {
    color: rgba(255, 255, 255, 0.56);
  }
  .tot small {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.56);
    margin-left: 6px;
  }
  .runs {
    flex: 1;
    display: grid;
    gap: 10px;
    margin-top: 12px;
    grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr));
    grid-auto-rows: 1fr;
    min-height: 0;
  }
  .run {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    border-radius: 14px;
    padding: 10px 12px;
    /* Glass: lit from the top, hairline rim, soft drop. No backdrop-filter
       (WKWebView draws it as a square that ignores the radius). */
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.025) 42%, rgba(255, 255, 255, 0.015)),
      radial-gradient(120% 60% at 20% 0%, rgba(255, 255, 255, 0.06), transparent 60%);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-top-color: rgba(255, 255, 255, 0.18);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.08),
      0 1px 2px rgba(0, 0, 0, 0.3),
      0 8px 20px -8px rgba(0, 0, 0, 0.5);
    min-width: 0;
  }
  .run :global(.org) {
    margin-bottom: 5px;
  }
  /* Holographic foil, only on shipped work. */
  .run::before {
    content: "";
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s;
    background: linear-gradient(115deg, transparent 20%, rgba(255, 120, 200, 0.22) 35%, rgba(120, 220, 255, 0.22) 50%, rgba(180, 255, 150, 0.2) 62%, transparent 78%);
    background-size: 250% 250%;
    background-position: var(--hx, 50%) var(--hy, 50%);
    mix-blend-mode: color-dodge;
  }
  .run::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1.2px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s;
    background: conic-gradient(from var(--ang, 0deg), #ff7ac6, #7ad7ff, #b6ff8a, #ffd36e, #ff7ac6);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
  }
  .run:hover::before {
    opacity: 1;
  }
  .run:hover::after {
    opacity: 0.95;
  }
  .v {
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.25;
  }
  .s {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.56);
    margin-top: 3px;
  }
  .rl {
    margin-top: auto;
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .rl div {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.56);
    padding-top: 6px;
    border-top: 1px solid var(--b-line);
  }
  .rl span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rl em {
    font-style: normal;
    font-family: var(--b-mono);
    font-size: 9.5px;
    white-space: nowrap;
  }
</style>
