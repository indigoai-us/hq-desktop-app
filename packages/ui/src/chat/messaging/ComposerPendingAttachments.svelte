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
  import FileText from "phosphor-svelte/lib/FileText";
  import X from "phosphor-svelte/lib/X";
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
        class="composer-att"
        data-testid="composer-image-preview"
        title={file.name}
      >
        <img
          class="composer-att-img"
          src={pendingPreviewUrl(file)}
          alt={file.name}
        />
        <span class="composer-att-name">{file.name}</span>
        <button
          type="button"
          class="composer-att-remove"
          aria-label={`Remove ${file.name}`}
          title={`Remove ${file.name}`}
          onclick={() => onremove(i)}
          onkeydown={(e) => onRemoveKey(e, i)}
        >
          <X size={10} weight="bold" aria-hidden="true" />
        </button>
      </span>
    {:else}
      <span
        class="composer-att is-file"
        data-testid="composer-file-chip"
        title={file.name}
      >
        <span class="composer-att-icon" aria-hidden="true">
          <FileText size={17} />
        </span>
        <span class="composer-att-name">{file.name}</span>
        <button
          type="button"
          class="composer-att-remove"
          aria-label={`Remove ${file.name}`}
          title={`Remove ${file.name}`}
          onclick={() => onremove(i)}
          onkeydown={(e) => onRemoveKey(e, i)}
        >
          <X size={10} weight="bold" aria-hidden="true" />
        </button>
      </span>
    {/if}
  {/each}
  {#if error}
    <span class="composer-attach-error">{error}</span>
  {/if}
</div>

<style>
  /* Concept `.cmp-tray` / `.cmp-att`: small 96x64 tiles that name themselves
     in a pill, rather than a large square preview beside a pill-shaped chip —
     two different shapes for the same thing. */
  .composer-pending {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 0 2px 8px;
  }

  .composer-att {
    position: relative;
    display: flex;
    align-items: flex-end;
    flex: 0 0 auto;
    box-sizing: border-box;
    width: 96px;
    height: 64px;
    padding: 5px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--raised);
  }

  /* A document has no thumbnail to show, so the tile states what it is
     rather than faking a preview. */
  .composer-att.is-file {
    flex-direction: column;
    align-items: flex-start;
    justify-content: space-between;
    padding: 8px 7px 5px;
  }

  .composer-att-icon {
    display: flex;
    color: var(--t2);
    line-height: 0;
  }

  .composer-att-img {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .composer-att-name {
    position: relative;
    max-width: 100%;
    padding: 2px 5px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.45);
    color: rgba(255, 255, 255, 0.85);
    font: 400 8px/1.4 var(--font-mono, ui-monospace, Menlo, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .composer-att.is-file .composer-att-name {
    background: var(--btn-bg);
    color: var(--t2);
  }

  .composer-att-remove {
    position: absolute;
    top: 4px;
    right: 4px;
    appearance: none;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  .composer-att-remove:hover,
  .composer-att-remove:focus-visible {
    background: rgba(0, 0, 0, 0.75);
  }

  .composer-att-remove:focus-visible {
    outline: 2px solid var(--ice-ink, #c9d6e4);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .composer-att-remove {
      transition: none;
    }
  }

  .composer-attach-error {
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font-size: 12px;
  }
</style>
