<script lang="ts">
  /**
   * The run's activity under the sunrise: proof of life and what the bot
   * found. Done items carry a check, the running item pulses, skipped items
   * are dim, failed ones amber with their reason. New items slide in; the
   * last few stay visible and older ones fade. Below: elapsed time, the usual
   * duration once there are two past runs, and a calm "Still working on …"
   * line when status.json has been quiet for 90 seconds. After 20 seconds
   * with no new activity the last row says "still working…" and for how long,
   * so a long writing step still shows life. The block keeps a reserved
   * height so the elapsed line never jumps.
   */
  import { fly } from "svelte/transition";
  import type { BriefActivity } from "./brief-runs.js";

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
  {#if shown.length}
    <ul>
      {#each shown as a, i (`${a.at}|${a.label}`)}
        {@const idleHere = !!idle && i === shown.length - 1}
        <li
          class={a.state}
          style:opacity={Math.max(0.35, 1 - (shown.length - 1 - i) * 0.16)}
          data-state={a.state}
          data-testid="brief-activity-item"
          in:fly={{ y: reduced ? 0 : 8, duration: reduced ? 0 : 260 }}
        >
          <span class="mark" aria-hidden="true">
            {#if a.state === "done" && !idleHere}✓{:else if a.state === "failed"}!{:else if a.state === "skipped"}–{:else}<span class="pulse"></span>{/if}
          </span>
          <span class="lbl">{a.label}{#if a.detail}{" "}<span class="det">· {a.detail}</span>{/if}{#if idleHere}{" "}<span class="det idle" data-testid="brief-activity-idle">· still working… {idle}</span>{/if}</span>
        </li>
      {/each}
    </ul>
  {/if}
  {#if stillWorking}<p class="still" data-testid="brief-still-working">{stillWorking}</p>{/if}
  {#if elapsed}
    <p class="time" data-testid="brief-elapsed">{elapsed}{#if estimate}{" "}<span>· {estimate}</span>{/if}</p>
  {/if}
</div>

<style>
  .act {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
    width: min(560px, 100%);
    /* Reserved: the rows plus the elapsed line, so nothing below moves. */
    min-height: calc(var(--rows, 1) * 19px + 24px);
  }
  ul {
    max-width: 100%;
  }
  li .lbl {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 3px;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12.5px;
    color: rgba(255, 255, 255, 0.82);
    transition: opacity 0.4s ease;
  }
  .mark {
    width: 12px;
    flex: none;
    text-align: center;
    font-size: 11px;
    color: #ffb580;
  }
  li.skipped {
    color: rgba(255, 255, 255, 0.4);
  }
  li.skipped .mark {
    color: rgba(255, 255, 255, 0.4);
  }
  li.failed,
  li.failed .mark {
    color: #fbbf24;
  }
  .det {
    color: rgba(255, 255, 255, 0.45);
  }
  .pulse {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #ffb580;
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
      transform: scale(0.8);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }
  .still,
  .time {
    margin: 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.55);
  }
  .time {
    font-family: var(--b-mono, ui-monospace, monospace);
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
  }
</style>
