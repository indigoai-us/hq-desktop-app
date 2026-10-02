<script lang="ts">
  /**
   * Account menu (console-rail US-010). 300 px popover on the You avatar.
   * Paints from the cached identity. Companies are reached from the rail
   * tiles and the More companies popover, so this menu lists none. Sign out
   * confirms through confirm-sign-out.ts before the host ends the session.
   */
  import { focusReturn } from "./focus-return.js";
  import { confirmSignOut } from "../settings/confirm-sign-out.js";
  import type { AccountPageId } from "./account-menu.js";

  interface Props {
    name: string;
    email?: string;
    initials?: string;
    live?: boolean;
    work?: string;
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
  <div class="who">
    <span class="avatar" aria-hidden="true">
      {mark()}
      {#if live}<span class="live" data-testid="account-menu-live"></span>{/if}
    </span>
    <span class="copy">
      <span class="name">{name}</span>
      {#if email}<span class="meta">{email}</span>{/if}
    </span>
    {#if live}
      <span class="chip" data-testid="account-menu-live-chip" title={work || undefined}><i aria-hidden="true"></i>{work || "Live"}</span>
    {/if}
  </div>
  <button type="button" class="row" role="menuitem" data-testid="account-profile" onclick={() => choose("profile")}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
    <span class="t">Profile</span>
  </button>
  <button type="button" class="row" role="menuitem" data-testid="account-billing" onclick={() => choose("billing")}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 15h3" /></svg>
    <span class="t">Billing</span>
  </button>
  <button type="button" class="row" role="menuitem" data-testid="account-settings" onclick={() => choose("settings")}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg>
    <span class="t">Settings</span>
  </button>
  <div class="foot">
    <button type="button" class="row signout" role="menuitem" data-testid="account-sign-out" onclick={signOut}>
      <span class="t indent">Sign out</span>
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

  .who {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 6px 8px 10px;
    border-bottom: 1px solid var(--v4-rowline);
    margin-bottom: 6px;
  }

  .avatar {
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

  .live {
    position: absolute;
    right: -1px;
    bottom: -1px;
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

  .row svg {
    flex: 0 0 auto;
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    color: var(--v4-text-2);
  }

  .indent {
    padding-left: 23px;
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

  .signout {
    color: var(--v4-text-3);
  }
</style>
