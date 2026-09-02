<script lang="ts">
  /**
   * Shared overlay / destination header: Back · title · subtitle, on the
   * same height and centre line as `V4TitleBar`, with the same leading
   * inset that clears macOS traffic lights.
   *
   * `variant="window"` is the full-window chrome (Library, Settings): it
   * reads `--titlebar-leading-inset` / `--titlebar-height` and is a Tauri
   * drag region. `variant="embedded"` is the in-pane form (Meetings,
   * Notifications) — same Back control, no traffic-light gutter.
   */
  import { startWindowDrag } from "../home/window-drag.js";
  import "../home/tokens.css";

  interface Props {
    title: string;
    subtitle?: string;
    titleId?: string;
    titleTestId?: string;
    subtitleTestId?: string;
    backTestId?: string;
    backAriaLabel?: string;
    onback?: () => void;
    /** `window` = overlay chrome (traffic-light inset). `embedded` = in-pane. */
    variant?: "window" | "embedded";
    extraClass?: string;
    testId?: string;
    trailing?: import("svelte").Snippet;
    children?: import("svelte").Snippet;
  }

  let {
    title,
    subtitle,
    titleId,
    titleTestId,
    subtitleTestId,
    backTestId = "page-header-back",
    backAriaLabel = "Back",
    onback,
    variant = "window",
    extraClass = "",
    testId = "page-header",
    trailing,
    children,
  }: Props = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<header
  class="page-header {variant} {extraClass}"
  data-testid={testId}
  data-tauri-drag-region
  onpointerdown={startWindowDrag}
>
  {#if onback}
    <button
      type="button"
      class="page-header-back"
      data-testid={backTestId}
      aria-label={backAriaLabel}
      data-tauri-drag-region="false"
      onclick={() => onback?.()}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M10 3.5 5.5 8 10 12.5"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      Back
    </button>
  {/if}
  <h1 id={titleId} data-testid={titleTestId}>{title}</h1>
  {#if subtitle}
    <span class="page-header-sub" data-testid={subtitleTestId}>{subtitle}</span>
  {/if}
  {@render children?.()}
  {#if trailing}
    <div class="page-header-trailing" data-tauri-drag-region="false">
      {@render trailing()}
    </div>
  {/if}
</header>

<style>
  .page-header {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 var(--titlebar-height, 48px);
    height: var(--titlebar-height, 48px);
    min-height: var(--titlebar-height, 48px);
    overflow: visible;
    border-bottom: 1px solid var(--line);
    background: transparent;
    font: 400 13px/1.45 var(--font-ui);
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }

  .page-header.window {
    padding: 0 16px 0 var(--titlebar-leading-inset, 78px);
  }

  .page-header.embedded {
    height: auto;
    min-height: var(--titlebar-height, 48px);
    flex: 0 0 auto;
    flex-wrap: wrap;
    padding: 0 20px;
  }

  .page-header-back {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    margin: 0;
    padding: 5px 10px;
    border: 1px solid var(--line2, var(--v4-control-border));
    border-radius: 8px;
    background: transparent;
    color: var(--t2, var(--v4-text-2));
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
    white-space: nowrap;
    cursor: pointer;
  }

  .page-header-back:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .page-header-back:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: 2px;
  }

  .page-header h1 {
    margin: 0;
    color: var(--t1);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
  }

  .page-header-sub {
    min-width: 0;
    overflow: hidden;
    color: var(--t3);
    font-size: 12px;
    font-weight: 400;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .page-header-trailing {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    margin-left: auto;
  }
</style>
