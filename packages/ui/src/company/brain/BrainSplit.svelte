<script lang="ts">
  /**
   * Master-detail split shared by Knowledge, Policies, Skills and Workers.
   * The list column starts at the sidebar's width and is resizable; the
   * detail takes the rest. Below BRAIN_NARROW_AT it shows the list, then the
   * detail with a back control.
   */
  import { onDestroy, type Snippet } from "svelte";
  import RailIcon from "../../common/button/RailIcon.svelte";
  import type { BrainPageId } from "./brain-model.js";
  import {
    BRAIN_LIST_MAX,
    BRAIN_LIST_MIN,
    BRAIN_NARROW_AT,
    clampListWidth,
    readListWidth,
    saveListWidth,
    sidebarWidth,
  } from "./brain-layout.js";

  interface Props {
    page: BrainPageId;
    /** A row is open; in the narrow layout the detail replaces the list. */
    hasSelection: boolean;
    onback: () => void;
    list: Snippet;
    detail: Snippet;
  }

  let { page, hasSelection, onback, list, detail }: Props = $props();

  let width = $state(readListWidth("knowledge"));
  let containerWidth = $state(0);
  let dragging = $state(false);
  let stop = () => {};

  $effect(() => {
    width = readListWidth(page);
  });

  const narrow = $derived(containerWidth > 0 && containerWidth < BRAIN_NARROW_AT);

  function set(next: number, persist: boolean): void {
    width = clampListWidth(next);
    if (persist) saveListWidth(page, width);
  }

  function begin(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    stop();
    const start = event.clientX;
    const initial = width;
    dragging = true;
    const move = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId) set(initial + (next.clientX - start), false);
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      stop();
      saveListWidth(page, width);
    };
    stop = () => {
      dragging = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function key(event: KeyboardEvent): void {
    const next =
      event.key === "ArrowLeft" ? width - 10
      : event.key === "ArrowRight" ? width + 10
      : event.key === "Home" ? BRAIN_LIST_MIN
      : event.key === "End" ? BRAIN_LIST_MAX
      : null;
    if (next === null) return;
    event.preventDefault();
    set(next, true);
  }

  onDestroy(() => stop());
</script>

<div
  class="split"
  class:narrow
  class:dragging
  bind:clientWidth={containerWidth}
  style:--brain-list-width={`${width}px`}
  data-testid="brain-split"
  data-layout={narrow ? (hasSelection ? "detail" : "list") : "split"}
>
  {#if !narrow || !hasSelection}
    <div class="pane list-pane">{@render list()}</div>
  {/if}
  {#if !narrow}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
    <div
      class="handle"
      role="separator"
      aria-label="Resize list"
      aria-orientation="vertical"
      aria-valuemin={BRAIN_LIST_MIN}
      aria-valuemax={BRAIN_LIST_MAX}
      aria-valuenow={width}
      tabindex="0"
      data-testid="brain-split-handle"
      onpointerdown={begin}
      onkeydown={key}
      ondblclick={() => set(sidebarWidth(), true)}
    ></div>
  {/if}
  {#if !narrow || hasSelection}
    <div class="pane detail-pane">
      {#if narrow}
        <button type="button" class="back" data-testid="brain-back" onclick={onback}>
          <RailIcon name="arrow-left" />Back
        </button>
      {/if}
      {@render detail()}
    </div>
  {/if}
</div>

<style>
  .split {
    display: grid;
    grid-template-columns: var(--brain-list-width) 1px minmax(0, 1fr);
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .split.narrow {
    grid-template-columns: minmax(0, 1fr);
  }
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .handle {
    position: relative;
    width: 1px;
    background: var(--line, var(--v4-rowline));
    cursor: col-resize;
    touch-action: none;
    z-index: 1;
  }
  /* A wider invisible grab area around the 1px line. */
  .handle::before {
    content: "";
    position: absolute;
    inset: 0 -3px;
  }
  .handle:hover,
  .handle:focus-visible,
  .dragging .handle {
    background: var(--line2, var(--v4-control-border));
    outline: none;
  }
  .dragging {
    cursor: col-resize;
    user-select: none;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    height: 26px;
    margin: 12px 16px 0;
    padding: 0 8px;
    border: 1px solid var(--line2, var(--v4-control-border));
    border-radius: 6px;
    background: transparent;
    color: var(--t1, var(--v4-text-1));
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .back:hover {
    background: var(--hover, var(--v4-hover));
  }
</style>
