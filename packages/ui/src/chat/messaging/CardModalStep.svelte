<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  /**
   * One row of a numbered list of steps inside a card modal: the number, a
   * one-line instruction, and an optional action on the right. Put the rows
   * in `<ol class="card-modal-step-list">`. A step can also carry more under
   * its row (`more`): what a person needs while they are on that step.
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
    /**
     * What the step needs under its row while a person is on it: a short list
     * of instructions, a field, a status line. Lined up with the words.
     */
    more?: Snippet;
  }

  let { number, state, text, detail = null, action, more }: Props = $props();
</script>

<li
  class="card-modal-step"
  data-testid="card-modal-step"
  data-state={state}
  data-more={more ? "true" : undefined}
  aria-current={state === "current" ? "step" : undefined}
>
  <span class="card-modal-step-num" aria-hidden="true">
    {#if state === "done"}
      <RailIcon name="check" size={12} />
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
  {#if more}
    <div class="card-modal-step-more" data-testid="card-modal-step-more">{@render more()}</div>
  {/if}
</li>
