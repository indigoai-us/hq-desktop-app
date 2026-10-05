<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { dismissable } from "../../common/dismissable.js";
  /**
   * Live bot session pane. Transcript lines append; lists past 200 rows
   * window. Stop asks before the pane switches to the ended state.
   */
  import { onMount } from "svelte";
  import {
    PROFILE_PANE_WIDTH,
    TRANSCRIPT_ROW_HEIGHT,
    appendTranscript,
    cancelStop,
    confirmStop,
    requestStop,
    transcriptWindow,
    type SessionLine,
    type SessionPhase,
    type SessionTotals,
  } from "./profile-pane-model.js";

  interface Props {
    name: string;
    context: string;
    lines?: SessionLine[];
    totals: SessionTotals;
    phase?: SessionPhase;
    onclose?: () => void;
    onphase?: (phase: SessionPhase) => void;
  }

  let {
    name,
    context,
    lines = [],
    totals,
    phase = "live",
    onclose,
    onphase,
  }: Props = $props();

  let localLines = $state<SessionLine[]>([]);
  let seen = 0;
  let scrollTop = $state(0);
  let viewport = $state(320);
  let scroller = $state<HTMLDivElement | null>(null);
  let openTools = $state<Record<string, boolean>>({});

  $effect(() => {
    if (lines.length < seen) {
      localLines = [...lines];
      seen = lines.length;
      return;
    }
    if (lines.length > seen) {
      let next = localLines;
      for (let i = seen; i < lines.length; i += 1) next = appendTranscript(next, lines[i]!);
      localLines = next;
      seen = lines.length;
    }
  });

  const win = $derived(transcriptWindow(localLines.length, scrollTop, viewport));
  const visible = $derived(localLines.slice(win.start, win.end));

  onMount(() => {
    if (!scroller) return;
    const measure = () => {
      viewport = scroller?.clientHeight ?? 320;
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(scroller);
    return () => obs.disconnect();
  });

  function setPhase(next: SessionPhase) {
    onphase?.(next);
  }
</script>

<aside
  class="pane"
  style:width="{PROFILE_PANE_WIDTH}px"
  aria-label="{name} session"
  data-testid="bot-session-pane"
  data-phase={phase}
>
  <header class="phead">
    <span class="mark" aria-hidden="true">⌁</span>
    <b>{name}</b>
    <span>Session</span>
    {#if phase === "ended"}<span class="ended">ended</span>{/if}
    <button type="button" class="icon" data-testid="bot-session-close" aria-label="Close session" onclick={() => onclose?.()}>✕</button>
  </header>
  <div class="sbar" data-testid="bot-session-stats">
    <span><b>{totals.elapsed}</b> {phase === "ended" ? "total" : "elapsed"}</span>
    <span><b>{totals.tokensIn}</b> in · <b>{totals.tokensOut}</b> out</span>
    <span><b>{totals.turns}</b> turns</span>
    <span><b>{totals.model}</b></span>
  </div>
  <div class="ctx">{context}</div>
  {#if phase === "ended"}
    <div class="outcome" data-testid="bot-session-outcome">
      <div class="k">Outcome</div>
      {totals.outcome}
    </div>
  {/if}
  <div
    class="tx"
    bind:this={scroller}
    data-testid="bot-session-transcript"
    data-windowed={win.windowed ? "true" : "false"}
    onscroll={() => (scrollTop = scroller?.scrollTop ?? 0)}
  >
    <div style:height="{win.padTop}px"></div>
    {#each visible as line (line.id)}
      {#if line.kind === "tool"}
        <button
          type="button"
          class="tc"
          class:run={line.running}
          style:min-height="{TRANSCRIPT_ROW_HEIGHT}px"
          data-testid="bot-session-tool"
          aria-expanded={openTools[line.id] ? "true" : "false"}
          onclick={() => (openTools[line.id] = !openTools[line.id])}
        >
          <span class="ts">{line.at}</span>
          <span class="chv">{openTools[line.id] ? "▾" : "▸"}</span>
          <span class="t">{line.name} <span class="mono">{line.detail}</span></span>
          <span class="r">{line.running ? "running" : (line.result ?? "")}</span>
        </button>
        {#if openTools[line.id]}
          <div class="tool-body" data-testid="bot-session-tool-body">{line.detail}{line.result ? ` · ${line.result}` : ""}</div>
        {/if}
      {:else}
        <div class="ln" style:min-height="{TRANSCRIPT_ROW_HEIGHT}px">
          <span class="ts">{line.at}</span>
          <span class="who">{line.who}</span>
          <div>{line.text}{#if phase === "live" && line.id === localLines.at(-1)?.id}<span class="cursor" aria-hidden="true"></span>{/if}</div>
        </div>
      {/if}
    {/each}
    <div style:height="{win.padBottom}px"></div>
  </div>
  <div class="sact">
    {#if phase === "ended"}
      <button type="button" class="btn primary" data-testid="bot-session-rerun"><RailIcon name="refresh" />Re-run</button>
    {:else}
      <button type="button" class="btn dz" data-testid="bot-session-stop" onclick={() => setPhase(requestStop(phase))}><RailIcon name="stop" />Stop</button>
      <button type="button" class="btn"><RailIcon name="stop" />Pause</button>
    {/if}
    <span class="grow"></span>
    <button type="button" class="btn"><RailIcon name="claude-code" />Open in Claude Code</button>
  </div>
  {#if phase === "confirm-stop"}
    <div class="confirm" role="alertdialog" aria-label="Stop session" data-testid="bot-session-confirm" use:dismissable={{ onclose: () => setPhase(cancelStop(phase)) }}>
      <div class="ct">Stop {name}'s session?</div>
      <div class="cb">{context} stops now. The transcript is kept. Scheduled jobs are untouched.</div>
      <div class="ca">
        <button type="button" class="btn" data-testid="bot-session-stop-cancel" onclick={() => setPhase(cancelStop(phase))}><RailIcon name="x" />Cancel</button>
        <button type="button" class="btn dz" data-testid="bot-session-stop-confirm" onclick={() => setPhase(confirmStop(phase))}><RailIcon name="stop" />Stop</button>
      </div>
    </div>
  {/if}
</aside>

<style>
  .pane {
    position: relative; box-sizing: border-box; max-width: 100%; height: 100%; min-height: 0;
    display: grid; grid-template-rows: 52px auto auto minmax(0, 1fr) 52px;
    background: var(--v4-secondary-sidebar, var(--side-bg));
    color: var(--v4-text-2); font-size: 13px;
  }
  .pane:has(.outcome) { grid-template-rows: 52px auto auto auto minmax(0, 1fr) 52px; }
  .phead, .sact {
    display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px;
    border-bottom: 1px solid var(--v4-rowline, var(--line));
  }
  .sact { border-bottom: 0; border-top: 1px solid var(--v4-rowline, var(--line)); }
  .phead b { color: var(--v4-text-1); font-size: var(--type-body, 14px); }
  .mark { width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; background: var(--v4-control-bg); color: var(--v4-text-1); font-size: 11px; }
  .ended { color: var(--v4-text-3); font-size: 11px; }
  .icon { margin-left: auto; width: 24px; height: 24px; border: 0; background: transparent; color: var(--v4-text-3); cursor: pointer; }
  .sbar { display: flex; gap: 14px; padding: 10px 16px 0; font-size: 12px; color: var(--v4-text-3); overflow: auto; }
  .sbar b { font-weight: 500; color: var(--v4-text-1); font-family: var(--font-mono, "Geist Mono", monospace); }
  .ctx { padding: 6px 16px 10px; font-size: 12px; color: var(--v4-text-3); border-bottom: 1px solid var(--v4-rowline, var(--line)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .outcome { padding: 10px 16px; border-bottom: 1px solid var(--v4-rowline, var(--line)); color: var(--v4-text-1); font-size: 13px; }
  .k { font-family: var(--font-mono, "Geist Mono", monospace); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--v4-text-3); margin-bottom: 4px; }
  .tx { overflow: auto; padding: 10px 12px; min-height: 0; }
  .ln { display: grid; grid-template-columns: 50px minmax(0, 1fr); gap: 1px 8px; padding: 5px 4px; line-height: 1.45; }
  .ts { font-family: var(--font-mono, "Geist Mono", monospace); font-size: 11px; color: var(--v4-text-3); }
  .ln .ts { grid-row: 1 / 3; padding-top: 2px; }
  .who { font-weight: 600; color: var(--v4-text-1); font-size: 12px; }
  .ln > div { grid-column: 2; color: var(--v4-text-1); }
  .tc {
    display: grid; grid-template-columns: 50px 10px minmax(0, 1fr) auto; gap: 8px; align-items: center;
    width: 100%; padding: 4px; border: 0; border-radius: 6px; background: transparent;
    font: inherit; font-size: 12px; color: var(--v4-text-2); text-align: left; cursor: pointer;
  }
  .tc:hover { background: var(--v4-hover); }
  .tc .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mono { font-family: var(--font-mono, "Geist Mono", monospace); font-size: 11px; }
  .tc .r { font-family: var(--font-mono, "Geist Mono", monospace); font-size: 11px; color: var(--v4-text-3); }
  .tc.run .r { color: var(--v4-ok); }
  .tool-body { margin: 0 4px 6px 68px; font-family: var(--font-mono, "Geist Mono", monospace); font-size: 11px; color: var(--v4-text-3); }
  .cursor { display: inline-block; width: 6px; height: 12px; margin-left: 3px; background: var(--v4-text-1); vertical-align: text-bottom; }
  .grow { flex: 1; }
  .btn {
    border: 1px solid var(--v4-control-border, var(--line)); background: var(--v4-control-faint, transparent);
    color: var(--v4-text-1); border-radius: var(--v4-radius-button, 6px); padding: 4px 8px; font: inherit; cursor: pointer; white-space: nowrap;
  }
  .btn.primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); border-color: transparent; }
  .btn.dz { color: var(--v4-error); }
  .confirm {
    position: absolute; left: 16px; right: 16px; bottom: 64px;
    background: var(--v4-popover, var(--v4-ground)); border: 1px solid var(--v4-hairline, var(--line));
    border-radius: 8px; padding: 12px; box-shadow: var(--v4-shadow-popover, 0 8px 24px rgba(0,0,0,.35));
    color: var(--v4-text-1);
  }
  .ct { font-weight: 600; margin-bottom: 6px; }
  .cb { font-size: 12px; color: var(--v4-text-2); line-height: 1.45; }
  .ca { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; }
</style>
