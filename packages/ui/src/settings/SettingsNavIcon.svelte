<script lang="ts">
  /** Stroke icons matching the preview-v2 Settings nav. */
  interface Props {
    name:
      | "profile"
      | "companies"
      | "general"
      | "appearance"
      | "notifications"
      | "sync"
      | "meetings"
      | "updates";
  }
  let { name }: Props = $props();
</script>

<svg
  class="nav-ico"
  viewBox="0 0 16 16"
  width="14"
  height="14"
  fill="none"
  aria-hidden="true"
>
  {#if name === "profile"}
    <circle cx="8" cy="5.5" r="2.2" stroke="currentColor" stroke-width="1.3" />
    <path
      d="M3.5 13c.5-2.2 2.2-3.4 4.5-3.4S12 10.8 12.5 13"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  {:else if name === "companies"}
    <path
      d="M2.5 13.5V6.5L8 3l5.5 3.5v7H2.5Z"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linejoin="round"
    />
    <path d="M6.5 13.5v-4h3v4" stroke="currentColor" stroke-width="1.3" />
  {:else if name === "general"}
    <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.3" />
    <path
      d="M8 2.5v1.4M8 12.1v1.4M2.5 8h1.4M12.1 8h1.4M4.1 4.1l1 1M10.9 10.9l1 1M11.9 4.1l-1 1M5.1 10.9l-1 1"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  {:else if name === "appearance"}
    <circle cx="8" cy="8" r="3.2" stroke="currentColor" stroke-width="1.3" />
    <path d="M8 4.8v6.4" stroke="currentColor" stroke-width="1.3" />
    <path d="M8 4.8a3.2 3.2 0 0 0 0 6.4" fill="currentColor" opacity="0.35" />
  {:else if name === "notifications"}
    <path
      d="M4 7.2a4 4 0 0 1 8 0c0 3 1.2 3.8 1.2 3.8H2.8S4 10.2 4 7.2Z"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linejoin="round"
    />
    <path
      d="M6.6 12.4a1.4 1.4 0 0 0 2.8 0"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  {:else if name === "sync"}
    <path
      d="M4 6.2 6.2 4 8.4 6.2M11.8 9.8 9.6 12 7.4 9.8"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M6.2 4v7.2M9.6 12V4.8"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  {:else if name === "meetings"}
    <rect
      x="2.6"
      y="3.8"
      width="10.8"
      height="9.4"
      rx="1.4"
      stroke="currentColor"
      stroke-width="1.3"
    />
    <path
      d="M2.6 6.6h10.8M5.2 2.8v2M10.8 2.8v2"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  {:else}
    <path
      d="M8 3.2v7.2M5.4 8.2 8 10.8l2.6-2.6"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M3.4 12.6h9.2"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  {/if}
</svg>

<style>
  .nav-ico {
    display: block;
    flex: 0 0 auto;
  }
</style>
