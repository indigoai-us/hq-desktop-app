<script lang="ts">
  /**
   * OWNER-R17: the Files right pane, in order Access, Outline, Linked here
   * (then Links out). Each section folds, and the folds are remembered.
   * The Access section loads as its own chunk.
   */
  import type { AdapterPromise, Json, VaultNoteLinks } from "@hq/platform";
  import LazyDoor from "../../shell/LazyDoor.svelte";
  import { accessSectionDoor } from "../../shell/lazy-doors.js";
  import { readCollapsed, writeCollapsed, type RailSection } from "./rail-sections.js";
  import { noteTitle, plural, vaultRelativePath, type OutlineItem, type Vault } from "./vault-model.js";

  interface Props {
    vault: Vault;
    focus: { path: string; isDir: boolean };
    /** True when the focus is the open file, so its outline and links apply. */
    showFileSections: boolean;
    outline: OutlineItem[];
    links: VaultNoteLinks | null;
    access?: {
      companyUidFor: (vault: Vault) => string | null;
      readTree?: ((companyUid: string, prefix: string) => AdapterPromise<Json>) | null;
      readGroups?: ((companyUid: string) => AdapterPromise<Json>) | null;
      ongrant?: ((path: string, isDir: boolean) => void) | null;
    } | null;
    onopen: (path: string, opts: { newTab: boolean }) => void;
    onscrollto: (index: number) => void;
    onfocusfolder: (path: string) => void;
  }

  let { vault, focus, showFileSections, outline, links, access = null, onopen, onscrollto, onfocusfolder }: Props = $props();

  const storage = typeof localStorage === "undefined" ? null : localStorage;
  let collapsed = $state<Record<RailSection, boolean>>(readCollapsed(storage));
  function toggle(section: RailSection): void {
    collapsed = { ...collapsed, [section]: !collapsed[section] };
    writeCollapsed(storage, collapsed);
  }

  const backlinks = $derived(links?.backlinks ?? []);
  const backlinkCount = $derived(links?.backlinkCount ?? 0);
  const outgoing = $derived(links?.outgoing ?? []);
</script>

{#if access}
  <section data-testid="vault-access">
    <h3><button type="button" class="fold" aria-expanded={!collapsed.access} onclick={() => toggle("access")}>Access</button></h3>
    {#if !collapsed.access}
      <!-- Its own chunk: the reads and people display stay off the startup graph. -->
      <LazyDoor
        door={accessSectionDoor}
        props={{
          vault,
          path: focus.path,
          isDir: focus.isDir,
          companyUid: access.companyUidFor(vault),
          readTree: access.readTree ?? null,
          readGroups: access.readGroups ?? null,
          ongrant: access.ongrant ?? null,
          onfocusfolder,
        }}
      />
    {/if}
  </section>
{/if}
{#if showFileSections}
  {#if outline.length > 0}
    <section>
      <h3><button type="button" class="fold" aria-expanded={!collapsed.outline} onclick={() => toggle("outline")}>Outline</button></h3>
      {#if !collapsed.outline}
        <ul class="outline">
          {#each outline as item (item.index)}
            <li style={`--lvl:${item.level}`}>
              <button type="button" onclick={() => onscrollto(item.index)}>{item.text}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
  <section data-testid="vault-backlinks">
    <h3><button type="button" class="fold" aria-expanded={!collapsed.links} onclick={() => toggle("links")}>Linked here</button> <span class="badge">{backlinkCount}</span></h3>
    {#if collapsed.links}
      <!-- Folded. -->
    {:else if backlinks.length === 0}
      <p class="muted">{links ? "No other note links here yet." : "Finding links…"}</p>
    {:else}
      <ul class="links">
        {#each backlinks as b (b.path)}
          <li>
            <button type="button" onclick={(e) => onopen(b.path, { newTab: e.metaKey || e.ctrlKey })}>
              <span>{noteTitle(b.path)}</span>
              <span class="muted">{vaultRelativePath(vault, b.path).split("/").slice(0, -1).join(" / ")}</span>
            </button>
          </li>
        {/each}
      </ul>
      {#if backlinkCount > backlinks.length}
        <p class="muted">and {plural(backlinkCount - backlinks.length, "more note")}</p>
      {/if}
    {/if}
  </section>
  {#if outgoing.length > 0}
    <section>
      <h3>Links out <span class="badge">{outgoing.length}</span></h3>
      <ul class="links">
        {#each outgoing as o (o.path)}
          <li>
            <button type="button" onclick={(e) => onopen(o.path, { newTab: e.metaKey || e.ctrlKey })}>
              <span>{o.isMarkdown ? noteTitle(o.path) : o.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/if}

<style>
  section + section { margin-top: 24px; }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px 6px;
    color: var(--v4-text-3);
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .fold { padding: 0; border: 0; background: none; color: inherit; font: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer; }
  .badge {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font-size: 13px;
    letter-spacing: 0;
  }
  .outline, .links { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; }
  .outline button {
    display: block;
    width: 100%;
    padding: 4px 6px 4px calc(6px + (var(--lvl) - 1) * 12px);
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: 13px;
    line-height: 1.4;
    text-align: left;
    cursor: pointer;
  }
  .outline button:hover, .links button:hover { background: var(--v4-control-faint); color: var(--v4-text-1); }
  .links button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    width: 100%;
    padding: 6px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .muted { margin: 0; color: var(--v4-text-3); font-size: 13px; }
</style>
