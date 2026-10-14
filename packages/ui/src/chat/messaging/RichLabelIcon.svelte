<script lang="ts">
  /**
   * The icon drawn before a rich block's title label. `name` comes from the
   * closed RICH_ICON_NAMES enum (the parser already rejected anything else);
   * every shape here is the app's own inline SVG, monochrome via
   * currentColor. No agent-supplied markup, path or URL ever reaches it.
   */
  import type { RichIcon } from "./richMessageContent.js";

  interface Props {
    name: RichIcon;
    size?: number;
  }

  let { name, size = 13 }: Props = $props();
</script>

<svg
  class="rich-label-icon"
  data-testid="rich-label-icon"
  data-icon={name}
  viewBox="0 0 16 16"
  width={size}
  height={size}
  aria-hidden="true"
  focusable="false"
  fill="none"
  stroke="currentColor"
  stroke-width="1.3"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  {#if name === "user"}
    <circle cx="8" cy="5.5" r="2.7" /><path d="M2.8 14c.6-2.8 2.7-4.3 5.2-4.3s4.6 1.5 5.2 4.3" />
  {:else if name === "folder"}
    <path d="M1.8 4.2h4.3l1.5 1.6h6.6v7.4H1.8z" />
  {:else if name === "file"}
    <path d="M3.5 1.8h6l3 3v9.4h-9z" /><path d="M9.5 1.8v3h3" />
  {:else if name === "check"}
    <path d="M3.2 8.4l3 3 6.6-6.8" />
  {:else if name === "clock"}
    <circle cx="8" cy="8" r="6.2" /><path d="M8 4.6V8l2.4 1.6" />
  {:else if name === "flag"}
    <path d="M3.5 14.5V2" /><path d="M3.5 2.6h8.5l-1.8 3 1.8 3H3.5" />
  {:else if name === "link"}
    <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9" /><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
  {:else if name === "mail"}
    <path d="M1.8 3.6h12.4v8.8H1.8z" /><path d="M2 4l6 4.6L14 4" />
  {:else if name === "alert"}
    <path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.2v3.2" /><path d="M8 11.4v.1" />
  {:else if name === "error"}
    <circle cx="8" cy="8" r="6.2" /><path d="M8 4.6v4.2" /><path d="M8 10.9v.1" />
  {:else if name === "star"}
    <path d="M8 1.9l1.9 3.9 4.2.6-3 3 .7 4.2L8 11.6l-3.8 2 .7-4.2-3-3 4.2-.6z" />
  {:else if name === "tag"}
    <path d="M1.9 2h5.6l6.6 6.6-5.5 5.5L2 7.5z" /><path d="M5 5h.1" />
  {:else if name === "send"}
    <path d="M14.2 1.8L1.8 7l5 2.2 2.2 5z" /><path d="M14.2 1.8L6.8 9.2" />
  {:else if name === "calendar"}
    <path d="M2 3.4h12v10.8H2z" /><path d="M2 6.6h12" /><path d="M5.2 1.8v3" /><path d="M10.8 1.8v3" />
  {:else if name === "chart"}
    <path d="M2 14h12" /><path d="M4.2 11.5V8" /><path d="M8 11.5V4" /><path d="M11.8 11.5V6.4" />
  {:else if name === "question"}
    <circle cx="8" cy="8" r="6.2" /><path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4" /><path d="M8 11.4v.1" />
  {:else}
    <circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4.2" /><path d="M8 4.6v.1" />
  {/if}
</svg>

<style>
  .rich-label-icon {
    flex: 0 0 auto;
    display: inline-block;
    vertical-align: -2px;
    color: currentColor;
  }
</style>
