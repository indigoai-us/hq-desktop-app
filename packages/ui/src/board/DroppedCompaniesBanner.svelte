<script lang="ts">
  /**
   * Visible surface for companies excluded from the vended STS realtime
   * scope (US-008 AC4). Boards for these companies still render from REST,
   * but live thread wakes are unavailable — never fail silently.
   */
  import type { CompanyBoardScope } from "./company-scopes";

  interface Props {
    scopes: readonly CompanyBoardScope[];
  }

  let { scopes }: Props = $props();

  const dropped = $derived(scopes.filter((s) => s.realtimeDropped));
</script>

{#if dropped.length > 0}
  <div
    class="dropped-banner"
    role="status"
    data-testid="dropped-companies-banner"
  >
    <strong>Realtime limited:</strong>
    live updates are unavailable for
    {dropped.map((s) => s.label).join(", ")} — the credential policy budget excluded
    {dropped.length === 1 ? "this company" : "these companies"}. Boards refresh
    from the server instead.
  </div>
{/if}

<style>
  .dropped-banner {
    padding: 8px 12px;
    border: 1px solid var(--warn-ink, #fbbf24);
    border-radius: 8px;
    background: color-mix(in srgb, var(--warn-ink, #fbbf24) 8%, transparent);
    color: var(--t1);
    font-size: 12px;
    line-height: 1.4;
  }
</style>
