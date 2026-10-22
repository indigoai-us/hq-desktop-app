<script lang="ts">
  import RailIcon from '@hq/ui/rail-icon';
  interface Props {
    upgradeUrl: string;
    onUpgrade: (url: string) => void | Promise<void>;
    testId?: string;
    /** Button text. A usage pause (US-024) passes "Open Billing". */
    label?: string;
  }

  let {
    upgradeUrl,
    onUpgrade,
    testId = 'plan-upgrade-action',
    label = 'Upgrade',
  }: Props = $props();
</script>

<button
  type="button"
  class="plan-upgrade-action"
  aria-label={label === 'Upgrade' ? 'Upgrade plan' : label}
  data-testid={testId}
  onclick={() => onUpgrade(upgradeUrl)}
>
  <RailIcon name="external" />{label}
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
