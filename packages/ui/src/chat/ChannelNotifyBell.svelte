<script lang="ts">
  /**
   * Channel-header bell: pick this channel's notification level (all / files
   * and mentions / mentions only / muted). The host owns the optimistic paint,
   * the server write, and the rollback (`changeNotifyLevel`); this component
   * only renders the current level and reports a pick.
   */
  import {
    NOTIFY_LEVEL_OPTIONS,
    notifyBellLabel,
    type NotifyLevel,
  } from "./notify-level";

  interface Props {
    level: NotifyLevel | null;
    /** True while a change is in flight; picks are ignored. */
    busy?: boolean;
    onchange: (level: NotifyLevel) => void;
  }

  let { level, busy = false, onchange }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);

  const muted = $derived(level === "muted");

  function close(focusTrigger = false): void {
    open = false;
    if (focusTrigger) trigger?.focus();
  }

  function pick(next: NotifyLevel): void {
    if (busy) return;
    close(true);
    if (next !== level) onchange(next);
  }

  function onWindowPointer(event: MouseEvent): void {
    if (!open || !root) return;
    if (event.target instanceof Node && root.contains(event.target)) return;
    close();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      root?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']") ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = index === -1 ? 0 : (index + step + items.length) % items.length;
    items[nextIndex]?.focus();
  }
</script>

<svelte:window onmousedown={onWindowPointer} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="notify-bell-wrap"
  bind:this={root}
  onkeydown={onKeydown}
  onmousedown={(e) => e.stopPropagation()}
>
  <button
    type="button"
    class="notify-bell"
    class:muted
    bind:this={trigger}
    data-testid="channel-notify-bell"
    data-level={level ?? ""}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={notifyBellLabel(level)}
    title={notifyBellLabel(level)}
    onclick={() => (open = !open)}
  >
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      {#if muted}
        <path
          d="M5.2 3.6A3.6 3.6 0 0 1 11.6 6v2.6l1.2 2H5.4M3.9 10.6l.5-.9V6.9"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path d="M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      {:else}
        <path
          d="M4.4 6a3.6 3.6 0 0 1 7.2 0v2.6l1.2 2H3.2l1.2-2V6Z"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linejoin="round"
        />
      {/if}
      <path d="M6.6 12.6a1.5 1.5 0 0 0 2.8 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
    </svg>
  </button>

  {#if open}
    <div
      class="notify-menu"
      role="menu"
      aria-label="Channel notifications"
      data-testid="channel-notify-menu"
    >
      {#each NOTIFY_LEVEL_OPTIONS as option (option.level)}
        <button
          type="button"
          class="notify-item"
          class:current={option.level === level}
          role="menuitemradio"
          aria-checked={option.level === level}
          data-testid={`channel-notify-${option.level}`}
          disabled={busy}
          onclick={() => pick(option.level)}
        >
          <span class="notify-check" aria-hidden="true">
            {#if option.level === level}
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                <path
                  d="M3.5 8.5l3 3 6-7"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            {/if}
          </span>
          <span class="notify-copy">
            <span class="notify-label">{option.label}</span>
            <span class="notify-desc">{option.description}</span>
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .notify-bell-wrap {
    position: relative;
    z-index: 21;
    flex: 0 0 auto;
  }

  .notify-bell {
    appearance: none;
    -webkit-appearance: none;
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 28px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--btn-bg);
    color: var(--t2);
    cursor: pointer;
  }

  .notify-bell:hover {
    border-color: var(--line2);
    color: var(--t1);
  }

  .notify-bell.muted {
    color: var(--t3);
  }

  .notify-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 2px;
    box-sizing: border-box;
    width: 250px;
    padding: 6px;
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    background: var(--panel-bg);
    box-shadow: var(--panel-shadow);
    color: var(--t1);
    font: 400 13px/1.4 var(--font-ui);
    backdrop-filter: blur(40px) saturate(1.5);
    -webkit-backdrop-filter: blur(40px) saturate(1.5);
  }

  .notify-item {
    appearance: none;
    -webkit-appearance: none;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  /* Selection and hover are a background highlight only. */
  .notify-item:hover,
  .notify-item:focus-visible,
  .notify-item.current {
    background: var(--raised);
    outline: none;
  }

  .notify-item:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .notify-check {
    display: grid;
    place-items: center;
    flex: 0 0 12px;
    width: 12px;
    height: 18px;
    color: var(--t1);
  }

  .notify-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .notify-label {
    color: var(--t1);
    font-weight: 500;
  }

  .notify-desc {
    color: var(--t3);
    font-size: 12px;
  }
</style>
