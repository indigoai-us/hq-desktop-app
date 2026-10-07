<script lang="ts">
  /**
   * Home with nothing selected (console-rail US-016, scene home-empty).
   * Paints immediately: no fetch, no spinner.
   */
  interface Props {
    onfind?: () => void;
    onnewmessage?: () => void;
    onnewchannel?: () => void;
  }
  let { onfind, onnewmessage, onnewchannel }: Props = $props();
</script>

<div class="home-empty" data-testid="home-empty" role="status">
  <div class="mark" aria-hidden="true">HQ</div>
  <p class="t">Pick a conversation or press <kbd>⌘N</kbd></p>
  <p class="s">
    Channels and direct messages from every company you belong to show on the left.
    Bots are the rounded squares.
  </p>
  <div class="keys">
    <button type="button" onclick={() => onfind?.()}><kbd>⌘K</kbd> Find anything</button>
    <button type="button" onclick={() => onnewmessage?.()}><kbd>⇧⌘K</kbd> New message</button>
    <button type="button" onclick={() => onnewchannel?.()}><kbd>⇧⌘N</kbd> New channel</button>
  </div>
</div>

<style>
  .home-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 24px 80px;
    text-align: center;
    min-height: 0;
  }
  .mark {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--v4-control-faint);
    border: 1px solid var(--v4-control-border);
    font-size: 13px;
    font-weight: 600;
    color: var(--v4-text-3);
    margin-bottom: 8px;
  }
  .t {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--v4-text-1);
  }
  .s {
    margin: 0;
    font-size: 13px;
    color: var(--v4-text-3);
    max-width: 380px;
    line-height: 1.5;
  }
  .keys {
    display: flex;
    gap: 18px;
    margin-top: 16px;
    font-size: 12px;
    color: var(--v4-text-3);
  }
  .keys button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 0;
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--v4-control-border);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
  }
</style>
