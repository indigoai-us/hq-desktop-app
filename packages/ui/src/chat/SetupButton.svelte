<script lang="ts">
  /**
   * SetupButton — the one button used everywhere in the #welcome setup flow:
   * the hero's Run Setup / launch actions, the Connect step, the run card's
   * answers and choice chips, First Moves, and the "Continue in …" finish
   * row under the setup chat.
   *
   * One look, three weights: `primary` (solid fill), `secondary` (1px line,
   * transparent), `quiet` (no chrome, muted text — still a button, never an
   * underlined link). Colours come from `--setup-btn-*` custom properties
   * with shell-token fallbacks, so the same component reads on the app
   * surface (dark text on the theme) and on the wallpaper hero (white on
   * art) — a hero root just sets the six variables.
   *
   * Everything else (`data-testid`, `disabled`, `aria-*`, `onclick`, `type`,
   * `class`) spreads straight onto the <button>.
   */
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  export type SetupButtonVariant = "primary" | "secondary" | "quiet";

  interface Props extends HTMLButtonAttributes {
    variant?: SetupButtonVariant;
    /** Multi-select choices: renders `aria-pressed` and the selected look. */
    pressed?: boolean;
    children?: Snippet;
  }

  let {
    variant = "secondary",
    pressed,
    children,
    type = "button",
    class: className,
    "aria-pressed": ariaPressed,
    ...rest
  }: Props = $props();
</script>

<button
  {...rest}
  {type}
  class={["setup-btn", className]}
  data-variant={variant}
  aria-pressed={pressed ?? ariaPressed}
>
  {@render children?.()}
</button>

<style>
  .setup-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--setup-btn-fg, var(--text-1, #111));
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.2;
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
    transition:
      background 140ms ease,
      color 140ms ease,
      border-color 140ms ease,
      opacity 140ms ease;
  }

  .setup-btn[data-variant="primary"] {
    border-color: var(--setup-btn-primary-bg, var(--text-1, #111));
    background: var(--setup-btn-primary-bg, var(--text-1, #111));
    color: var(--setup-btn-primary-fg, var(--bg, #fff));
  }
  .setup-btn[data-variant="primary"]:hover:not(:disabled) {
    opacity: 0.9;
  }

  .setup-btn[data-variant="secondary"] {
    border-color: var(--setup-btn-line, var(--border, rgba(127, 127, 127, 0.35)));
  }
  .setup-btn[data-variant="secondary"]:hover:not(:disabled) {
    background: var(--setup-btn-hover, rgba(127, 127, 127, 0.12));
    border-color: var(--setup-btn-fg, var(--text-1, #111));
  }

  .setup-btn[data-variant="quiet"] {
    padding: 0 6px;
    color: var(--setup-btn-muted, var(--text-2, #777));
  }
  .setup-btn[data-variant="quiet"]:hover:not(:disabled) {
    background: var(--setup-btn-hover, rgba(127, 127, 127, 0.12));
    color: var(--setup-btn-fg, var(--text-1, #111));
  }

  /* Selected (multi-select choice): a full-strength line and a tinted fill. */
  .setup-btn[aria-pressed="true"] {
    border-color: var(--setup-btn-fg, var(--text-1, #111));
    background: var(--setup-btn-hover, rgba(127, 127, 127, 0.12));
    box-shadow: inset 0 0 0 1px var(--setup-btn-fg, var(--text-1, #111));
  }

  .setup-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .setup-btn:focus-visible {
    outline: 2px solid var(--accent, #6b5bff);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .setup-btn {
      transition: none;
    }
  }
</style>
