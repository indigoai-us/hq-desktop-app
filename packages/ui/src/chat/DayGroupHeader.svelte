<!--
  Day-group header shared by the Messages sidebar and the Meetings rail:
  uppercase 10px day name on the left, date right-aligned (D-13). The label
  comes from daySectionLabel ("TODAY · OCT 2"); a label without " · " renders
  the name alone.
-->
<script lang="ts">
  interface Props {
    label: string;
    id?: string;
    testid?: string;
    section?: string;
  }

  let { label, id, testid, section }: Props = $props();
  const parts = $derived(label.split(" · "));
</script>

<div
  class="chat-section-label chat-day-head"
  {id}
  data-testid={testid}
  data-section={section}
>
  <span>{parts[0]}</span>
  {#if parts[1]}<span class="chat-day-date" data-testid="chat-day-date">{parts[1]}</span>{/if}
</div>

<style>
  .chat-section-label {
    display: flex;
    flex: 0 0 auto;
    margin: 0;
    padding: 12px 8px 4px;
    color: var(--t2);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .chat-day-head {
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .chat-day-date {
    color: var(--t3);
    font-family: var(--font-mono, inherit);
    font-size: 10px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    letter-spacing: normal;
  }
</style>
