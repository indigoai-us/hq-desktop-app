<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
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
      <RailIcon name="check" size={14} />
    {:else}
      <RailIcon name="warning" size={14} />
    {/if}
  </span>
  <span class="card-modal-status-text">{text}</span>
</p>
