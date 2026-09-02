<script lang="ts">
  /**
   * Pending composer attachments: square image thumbs + compact file chips
   * in one wrapping row. Owns the lazy object-URL lifecycle for image
   * previews — create on first paint, revoke when the file leaves or this
   * row unmounts.
   *
   * Parents should keep pending files as `$state.raw` so Svelte does not
   * proxy the Blob; `URL.createObjectURL` needs a real File.
   */
  import { onDestroy } from "svelte";
  import { isImageFile } from "./chat-attachments";

  interface Props {
    files: File[];
    error?: string | null;
    onremove: (index: number) => void;
    testid?: string;
  }

  let {
    files,
    error = null,
    onremove,
    testid = "composer-pending",
  }: Props = $props();

  const pendingPreviewUrls = new Map<File, string>();
  function pendingPreviewUrl(file: File): string {
    let url = pendingPreviewUrls.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      pendingPreviewUrls.set(file, url);
    }
    return url;
  }

  $effect(() => {
    const current = new Set(files);
    for (const [file, url] of pendingPreviewUrls) {
      if (!current.has(file)) {
        URL.revokeObjectURL(url);
        pendingPreviewUrls.delete(file);
      }
    }
  });

  onDestroy(() => {
    for (const url of pendingPreviewUrls.values()) URL.revokeObjectURL(url);
    pendingPreviewUrls.clear();
  });

  function onRemoveKey(event: KeyboardEvent, index: number): void {
    if (event.key !== "Backspace" && event.key !== "Delete") return;
    event.preventDefault();
    onremove(index);
  }
</script>

<div class="composer-pending" data-testid={testid}>
  {#each files as file, i (file.name + file.size + i)}
    {#if isImageFile(file)}
      <span
        class="composer-thumb"
        data-testid="composer-image-preview"
        title={file.name}
      >
        <img
          class="composer-thumb-img"
          src={pendingPreviewUrl(file)}
          alt={file.name}
        />
        <button
          type="button"
          class="composer-thumb-remove"
          aria-label={`Remove ${file.name}`}
          title={`Remove ${file.name}`}
          onclick={() => onremove(i)}
          onkeydown={(e) => onRemoveKey(e, i)}
        >
          ×
        </button>
      </span>
    {:else}
      <span
        class="composer-chip"
        data-testid="composer-file-chip"
        title={file.name}
      >
        <span class="composer-chip-name">{file.name}</span>
        <button
          type="button"
          class="composer-chip-remove"
          aria-label={`Remove ${file.name}`}
          title={`Remove ${file.name}`}
          onclick={() => onremove(i)}
          onkeydown={(e) => onRemoveKey(e, i)}
        >
          ×
        </button>
      </span>
    {/if}
  {/each}
  {#if error}
    <span class="composer-attach-error">{error}</span>
  {/if}
</div>

<style>
  .composer-pending {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 0 2px 8px;
  }

  .composer-thumb {
    position: relative;
    flex: 0 0 auto;
    width: 80px;
    height: 80px;
    overflow: hidden;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    background: var(--sel, rgba(255, 255, 255, 0.06));
  }

  .composer-thumb-img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .composer-thumb-remove {
    position: absolute;
    top: 4px;
    right: 4px;
    appearance: none;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.62);
    color: #fff;
    font-size: 14px;
    line-height: 20px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms ease, transform 120ms ease;
  }

  .composer-thumb-remove:hover,
  .composer-thumb-remove:focus-visible {
    background: rgba(0, 0, 0, 0.82);
  }

  .composer-thumb-remove:focus-visible {
    outline: 2px solid var(--ice-ink, #c9d6e4);
    outline-offset: 2px;
  }

  .composer-thumb-remove:active {
    transform: scale(0.97);
  }

  .composer-thumb:hover .composer-thumb-remove,
  .composer-thumb:focus-within .composer-thumb-remove,
  .composer-thumb-remove:focus-visible {
    opacity: 1;
  }

  @media (hover: none) {
    .composer-thumb-remove {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .composer-thumb-remove {
      transition: none;
    }
  }

  .composer-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 220px;
    padding: 4px 8px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 999px;
    background: var(--sel, rgba(255, 255, 255, 0.06));
    font-size: 12px;
  }

  .composer-chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .composer-chip-remove {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
  }

  .composer-chip-remove:hover,
  .composer-chip-remove:focus-visible {
    color: var(--t1, #fff);
  }

  .composer-attach-error {
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font-size: 12px;
  }
</style>
