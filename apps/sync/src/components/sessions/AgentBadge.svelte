<script lang="ts">
  // US-025 shared atom: the small "agent" chip that marks non-human members
  // everywhere they appear (rows, roster, mentions). Achromatic by design.
  interface Props {
    label?: string;
  }

  let { label = 'agent' }: Props = $props();
</script>

<span class="ws-agent-badge">{label}</span>

<style>
  .ws-agent-badge {
    display: inline-block;
    flex: none;
    padding: 0 6px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    font-size: 10px;
    line-height: 15px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--v4-text-3);
    background: var(--v4-control-faint);
    user-select: none;
  }
</style>
