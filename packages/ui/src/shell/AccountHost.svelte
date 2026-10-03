<script lang="ts">
  /**
   * Rail mount for Profile, Billing, and Settings (US-035).
   * The loader is the first frame. The body loads through the lazy door.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
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
    /** RELEASE-001 gate for the Edit shortcuts sheet. */
    shortcutEditing?: boolean;
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
    shortcutEditing = true,
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
      {shortcutEditing}
    />
  {:else}
    <div class="loading">
      <ReadLoader testid="account-loading" />
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .loading { padding: 16px; }
</style>
