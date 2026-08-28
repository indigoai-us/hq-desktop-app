<script lang="ts">
  /**
   * Shared empty / "No data" surface. Used when a pane has nothing real to
   * show — never a fixture stand-in.
   */
  interface Props {
    title?: string;
    copy?: string;
    testid?: string;
  }

  let {
    title = "No data",
    copy = "Nothing to show yet.",
    testid = "empty-state",
  }: Props = $props();
</script>

<div class="empty-state chat-shell" data-testid={testid} role="status">
  <p class="empty-state-title">{title}</p>
  {#if copy}
    <p class="empty-state-copy">{copy}</p>
  {/if}
</div>

<style>
  .empty-state {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 1.5rem 1.25rem;
    min-width: 0;
    min-height: 0;
    text-align: center;
  }

  .empty-state-title {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--t1);
  }

  .empty-state-copy {
    margin: 0;
    font-size: 13px;
    font-weight: 400;
    color: var(--t2);
  }
</style>
