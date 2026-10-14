<script lang="ts">
  /**
   * Account menu (console-rail US-010). 300 px popover on the You avatar.
   * Paints from the cached identity. Companies are reached from the rail
   * tiles and the More companies popover, so this menu lists none. Sign out
   * confirms through confirm-sign-out.ts before the host ends the session.
   */
  import RailIcon from "../common/button/RailIcon.svelte";
  import { focusReturn } from "./focus-return.js";
  import { confirmSignOut } from "../settings/confirm-sign-out.js";
  import type { AccountPageId } from "./account-menu.js";
  import TierMark from "../badges/TierMark.svelte";
  import type { ResolvedBadge } from "../badges/badge-catalog.js";

  interface Props {
    name: string;
    email?: string;
    initials?: string;
    live?: boolean;
    work?: string;
    /** The badge behind your tier mark on the picture (badges/TierMark). */
    topBadge?: ResolvedBadge | null;
    anchorLeft?: number;
    anchorBottom?: number;
    onclose?: () => void;
    onpage?: (page: AccountPageId) => void;
    onsignout?: () => void;
  }

  let {
    name,
    email = "",
    initials = "",
    live = false,
    work = "",
    topBadge = null,
    anchorLeft = 64,
    anchorBottom = 16,
    onclose,
    onpage,
    onsignout,
  }: Props = $props();

  function mark(): string {
    if (initials.trim()) return initials.trim().slice(0, 2).toUpperCase();
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  }

  function choose(page: AccountPageId): void {
    onpage?.(page);
  }

  function signOut(): void {
    if (!confirmSignOut()) return;
    onsignout?.();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onclose?.();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<button
  type="button"
  class="scrim"
  aria-label="Close account menu"
  data-testid="account-menu-scrim"
  onclick={() => onclose?.()}
></button>
<div
  class="menu"
  role="menu"
  tabindex="-1"
  aria-label="Account"
  data-testid="account-menu"
  use:focusReturn
  style="left: {anchorLeft}px; bottom: {anchorBottom}px;"
>
  <!-- OWNER-R21: the name block opens Settings at Profile; Profile and
       Billing are items in the one Settings list, not separate entries. -->
  <div class="head">
  <button type="button" class="who" role="menuitem" data-testid="account-identity" onclick={() => choose("profile")}>
    <span class="avatar" aria-hidden="true">
      {mark()}
      {#if live}<span class="live" data-testid="account-menu-live"></span>{/if}
      {#if topBadge}<TierMark tier={topBadge.tier} avatar={32} badge={topBadge} />{/if}
    </span>
    <span class="copy">
      <span class="name">{name}</span>
      {#if email}<span class="meta">{email}</span>{/if}
    </span>
    {#if live}
      <span class="chip" data-testid="account-menu-live-chip" title={work || undefined}><i aria-hidden="true"></i>{work || "Live"}</span>
    {/if}
  </button>
  </div>
  <button type="button" class="row" role="menuitem" data-testid="account-settings" onclick={() => choose("settings")}>
    <span class="row-ico" aria-hidden="true"><RailIcon name="settings" size={15} /></span>
    <span class="t">Settings</span>
  </button>
  <div class="foot">
    <button type="button" class="row signout" role="menuitem" data-testid="account-sign-out" onclick={signOut}>
      <span class="row-ico" aria-hidden="true"><RailIcon name="logout" size={15} /></span>
      <span class="t">Sign out</span>
    </button>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 30;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }

  .menu {
    position: fixed;
    z-index: 31;
    width: 300px;
    max-height: calc(100vh - 24px);
    overflow: auto;
    padding: 8px;
    background: var(--overlay-bg);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-popover, 8px);
    box-shadow: var(--v4-shadow-popover);
    color: var(--v4-text-1);
  }

  .who:hover { background: var(--overlay-hover); }
  .who {
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 6px 8px;
  }

  /* The divider sits under the name block, not on it, with the same gaps
     as the one above Sign out: a hovered row never runs into a line. */
  .head {
    margin-bottom: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--v4-rowline);
  }

  .avatar {
    --tier-cutout: var(--overlay-bg);
    position: relative;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    font: 500 11px/1 var(--font-ui);
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
  }

  /* Top right: the bottom right holds the tier mark (badges/TierMark). */
  .live {
    position: absolute;
    right: -1px;
    top: -1px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--v4-ok);
    border: 2px solid var(--overlay-bg);
  }

  .copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .name {
    font-size: 13px;
    font-weight: 500;
  }

  .meta {
    font-size: 13px;
    color: var(--v4-text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chip {
    margin-left: auto;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 140px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0;
    font: 400 13px/1.2 var(--font-ui);
    color: var(--v4-text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chip i {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-ok);
  }

  .row-ico {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    color: var(--v4-text-2);
  }

  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    padding: 4px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--v4-text-1);
    font: 400 13px/1.2 var(--font-ui);
    text-align: left;
    cursor: default;
  }

  .row:hover,
  .row:focus-visible {
    background: var(--v4-active-row);
    outline: none;
  }

  .t {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .foot {
    margin-top: 4px;
    padding-top: 6px;
    border-top: 1px solid var(--v4-rowline);
  }

  .signout,
  .signout .row-ico {
    color: var(--v4-text-3);
  }
</style>
