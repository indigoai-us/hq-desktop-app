<script lang="ts">
  /**
   * Channel-header mute control. A bell icon (bell-slash when muted) toggles
   * Muted against the channel's last non-muted level; the chevron (or a
   * right-click on the bell) opens the four levels with a check on the
   * current one. Uses a bell glyph per owner decision 2026-09-25 (previous
   * icon replaced). The host owns the optimistic paint, the server write,
   * and the rollback (`changeNotifyLevel`).
   */
  import {
    NOTIFY_LEVEL_OPTIONS,
    muteToggleLabel,
    notifyLevelLabel,
    toggledMuteLevel,
    type NotifyLevel,
  } from "./notify-level";

  interface Props {
    level: NotifyLevel | null;
    /** Last non-muted level for this channel; a one-click unmute restores it. */
    rememberedLevel?: NotifyLevel | null;
    /** True while a change is in flight; clicks are ignored. */
    busy?: boolean;
    onchange: (level: NotifyLevel) => void;
  }

  let { level, rememberedLevel = null, busy = false, onchange }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement | null>(null);
  let chevron = $state<HTMLButtonElement | null>(null);

  const muted = $derived(level === "muted");

  function close(focusChevron = false): void {
    open = false;
    if (focusChevron) chevron?.focus();
  }

  function toggleMute(): void {
    if (busy) return;
    onchange(toggledMuteLevel(level, rememberedLevel));
  }

  function openMenu(event?: MouseEvent): void {
    event?.preventDefault();
    open = true;
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
  class="mute-wrap"
  class:muted
  bind:this={root}
  onkeydown={onKeydown}
  onmousedown={(e) => e.stopPropagation()}
>
  <button
    type="button"
    class="mute-toggle"
    data-testid="channel-mute-toggle"
    data-level={level ?? ""}
    aria-pressed={muted}
    aria-label={muteToggleLabel(level)}
    title={level ? `${muteToggleLabel(level)} (now: ${notifyLevelLabel(level)})` : muteToggleLabel(level)}
    disabled={busy}
    onclick={toggleMute}
    oncontextmenu={openMenu}
  >
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d="M8 2.5a3.3 3.3 0 0 0-3.3 3.3v2.1c0 .55-.2 1.08-.57 1.49L3 10.75h10l-1.13-1.35a2.3 2.3 0 0 1-.57-1.49V5.8A3.3 3.3 0 0 0 8 2.5Z"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
      <path
        d="M6.6 12.5a1.5 1.5 0 0 0 2.8 0"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
      />
      {#if muted}
        <path d="M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      {/if}
    </svg>
  </button>
  <button
    type="button"
    class="mute-chevron"
    bind:this={chevron}
    data-testid="channel-notify-menu-toggle"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label="Channel notification level"
    onclick={() => (open = !open)}
  >
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
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
  .mute-wrap {
    position: relative;
    z-index: 21;
    display: inline-flex;
    align-items: stretch;
    flex: 0 0 auto;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--btn-bg);
    color: var(--t2);
  }

  .mute-wrap:hover {
    border-color: var(--line2);
  }

  .mute-wrap.muted {
    color: var(--t3);
  }

  .mute-toggle,
  .mute-chevron {
    appearance: none;
    -webkit-appearance: none;
    display: inline-grid;
    place-items: center;
    height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .mute-toggle {
    width: 28px;
    border-radius: 8px 0 0 8px;
  }

  .mute-chevron {
    width: 18px;
    border-radius: 0 8px 8px 0;
  }

  .mute-toggle:hover,
  .mute-chevron:hover {
    color: var(--t1);
  }

  .mute-toggle:disabled {
    cursor: default;
    opacity: 0.6;
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
