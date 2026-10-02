<script lang="ts">
  /**
   * Rail mount for Profile, Billing, and Settings (US-035).
   * The skeleton is the first frame. The body loads through the lazy door.
   */
  import { onMount } from "svelte";
  import { loadAccountPages } from "./account-lazy.js";
  import type { AccountPageId, AccountRoleRow } from "./account-menu.js";

  interface Props {
    page: AccountPageId;
    name: string;
    email?: string;
    initials?: string;
    live?: boolean;
    roles: readonly AccountRoleRow[];
    openExternal?: (url: string) => void;
    onsignout?: () => void;
    oncompany?: (uid: string) => void;
    onsettingssection?: (section: string) => void;
  }

  let {
    page,
    name,
    email = "",
    initials = "",
    live = false,
    roles,
    openExternal,
    onsignout,
    oncompany,
    onsettingssection,
  }: Props = $props();

  let Body = $state<typeof import("../account/AccountPages.svelte").default | null>(null);

  onMount(() => {
    void loadAccountPages().then((mod) => {
      Body = mod.default;
    });
  });
</script>

<div class="host" data-testid="account-host" data-page={page} data-story="US-035">
  {#if Body}
    <Body
      {page}
      {name}
      {email}
      {initials}
      {live}
      {roles}
      {openExternal}
      {onsignout}
      {oncompany}
      {onsettingssection}
    />
  {:else}
    <div class="skeleton" data-testid="account-skeleton" aria-busy="true">
      <aside>
        <div class="bar"></div>
        <div class="bar"></div>
        <div class="bar"></div>
      </aside>
      <main>
        <div class="title"></div>
        <div class="row"></div>
        <div class="row"></div>
        <div class="row"></div>
      </main>
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .skeleton {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    height: 100%;
    gap: 16px;
    padding: 16px;
  }
  .bar, .title, .row {
    border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
    background-size: 200% 100%;
    animation: account-skel 1.1s linear infinite;
  }
  .bar { height: 28px; margin-bottom: 8px; }
  .title { height: 22px; width: 160px; }
  .row { height: 36px; margin-top: 8px; }
  @keyframes account-skel { from { background-position: 100% 0; } to { background-position: -100% 0; } }
</style>
