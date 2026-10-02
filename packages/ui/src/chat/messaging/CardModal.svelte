<script lang="ts">
  /**
   * The modal a card can open.
   *
   * A card in a bot's message is small and fixed in height. When what it
   * offers takes more than one press (several steps, a wait on the server, a
   * field to fill in), its main button opens this dialog instead. The dialog
   * is the card at full size: the same wallpaper, the same icon and title on
   * dark glass, and room for a body and a row of actions.
   *
   * Like the cards and the New Bot takeover it is dark on art in both app
   * themes, so no color here comes from a theme variable (card-modal.css).
   *
   * It always draws at the app shell, above everything in the window, and is
   * never clipped by the message that holds the card: `portal` moves it to
   * `.desktop-shell` wherever it is mounted. While it is open the rest of the
   * app is inert, Tab stays inside it, the app's keyboard shortcuts are held
   * (so typing or pasting in a field here can never set one off, and nothing
   * like the command palette opens over it), and focus goes back to the
   * button that opened it when it closes.
   *
   * Content comes in as two snippets, `body` and `footer`. The pieces a flow
   * needs are next to this file: `card-modal-btn` (with `is-primary` or
   * `is-quiet`), CardModalStep, CardModalStatus and CardModalField.
   */
  import type { Snippet } from "svelte";
  import { suspendShortcuts } from "../../common/keyboard-shortcuts.js";
  import { portal } from "../portal.js";
  import ConnectionCardIcon from "./ConnectionCardIcon.svelte";
  import type { ConnectTarget } from "./richMessageContent.js";
  import {
    CARD_MODAL_BACKDROP_GUARD_MS,
    cardModalStepIndex,
    cardModalStepText,
    focusIntoDialog,
    inertOutside,
    restoreFocus,
    trapTab,
    type CardModalSteps,
  } from "./card-modal.js";
  import "./card-modal.css";

  interface Props {
    /** Whether the dialog is showing. */
    open: boolean;
    /** The card's title, e.g. "Slack". Names the dialog. */
    title: string;
    /** The card's icon. */
    icon: ConnectTarget;
    /** The card's wallpaper (an image url the app bundled). */
    art: string;
    /** Which part of the wallpaper the hero shows (a CSS background-position). */
    artPosition?: string;
    /** The person asked to close: the close button, Escape, a press outside. */
    onclose: () => void;
    /**
     * Something is under way that must not be interrupted. Escape and a press
     * outside do nothing and the close button is disabled.
     */
    busy?: boolean;
    /** A small step indicator under the title. */
    steps?: CardModalSteps | null;
    body?: Snippet;
    /** The row of actions under the body. */
    footer?: Snippet;
    /**
     * Where focus goes on close. Default: whatever had focus when the dialog
     * opened, which is the button that opened it.
     */
    returnFocus?: HTMLElement | null;
  }

  let {
    open,
    title,
    icon,
    art,
    artPosition = "center",
    onclose,
    busy = false,
    steps = null,
    body,
    footer,
    returnFocus = null,
  }: Props = $props();

  const uid = $props.id();
  const titleId = `card-modal-title-${uid}`;

  let panelEl = $state<HTMLDivElement | null>(null);
  let bodyEl = $state<HTMLDivElement | null>(null);
  let openedAt = 0;

  const stepAt = $derived(steps && steps.labels.length > 0 ? cardModalStepIndex(steps) : -1);
  const stepText = $derived(steps ? cardModalStepText(steps) : "");

  // Where focus goes on close, kept outside the props: the layer is taken
  // down while the host is letting go of them, and they cannot be read then.
  let returnFocusNow: HTMLElement | null = null;
  $effect.pre(() => {
    returnFocusNow = returnFocus;
  });

  function requestClose(): void {
    if (busy) return;
    onclose();
  }

  /**
   * The layer's whole life: move it to the shell, make the rest of the app
   * inert, take focus, and undo all of it when the dialog goes.
   */
  function dialogLayer(node: HTMLElement) {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openedAt = Date.now();
    const ported = portal(node);
    const releaseInert = inertOutside(node);
    // The app's shortcuts are part of "the rest of the app": none of them
    // fires while the dialog is open, whatever has focus inside it.
    const releaseShortcuts = suspendShortcuts();
    focusIntoDialog(node.querySelector<HTMLElement>('[role="dialog"]'));
    return {
      destroy() {
        releaseShortcuts();
        releaseInert();
        ported.destroy?.();
        restoreFocus(returnFocusNow ?? opener);
      },
    };
  }

  // Escape and Tab are caught at the window, before anything under the
  // dialog hears them: focus can sit on the page itself after a press on the
  // backdrop, and the conversation behind has Escape handlers of its own.
  $effect(() => {
    if (!open) return;
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      trapTab(event, panelEl);
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });

  function onBackdropClick(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    // The second click of a double click on the card's button lands here.
    if (Date.now() - openedAt < CARD_MODAL_BACKDROP_GUARD_MS) return;
    requestClose();
  }

  // The body scrolls inside the panel. While it does, it takes focus so the
  // arrow keys scroll it, and a soft fade at either edge says more is there.
  let scrolls = $state(false);
  let moreAbove = $state(false);
  let moreBelow = $state(false);
  function measureBody(): void {
    const el = bodyEl;
    scrolls = el ? el.scrollHeight - el.clientHeight > 1 : false;
    moreAbove = el ? el.scrollTop > 1 : false;
    moreBelow = el ? el.scrollHeight - el.clientHeight - el.scrollTop > 1 : false;
  }
  $effect(() => {
    const el = bodyEl;
    if (!el) {
      scrolls = false;
      moreAbove = false;
      moreBelow = false;
      return;
    }
    measureBody();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureBody());
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="card-modal-layer"
    data-testid="card-modal-layer"
    data-busy={busy ? "true" : "false"}
    use:dialogLayer
    onclick={onBackdropClick}
  >
    <div
      bind:this={panelEl}
      class="card-modal"
      data-testid="card-modal"
      data-icon={icon}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={busy ? "true" : undefined}
      tabindex="-1"
    >
      <!-- The art is the app's own bundled image, the one on the card. -->
      <span
        class="card-modal-art"
        aria-hidden="true"
        style:background-image={`url("${art}")`}
        style:background-position={artPosition}
      ></span>
      <header class="card-modal-hero">
        <div class="card-modal-plate">
          <span class="card-modal-icon" aria-hidden="true"><ConnectionCardIcon name={icon} size={18} /></span>
          <div class="card-modal-heading">
            <h2 class="card-modal-title" id={titleId} data-testid="card-modal-title">{title}</h2>
            {#if steps && stepAt >= 0}
              <div class="card-modal-progress" data-testid="card-modal-steps">
                <span class="card-modal-progress-marks" aria-hidden="true">
                  {#each steps.labels as _label, index (index)}
                    <span class:is-done={index < stepAt} class:is-current={index === stepAt}></span>
                  {/each}
                </span>
                <span class="card-modal-progress-label" aria-hidden="true">{steps.labels[stepAt]}</span>
                <span class="card-modal-sr" data-testid="card-modal-steps-text" aria-live="polite">{stepText}</span>
              </div>
            {/if}
          </div>
        </div>
        <button
          type="button"
          class="card-modal-close"
          data-testid="card-modal-close"
          aria-label="Close"
          disabled={busy}
          onclick={requestClose}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div
        class="card-modal-glass"
        data-more-above={moreAbove ? "true" : "false"}
        data-more-below={moreBelow ? "true" : "false"}
      >
        <!-- The body takes focus only while it scrolls, so the arrow keys can scroll it. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          bind:this={bodyEl}
          class="card-modal-body"
          data-testid="card-modal-body"
          role={scrolls ? "group" : undefined}
          aria-labelledby={scrolls ? titleId : undefined}
          tabindex={scrolls ? 0 : undefined}
          onscroll={measureBody}
        >
          {@render body?.()}
        </div>
      </div>
      {#if footer}
        <footer class="card-modal-foot" data-testid="card-modal-footer">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}
