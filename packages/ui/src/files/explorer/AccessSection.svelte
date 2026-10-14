<script lang="ts">
  /**
   * OWNER-R17: who can open the focused file or folder. Shared by the Files
   * page and the company Vault page, loaded lazily into their right pane.
   *
   * Reads the hq-pro access tree for the path (debounced while arrowing
   * through the tree; a newer focus drops an older read). The last good
   * answer per path paints at once and refreshes in the background. Until a
   * read succeeds it never says who has access.
   */
  import type { AdapterPromise, Json } from "@hq/platform";
  import ReadLoader from "../../common/ReadLoader.svelte";
  import RailButton from "../../common/button/RailButton.svelte";
  import PersonName from "../../common/people/PersonName.svelte";
  import type { Vault } from "./vault-model.js";
  import {
    accessCache,
    accessTargetFor,
    accessView,
    groupNames,
    inheritedPath,
    type AccessView,
  } from "./access-model.js";

  interface Props {
    vault: Vault;
    path: string;
    isDir: boolean;
    /** Cloud uid of the vault; null when it is not in the cloud. */
    companyUid: string | null;
    readTree?: ((companyUid: string, prefix: string) => AdapterPromise<Json>) | null;
    readGroups?: ((companyUid: string) => AdapterPromise<Json>) | null;
    /** Opens the existing Grant access sheet (its own confirm). Absent: no control. */
    ongrant?: ((path: string, isDir: boolean) => void) | null;
    /** Focus the folder access is inherited from. */
    onfocusfolder?: (path: string) => void;
    /** Debounce before a read, so arrowing through rows does not fire one each. */
    debounceMs?: number;
  }

  let { vault, path, isDir, companyUid, readTree = null, readGroups = null, ongrant = null, onfocusfolder, debounceMs = 250 }: Props = $props();

  const target = $derived(accessTargetFor(vault, path, isDir, companyUid));
  let view = $state<AccessView | null>(null);
  let failed = $state(false);
  let attempt = $state(0);
  let seq = 0;
  const groupCache = new Map<string, Map<string, string>>();

  async function groupsFor(uid: string): Promise<Map<string, string>> {
    const hit = groupCache.get(uid);
    if (hit) return hit;
    if (!readGroups) return new Map();
    const res = await readGroups(uid);
    if (!res.ok) {
      // Names only; a failed group read leaves "a group" rather than failing the list.
      console.warn("[access] group names unavailable", res.message ?? res.reason);
      return new Map();
    }
    const names = groupNames(res.value);
    groupCache.set(uid, names);
    return names;
  }

  $effect(() => {
    const t = target;
    void attempt;
    const mine = ++seq;
    failed = false;
    if (t.kind !== "vault") {
      view = null;
      return;
    }
    // Locals only: the effect writes `view` and `failed`, so it never reads them.
    const cached = accessCache.get(t);
    view = cached;
    if (!readTree) {
      if (!cached) failed = true;
      return;
    }
    const read = readTree;
    const timer = setTimeout(async () => {
      try {
        const [res, groups] = await Promise.all([read(t.companyUid, t.prefix), groupsFor(t.companyUid)]);
        if (mine !== seq) return;
        if (!res.ok) throw new Error(res.message ?? res.reason);
        const next = accessView(res.value, groups);
        accessCache.set(t, next);
        view = next;
      } catch (err) {
        console.warn("[access] access read failed", t.prefix, err);
        if (mine !== seq) return;
        // A cached answer stays on screen; only an empty section shows the failure.
        if (!cached) failed = true;
      }
    }, cached ? 0 : debounceMs);
    return () => clearTimeout(timer);
  });
</script>

<div class="acc" data-testid="access-section">
  {#if target.kind === "local"}
    <p class="muted" data-testid="access-local">On this Mac only. Not synced or shared.</p>
  {:else if target.kind === "personal-unshared"}
    <p class="muted" data-testid="access-only-you">Only you</p>
  {:else if view}
    {#if vault.kind === "personal" && view.rows.length <= 1}
      <p class="muted" data-testid="access-only-you">Only you</p>
    {:else}
      <ul class="rows" data-testid="access-rows">
        {#each view.rows.filter((r) => vault.kind === "company" || r.kind !== "owner") as row (row.key)}
          <li class="row" data-testid="access-row" data-kind={row.kind}>
            <span class="who">
              {#if row.person}<PersonName person={row.person} />{:else}<span class="nm">{row.name}</span>{/if}
            </span>
            <span class="lvl">{row.levelLabel}</span>
            <span class="why">{row.reason}</span>
          </li>
        {/each}
      </ul>
    {/if}
    {#if view.inheritedFrom !== null}
      <p class="muted inh" data-testid="access-inherited">
        Inherits access from
        <button type="button" class="link" data-testid="access-inherited-link" onclick={() => onfocusfolder?.(inheritedPath(target.kind === "vault" ? target.root : "", view!.inheritedFrom!))}>
          {view.inheritedFrom || vault.label}
        </button>
      </p>
    {/if}
    {#if ongrant && view.canGrant}
      <div class="grant">
        <RailButton icon="user-plus" data-testid="access-grant" onclick={() => ongrant?.(path, isDir)}>Grant access</RailButton>
      </div>
    {/if}
  {:else if failed}
    <div class="failed" role="alert" data-testid="access-failed">
      <p>Couldn't read who has access.</p>
      <RailButton icon="refresh" data-testid="access-retry" onclick={() => (attempt += 1)}>Try again</RailButton>
    </div>
  {:else}
    <ReadLoader testid="access-loader" onretry={() => (attempt += 1)} />
  {/if}
</div>

<style>
  .acc { display: grid; gap: 6px; min-width: 0; font-size: 13px; }
  .rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; min-width: 0; }
  .who { min-width: 0; overflow: hidden; color: var(--v4-text-1); }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lvl { color: var(--v4-text-2); white-space: nowrap; }
  .why { grid-column: 1 / -1; color: var(--v4-text-3); }
  .muted { margin: 0; color: var(--v4-text-3); }
  .inh { overflow-wrap: anywhere; }
  .link { background: none; border: 0; padding: 0; color: var(--v4-text-2); text-decoration: underline; cursor: pointer; font: inherit; }
  .failed { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .failed p { margin: 0; color: var(--v4-text-2); }
</style>
