<script lang="ts">
  /**
   * A person's or bot's picture in Atlas HTML rows (dock, inspector, hover
   * card). The caller draws the chip's border and live ring; this fills it.
   * No picture, or one that fails to load, shows the initials or bot glyph.
   */
  import { atlasInitials } from "./atlas-presence.js";

  interface Props {
    name: string;
    bot: boolean;
    avatarUrl?: string;
    /** Rendered edge in px, for the image's intrinsic size. */
    size: number;
    /** Text shown without a picture; defaults to the bot glyph or initials. */
    fallback?: string;
  }

  let { name, bot, avatarUrl, size, fallback }: Props = $props();
  // Per image: a failed URL never retries, a new URL gets its own chance.
  let failed = $state<string | null>(null);
  const src = $derived(avatarUrl && avatarUrl !== failed ? avatarUrl : null);
</script>

{#if src}
  <img
    class="atlas-face"
    data-testid="atlas-face-img"
    {src}
    alt=""
    width={size}
    height={size}
    decoding="async"
    onerror={() => (failed = src)}
  />
{:else}{fallback ?? (bot ? "⌁" : atlasInitials(name))}{/if}

<style>
  .atlas-face {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }
</style>
