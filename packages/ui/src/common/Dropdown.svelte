<script lang="ts" module>
  export interface DropdownOption<T extends string = string> {
    value: T;
    label: string;
    /** Muted text after the label (an email, "Bot"). */
    detail?: string | null;
    disabled?: boolean;
  }

</script>

<script lang="ts" generics="V extends string">
  /**
   * OWNER-R5/R6: the app's one styled dropdown. A button that shows the
   * current value with one down chevron, opening a listbox of options with the
   * current one checked. Closes on choice, Escape and outside click; arrows,
   * Home/End, Enter/Space and type-ahead work. Paints the shared overlay
   * tokens, sits above panes and under toasts. Replaces native selects.
   */
  import { tick } from "svelte";
  import { markDropdownOpen } from "./dropdown-open.js";

  interface Props {
    value: V;
    options: readonly DropdownOption<V>[];
    /** Accessible name for the control. */
    label: string;
    /** Text before the value in the button, e.g. "Person". */
    prefix?: string;
    disabled?: boolean;
    testid?: string;
    /** Stretch to the container width (form fields). */
    block?: boolean;
    /** Pill shape for header filters; `active` paints the selected style. */
    pill?: boolean;
    active?: boolean;
    onchange?: (value: V) => void;
  }

  let {
    value = $bindable(),
    options,
    label,
    prefix = "",
    disabled = false,
    testid,
    block = false,
    pill = false,
    active: selectedStyle = false,
    onchange,
  }: Props = $props();

  const uid = `dd-${Math.random().toString(36).slice(2, 9)}`;
  let open = $state(false);
  let active = $state(0);
  let root = $state<HTMLDivElement | null>(null);
  let button = $state<HTMLButtonElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);
  let typed = "";
  let typedAt = 0;

  const current = $derived(options.find((o) => o.value === value) ?? null);

  async function show(): Promise<void> {
    if (disabled) return;
    open = true;
    const i = options.findIndex((o) => o.value === value);
    active = i >= 0 ? i : 0;
    await tick();
    list?.focus();
    scrollActive();
  }

  function hide(focusButton = true): void {
    open = false;
    if (focusButton) button?.focus();
  }

  function choose(i: number): void {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    if (opt.value !== value) {
      value = opt.value;
      onchange?.(opt.value);
    }
    hide();
  }

  function scrollActive(): void {
    list?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }

  function move(next: number): void {
    if (options.length === 0) return;
    active = Math.max(0, Math.min(options.length - 1, next));
    scrollActive();
  }

  function onButtonKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void show();
    }
  }

  function onListKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") { e.preventDefault(); move(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(active - 1); }
    else if (e.key === "Home") { e.preventDefault(); move(0); }
    else if (e.key === "End") { e.preventDefault(); move(options.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(active); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); }
    else if (e.key === "Tab") { hide(false); }
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now();
      typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = now;
      const start = typed.length === 1 ? active + 1 : active;
      for (let n = 0; n < options.length; n += 1) {
        const i = (start + n) % options.length;
        if (options[i]!.label.toLowerCase().startsWith(typed)) { move(i); break; }
      }
    }
  }

  $effect(() => {
    if (!open) return;
    markDropdownOpen(true);
    const onDown = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) hide(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      markDropdownOpen(false);
      document.removeEventListener("pointerdown", onDown, true);
    };
  });
</script>

<div class="dd" class:block bind:this={root}>
  <button
    bind:this={button}
    type="button"
    class="dd-button"
    class:pill
    class:sel={selectedStyle}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={`${uid}-list`}
    aria-label={current ? `${label}: ${current.label}` : label}
    data-testid={testid}
    data-value={value}
    {disabled}
    onclick={() => (open ? hide() : void show())}
    onkeydown={onButtonKey}
  >
    <span class="dd-value">
      {#if prefix}<span class="dd-prefix">{prefix} · </span>{/if}{current?.label ?? ""}
    </span>
    <svg class="dd-chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
  {#if open}
    <div
      bind:this={list}
      id={`${uid}-list`}
      class="dd-menu"
      role="listbox"
      tabindex="-1"
      aria-label={label}
      aria-activedescendant={`${uid}-opt-${active}`}
      data-testid={testid ? `${testid}-menu` : undefined}
      onkeydown={onListKey}
    >
      {#each options as opt, i (opt.value)}
        <div
          id={`${uid}-opt-${i}`}
          class="dd-option"
          class:active={i === active}
          role="option"
          aria-selected={opt.value === value}
          aria-disabled={opt.disabled ? "true" : undefined}
          data-index={i}
          data-value={opt.value}
          tabindex="-1"
          onpointerenter={() => (active = i)}
          onclick={() => choose(i)}
          onkeydown={onListKey}
        >
          <span class="dd-check" aria-hidden="true">{opt.value === value ? "✓" : ""}</span>
          <span class="dd-label">{opt.label}</span>
          {#if opt.detail}<span class="dd-detail">{opt.detail}</span>{/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .dd { position: relative; display: inline-flex; min-width: 0; }
  .dd.block { display: flex; width: 100%; }
  .dd-button {
    display: inline-flex;
    align-items: center;
    gap: var(--hq-btn-gap);
    min-width: 0;
    width: 100%;
    min-height: var(--hq-btn-h);
    padding: 0 8px 0 10px;
    border: 1px solid var(--v4-hairline, var(--overlay-border));
    border-radius: 6px;
    background: var(--v4-control-bg, transparent);
    color: var(--v4-text-1, inherit);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .dd-button.pill { border-radius: 999px; padding: 0 8px 0 12px; width: auto; }
  .dd-button.sel { background: var(--sel, var(--overlay-hover)); border-color: transparent; }
  .dd-button:disabled { opacity: 0.55; cursor: default; }
  .dd-button:focus-visible { outline: 2px solid var(--v4-focus, currentColor); outline-offset: 1px; }
  .dd-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dd-prefix { color: var(--v4-text-3); }
  .dd-chevron { width: 14px; height: 14px; flex: none; color: var(--v4-text-3); }
  .dd-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 1000;
    min-width: max(100%, 180px);
    max-width: 360px;
    max-height: 320px;
    overflow: auto;
    padding: 4px;
    background: var(--overlay-bg);
    border: 1px solid var(--overlay-border);
    border-radius: var(--v4-radius-popover, 8px);
    box-shadow: var(--overlay-shadow);
    color: var(--v4-text-1);
    outline: none;
  }
  .dd-option {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-height: 28px;
    padding: 5px 8px 5px 4px;
    border-radius: 5px;
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
  }
  .dd-option.active { background: var(--overlay-hover); }
  .dd-option[aria-disabled="true"] { opacity: 0.5; cursor: default; }
  .dd-check { width: 14px; flex: none; text-align: center; color: var(--v4-text-2); }
  .dd-label { overflow: hidden; text-overflow: ellipsis; }
  .dd-detail { color: var(--v4-text-3); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
</style>
