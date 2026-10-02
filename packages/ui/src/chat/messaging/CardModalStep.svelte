<script lang="ts">
  /**
   * One row of a numbered list of steps inside a card modal: the number, a
   * one-line instruction, and an optional action on the right. Put the rows
   * in `<ol class="card-modal-step-list">`.
   *
   * A step is done, current or still to do. Done shows a check instead of
   * the number, and a screen reader hears "done".
   */
  import type { Snippet } from "svelte";
  import type { CardModalStepState } from "./card-modal.js";

  interface Props {
    /** The number shown, counted from 1. */
    number: number;
    state: CardModalStepState;
    /** The instruction, one line. */
    text: string;
    /** A quieter second line, e.g. what the step is waiting for. */
    detail?: string | null;
    /** A button or link at the end of the row. */
    action?: Snippet;
  }

  let { number, state, text, detail = null, action }: Props = $props();
</script>

<li
  class="card-modal-step"
  data-testid="card-modal-step"
  data-state={state}
  aria-current={state === "current" ? "step" : undefined}
>
  <span class="card-modal-step-num" aria-hidden="true">
    {#if state === "done"}
      <svg viewBox="0 0 16 16" width="12" height="12"><path d="M6.5 11L3.5 8l1-1 2 2 5-5 1 1z" fill="currentColor" /></svg>
    {:else}
      {number}
    {/if}
  </span>
  <span class="card-modal-step-words">
    <span class="card-modal-step-text">
      <span class="card-modal-sr">{`Step ${number}${state === "done" ? ", done" : ""}: `}</span>{text}
    </span>
    {#if detail}
      <span class="card-modal-step-detail">{detail}</span>
    {/if}
  </span>
  {#if action}
    <span class="card-modal-step-action">{@render action()}</span>
  {/if}
</li>
