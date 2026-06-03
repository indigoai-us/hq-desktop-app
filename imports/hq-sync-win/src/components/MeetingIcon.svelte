<script lang="ts">
  /**
   * Meeting-invite icon in the Popover header.
   *
   * Calendar/dot glyph; click opens the standalone `meetings-window` (via
   * `invoke('open_meetings_window')`). Parent gates rendering on the
   * `meetings_feature_enabled` check so this component is only mounted for
   * users on the @getindigo.ai allowlist.
   */
  interface Props {
    onclick: () => void;
    /** Optional badge — e.g. number of upcoming meetings. Future use. */
    count?: number;
  }
  let { onclick, count }: Props = $props();
</script>

<button
  type="button"
  class="meeting-icon-btn"
  {onclick}
  title="Upcoming meetings"
  aria-label="Open meetings"
>
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <!-- Calendar with a small filled dot — reads as "agenda + live indicator". -->
    <rect
      x="1.5"
      y="2.5"
      width="13"
      height="12"
      rx="2"
      stroke="currentColor"
      stroke-width="1.6"
    />
    <path
      d="M4.5 1v3M11.5 1v3M1.5 6h13"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    />
    <circle cx="11.5" cy="10.75" r="1.5" fill="currentColor" />
  </svg>
  {#if count !== undefined && count > 0}
    <span class="meeting-icon-badge">{count > 9 ? '9+' : count}</span>
  {/if}
</button>

<style>
  /* Matches the .header-notif-history / .header-company-os vocabulary in
     Popover.svelte (token-based, monochrome, 8px radius, no-drag) so the header
     action row is one consistent control family. The app uses no severity
     colour (DESIGN.md), so the calendar's filled dot — not a stoplight tint —
     carries any "something's live" cue. */
  .meeting-icon-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.875rem;
    height: 1.875rem;
    border-radius: 8px;
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    background: transparent;
    color: var(--popover-text-heading, #ffffff);
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
    padding: 0;
    margin-right: 0.375rem;
    -webkit-app-region: no-drag;
  }
  .meeting-icon-btn:hover {
    background: var(--popover-action-hover, rgba(255, 255, 255, 0.1));
    border-color: var(--popover-highlight, rgba(255, 255, 255, 0.34));
  }
  .meeting-icon-btn:focus-visible {
    outline: 2px solid var(--popover-highlight, rgba(255, 255, 255, 0.34));
    outline-offset: 2px;
  }
  /* Monochrome badge — primary fill + inverted glyph, the same selected/active
     language used across the popover. No red. */
  .meeting-icon-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background: var(--popover-primary, #ffffff);
    color: var(--popover-primary-text, #111113);
    font-size: 9px;
    font-weight: 600;
    line-height: 14px;
    text-align: center;
  }
</style>
