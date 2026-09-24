<script lang="ts">
  interface Props {
    upgradeUrl: string;
    onUpgrade: (url: string) => void | Promise<void>;
    testId?: string;
  }

  let {
    upgradeUrl,
    onUpgrade,
    testId = 'plan-upgrade-action',
  }: Props = $props();
</script>

<button
  type="button"
  class="plan-upgrade-action"
  aria-label="Upgrade plan"
  data-testid={testId}
  onclick={() => onUpgrade(upgradeUrl)}
>
  Upgrade
</button>

<style>
  .plan-upgrade-action {
    flex-shrink: 0;
    padding: 4px 6px;
    border: 0;
    border-radius: 0;
    color: var(--v4-text-1, var(--c-text, currentColor));
    background: transparent;
    font: inherit;
    font-weight: 500;
    text-decoration: underline;
    cursor: pointer;
  }

  .plan-upgrade-action:focus-visible {
    outline: 2px solid var(--v4-text-1, currentColor);
    outline-offset: 2px;
  }
</style>
