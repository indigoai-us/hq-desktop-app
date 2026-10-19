<script lang="ts">
  /**
   * The run's activity on the sunrise field: proof of life and what the bot
   * found. Each row leads with one pixel cell, as the strip under it: lit for
   * done, beating for the running item, faint for skipped, the page's one
   * accent for failed, with the label alone. A detail shows only on other
   * rows, and only as one short plain line (`shownDetail`). New items slide in; the
   * last few stay visible and older ones fade. Below: elapsed time, the usual
   * duration once there are two past runs, and a calm "Still working on …"
   * line when status.json has been quiet for 90 seconds. After 20 seconds
   * with no new activity the last row says "still working…" and for how long,
   * so a long writing step still shows life. The block keeps a reserved
   * height so the elapsed line never jumps.
   */
  import { fly } from "svelte/transition";
  import { shownDetail, type BriefActivity } from "./brief-runs.js";

  interface Props {
    activity: readonly BriefActivity[];
    visible?: number;
    elapsed?: string | null;
    estimate?: string | null;
    stillWorking?: string | null;
    /** How long the activity list has been unchanged, once past the idle threshold. */
    idle?: string | null;
  }
  let { activity, visible = 5, elapsed = null, estimate = null, stillWorking = null, idle = null }: Props = $props();
  const shown = $derived(activity.slice(-visible));
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
</script>

<div class="act" data-testid="brief-activity" style:--rows={visible}>
  <!-- One row: the status on the left (it truncates first), the elapsed time on the right of its last line. -->
  <div class="status-row" data-testid="brief-status-row">
  {#if shown.length}
    <ul>
      {#each shown as a, i (`${a.at}|${a.label}`)}
        {@const idleHere = !!idle && i === shown.length - 1}
        {@const detail = shownDetail(a)}
        <li
          class={a.state}
          style:opacity={Math.max(0.35, 1 - (shown.length - 1 - i) * 0.16)}
          data-state={a.state}
          data-testid="brief-activity-item"
          in:fly={{ y: reduced ? 0 : 8, duration: reduced ? 0 : 260 }}
        >
          <span class="mark" aria-hidden="true">
            {#if (a.state === "done" && !idleHere) || a.state === "failed" || a.state === "skipped"}<span class="cell"></span>{:else}<span class="cell pulse"></span>{/if}
          </span>
          <span class="lbl">{a.label}{#if detail}{" "}<span class="det">· {detail}</span>{/if}{#if idleHere}{" "}<span class="det idle" data-testid="brief-activity-idle">· still working… {idle}</span>{/if}</span>
        </li>
      {/each}
    </ul>
  {/if}
  {#if elapsed}
    <p class="time" data-testid="brief-elapsed">{elapsed}{#if estimate}{" "}<span>· {estimate}</span>{/if}</p>
  {/if}
  </div>
  {#if stillWorking}<p class="still" data-testid="brief-still-working">{stillWorking}</p>{/if}
</div>

<style>
  /* Left aligned on the field, over the progress strip; white ink on colour (the field sets --b-ink). */
  .act {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-end;
    gap: 8px;
    width: 100%;
    /* Reserved: the rows (the elapsed time rides on the last), so nothing below moves. */
    min-height: calc(var(--rows, 1) * 21px);
  }
  .status-row {
    display: flex;
    align-items: flex-end;
    gap: 16px;
    width: 100%;
    min-width: 0;
  }
  ul {
    flex: 1 1 auto;
    min-width: 0;
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    font-size: 13px;
    line-height: 17px;
    color: rgb(var(--b-ink) / 0.92);
    transition: opacity 0.4s ease;
  }
  li .lbl {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mark {
    display: grid;
    place-items: center;
    width: 8px;
    flex: none;
  }
  /* The strip's cell: 8 px, 1.5 px corners; lit when done. */
  .cell {
    display: block;
    width: 8px;
    height: 8px;
    border-radius: 1.5px;
    background: rgb(var(--b-ink) / 0.92);
  }
  li.skipped {
    color: rgb(var(--b-ink) / 0.55);
  }
  li.skipped .cell {
    background: rgb(var(--b-ink) / 0.16);
  }
  li.failed .cell {
    background: var(--b-hot, #c9765a);
  }
  .det {
    color: rgb(var(--b-ink) / 0.66);
  }
  .pulse {
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }
  .still {
    margin: 0;
    font-size: 13px;
    color: rgb(var(--b-ink) / 0.78);
  }
  /* On the right of the last status line, centred on it (its 17px line box). */
  .time {
    flex: none;
    margin: 0 0 0 auto;
    padding: 1.5px 0;
    white-space: nowrap;
    font-family: var(--b-code, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 500;
    line-height: 14px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgb(var(--b-ink) / 0.7);
  }
  .time span {
    color: rgb(var(--b-ink) / 0.55);
  }
</style>
