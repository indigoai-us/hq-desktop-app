<script lang="ts">
  /**
   * One line inside a card modal saying what is happening: something is
   * under way (a spinner), it worked (a check), or it did not (a problem).
   * A problem is announced at once; the others when the reader is free.
   */
  import type { CardModalStatusKind } from "./card-modal.js";

  interface Props {
    kind: CardModalStatusKind;
    text: string;
  }

  let { kind, text }: Props = $props();
</script>

<p
  class="card-modal-status"
  data-testid="card-modal-status"
  data-kind={kind}
  role={kind === "problem" ? "alert" : "status"}
>
  <span class="card-modal-status-mark" aria-hidden="true">
    {#if kind === "working"}
      <span class="card-modal-spinner"></span>
    {:else if kind === "done"}
      <svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.5 11L3.5 8l1-1 2 2 5-5 1 1z" fill="currentColor" /></svg>
    {:else}
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 2.2l6 10.6H2zM8 6.6v3M8 11.4v.2" />
      </svg>
    {/if}
  </span>
  <span class="card-modal-status-text">{text}</span>
</p>
