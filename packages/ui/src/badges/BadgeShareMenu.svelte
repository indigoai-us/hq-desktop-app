<script lang="ts">
  /**
   * "Download" on the card stage: the card as an image or a short
   * video for social, in square (1:1), story (9:16) or landscape (16:9).
   * The files are drawn by badge-share.ts. Dark like the stage it sits on.
   */
  import RailIcon from "../common/button/RailIcon.svelte";
  import type { ResolvedBadge } from "./badge-catalog.js";
  import { SHARE_SIZE, ShareError, canRecordVideo, downloadShare, type ShareKind, type ShareShape } from "./badge-share.js";

  interface Props {
    badge: ResolvedBadge;
    /** Whose card it is; none means your own, and the post is in your voice. */
    owner?: string | null;
    /** The menu is open. The stage closes it first on Escape. */
    open?: boolean;
    disabled?: boolean;
  }

  let { badge, owner = null, open = $bindable(false), disabled = false }: Props = $props();

  const SHAPES: readonly ShareShape[] = ["square", "story", "landscape"];
  let kind = $state<ShareKind>("image");
  let shape = $state<ShareShape>("square");
  let busy = $state(false);
  let error = $state("");
  const videoOk = typeof window !== "undefined" && canRecordVideo();

  let rootEl = $state<HTMLDivElement | null>(null);
  let toggleEl = $state<HTMLButtonElement | null>(null);

  // Close on a click outside.
  $effect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (rootEl && !rootEl.contains(event.target as Node)) open = false;
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  });

  function toggle(): void {
    open = !open;
    error = "";
  }

  async function download(): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await downloadShare(badge, kind, shape, owner);
      open = false;
      toggleEl?.focus();
    } catch (err) {
      console.error("[badge-share] download failed", err);
      error = err instanceof ShareError ? err.copy : "The file could not be made. Try again, or try the image.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="bs" bind:this={rootEl}>
  <button
    type="button"
    class="bs-toggle"
    data-testid="badge-card-share"
    aria-haspopup="dialog"
    aria-expanded={open}
    {disabled}
    bind:this={toggleEl}
    onclick={toggle}
  ><RailIcon name="download" size={14} />Download</button>
  {#if open}
    <div class="bs-menu" role="dialog" aria-label="Download this card" data-testid="badge-share-menu">
      <div class="bs-k" id="bs-kind">Format</div>
      <div class="bs-seg" role="radiogroup" aria-labelledby="bs-kind">
        <button type="button" role="radio" aria-checked={kind === "image"} data-testid="badge-share-kind-image" onclick={() => (kind = "image")}>
          <RailIcon name="image" size={14} />Image
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={kind === "video"}
          data-testid="badge-share-kind-video"
          disabled={!videoOk}
          onclick={() => (kind = "video")}
        >
          <RailIcon name="video-camera" size={14} />Video
        </button>
      </div>
      {#if !videoOk}<p class="bs-note" data-testid="badge-share-no-video">Video isn't available in this window.</p>{/if}
      <div class="bs-k" id="bs-shape">Size</div>
      <div class="bs-shapes" role="radiogroup" aria-labelledby="bs-shape">
        {#each SHAPES as s (s)}
          <button type="button" role="radio" aria-checked={shape === s} data-testid="badge-share-shape-{s}" onclick={() => (shape = s)}>
            <span class="bs-frame bs-{s}" aria-hidden="true"></span>
            <span class="bs-name">{SHARE_SIZE[s].label}</span>
            <span class="bs-ratio">{SHARE_SIZE[s].ratio}</span>
          </button>
        {/each}
      </div>
      {#if busy && kind === "video"}
        <!-- The video records in real time; a hidden window slows its frames. -->
        <p class="bs-note" data-testid="badge-share-recording">Takes about 7 seconds. Keep this window open.</p>
      {/if}
      {#if error}<p class="bs-error" role="alert" data-testid="badge-share-error">{error}</p>{/if}
      <button type="button" class="bs-go" data-testid="badge-share-download" disabled={busy} onclick={download}>
        <RailIcon name="download" size={14} />
        {busy ? (kind === "video" ? "Recording video…" : "Making image…") : `Download ${kind}`}
      </button>
    </div>
  {/if}
</div>

<style>
  /* Dark in both app themes, like the card stage: no theme variables. */
  .bs { position: relative; }
  .bs-toggle {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px;
    border: 0; border-radius: 6px; background: none;
    color: rgba(250, 250, 250, 0.72); font: inherit; cursor: pointer;
  }
  .bs-toggle:hover:not(:disabled), .bs-toggle[aria-expanded="true"] { color: rgba(250, 250, 250, 0.5); }
  .bs-toggle:disabled { opacity: 0.4; cursor: default; }
  .bs-menu {
    position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); z-index: 2;
    box-sizing: border-box; width: 300px; padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px;
    background: #1c1c1f; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    color: #fafafa; text-align: left;
  }
  .bs-k { margin: 0 0 6px; color: rgba(250, 250, 250, 0.5); font-size: 12px; }
  .bs-k:not(:first-child) { margin-top: 12px; }
  .bs-seg { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 2px; border-radius: 8px; background: rgba(255, 255, 255, 0.06); }
  .bs-seg button {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 5px 0;
    border: 0; border-radius: 6px; background: none; color: rgba(250, 250, 250, 0.72); font: inherit; cursor: pointer;
  }
  .bs-seg button[aria-checked="true"] { background: rgba(255, 255, 255, 0.12); color: #fafafa; }
  .bs-seg button:disabled { opacity: 0.4; cursor: default; }
  .bs-shapes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .bs-shapes button {
    display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 4px 8px;
    border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; background: none;
    color: rgba(250, 250, 250, 0.72); font: inherit; cursor: pointer;
  }
  .bs-shapes button:hover { background: rgba(255, 255, 255, 0.05); }
  .bs-shapes button[aria-checked="true"] { border-color: rgba(255, 255, 255, 0.5); color: #fafafa; }
  /* A small outline in each proportion. */
  .bs-frame { display: block; height: 28px; margin-bottom: 2px; border: 1.5px solid currentColor; border-radius: 3px; }
  .bs-square { width: 28px; }
  .bs-story { width: 16px; }
  .bs-landscape { width: 40px; height: 22px; margin: 3px 0 5px; }
  .bs-name { font-size: 12px; }
  .bs-ratio { font-size: 11px; color: rgba(250, 250, 250, 0.45); font-variant-numeric: tabular-nums; }
  .bs-note { margin: 6px 0 0; color: rgba(250, 250, 250, 0.45); font-size: 12px; }
  .bs-error { margin: 10px 0 0; color: #f0616d; font-size: 12px; }
  .bs-go {
    display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; height: var(--hq-btn-h, 31px); margin-top: 12px;
    border: 0; border-radius: 8px; background: #fafafa; color: #09090b; font: inherit; font-weight: 500; cursor: pointer;
  }
  .bs-go:hover:not(:disabled) { opacity: 0.88; }
  .bs-go:disabled { opacity: 0.6; cursor: progress; }
  .bs-toggle:focus-visible, .bs-seg button:focus-visible, .bs-shapes button:focus-visible, .bs-go:focus-visible {
    outline: 2px solid rgba(250, 250, 250, 0.7); outline-offset: 2px;
  }
</style>
