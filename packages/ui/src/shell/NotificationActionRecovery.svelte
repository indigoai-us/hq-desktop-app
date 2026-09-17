<script lang="ts">
  interface Props {
    message: string;
    pending?: boolean;
    onretry: () => void | Promise<void>;
  }

  let { message, pending = false, onretry }: Props = $props();
</script>

<div
  class="notification-action-recovery"
  role="alert"
  data-testid="notification-action-recovery"
>
  <span>{message}</span>
  <button
    type="button"
    disabled={pending}
    aria-busy={pending}
    onclick={() => void onretry()}
  >
    {pending ? 'Retrying…' : 'Retry'}
  </button>
</div>

<style>
  .notification-action-recovery {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 30px;
    padding: 5px 12px;
    border-block: 1px solid var(--pop-border, rgb(255 255 255 / 10%));
    color: var(--popover-danger, #f28b82);
    font-size: 11px;
    line-height: 1.35;
  }

  span {
    min-width: 0;
    flex: 1;
  }

  button {
    flex: 0 0 auto;
    padding: 2px 0;
    border: 0;
    background: transparent;
    color: var(--pop-text, #e8e8e8);
    font: inherit;
    font-weight: 650;
    cursor: pointer;
  }

  button:disabled {
    color: var(--pop-muted, #888);
    cursor: wait;
  }

  button:focus-visible {
    outline: 1.5px solid var(--popover-focus-ring, #a0a0a0);
    outline-offset: 2px;
  }
</style>
