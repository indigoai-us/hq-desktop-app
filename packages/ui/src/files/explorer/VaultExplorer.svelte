<script lang="ts">
  /**
   * VaultExplorer: the Files page. An Obsidian-style, read-only explorer over
   * the local HQ folder, one vault at a time: Personal, or a company the
   * person belongs to.
   *
   * Layout: vault switcher and lazy tree on the left; tabs, breadcrumbs and
   * the reading view in the middle; outline and backlinks on the right.
   * Cmd+O opens the quick switcher.
   *
   * Reading goes through the native file commands, which canonicalize every
   * path, keep reads inside the HQ folder and recheck company membership.
   * A company vault binds the desktop read scope to that company first
   * (`appShell.setActiveCompany`), which the native company gate requires.
   */
  import { untrack } from "svelte";
  import type { PlatformAdapter, VaultIndexWire } from "@hq/platform";
  import type { Workspace } from "../../chat/workspaces.js";
  import FilePreviewPane from "../FilePreviewPane.svelte";
  import OpenFileInClaudeCode from "../OpenFileInClaudeCode.svelte";
  import NoteView from "./NoteView.svelte";
  import QuickSwitcher from "./QuickSwitcher.svelte";
  import VaultTree from "./VaultTree.svelte";
  import {
    PERSONAL_VAULT,
    backlinksFor,
    breadcrumbs,
    createLinkResolver,
    isMarkdownPath,
    isSystemPath,
    noteTitle,
    pathInVault,
    plural,
    vaultRelativePath,
    vaultStats,
    vaultsFor,
    type OutlineItem,
    type Vault,
  } from "./vault-model.js";
  import "../../chat/tokens.css";

  interface Props {
    adapter: PlatformAdapter;
    companies: Workspace[] | null | undefined;
    /** Vault id to open (`personal` or `company:<slug>`). */
    vaultId?: string | null;
    /** HQ-relative file to open in that vault. */
    path?: string | null;
    /** Reports where the explorer is, for navigation history. */
    onlocationchange?: (location: { vaultId: string; path: string | null }) => void;
  }

  let { adapter, companies, vaultId = null, path = null, onlocationchange }: Props = $props();

  const vaults = $derived(vaultsFor(companies));
  let currentVaultId = $state<string>(untrack(() => vaultId) ?? PERSONAL_VAULT.id);
  const vault = $derived<Vault>(vaults.find((v) => v.id === currentVaultId) ?? PERSONAL_VAULT);

  // Follow navigation (back/forward) into the explorer.
  $effect(() => {
    const wanted = vaultId;
    const wantedPath = path;
    untrack(() => {
      if (wanted && wanted !== currentVaultId) switchVault(wanted, { report: false });
      if (wantedPath && wantedPath !== activePath) openFile(wantedPath, { newTab: false, report: false });
    });
  });

  // ---- read scope ------------------------------------------------------------
  let scopeFor = "";
  let scopePromise: Promise<void> = Promise.resolve();
  function ensureScope(v: Vault): Promise<void> {
    if (v.kind !== "company" || !v.slug) return Promise.resolve();
    if (scopeFor === v.slug) return scopePromise;
    scopeFor = v.slug;
    scopePromise = adapter.appShell
      .setActiveCompany(v.slug)
      .then(() => undefined)
      .catch(() => undefined);
    return scopePromise;
  }

  async function listDir(relPath: string) {
    const v = vault;
    await ensureScope(v);
    const res = await adapter.files.listDir(relPath);
    return res.ok
      ? { ok: true as const, value: res.value as unknown[] }
      : { ok: false as const, message: res.message };
  }

  // ---- index -------------------------------------------------------------------
  let index = $state<VaultIndexWire | null>(null);
  let indexing = $state(false);
  let indexError = $state<string | null>(null);
  let indexGeneration = 0;
  const canIndex = $derived(typeof adapter.files.indexVault === "function");

  async function loadIndex(v: Vault): Promise<void> {
    const gen = ++indexGeneration;
    index = null;
    indexError = null;
    if (!adapter.files.indexVault) return;
    indexing = true;
    await ensureScope(v);
    const res = await adapter.files.indexVault(v.root);
    if (gen !== indexGeneration) return;
    indexing = false;
    if (res.ok) index = res.value;
    else indexError = res.message || "This vault could not be indexed.";
  }

  let showSystem = $state(false);
  const files = $derived(
    (index?.files ?? []).filter((f) => showSystem || !isSystemPath(vault, f.path)),
  );
  const resolver = $derived(index ? createLinkResolver(vault, index.files) : null);
  const stats = $derived(vaultStats(files));

  // ---- tabs and content --------------------------------------------------------
  let tabs = $state<string[]>([]);
  let activeTab = $state(0);
  const activePath = $derived(tabs[activeTab] ?? null);
  let content = $state<Record<string, { source?: string; error?: string }>>({});
  let treeReload = $state(0);

  function report(): void {
    onlocationchange?.({ vaultId: currentVaultId, path: activePath });
  }

  function switchVault(id: string, opts: { report?: boolean } = {}): void {
    if (id === currentVaultId && index) return;
    currentVaultId = id;
    tabs = [];
    activeTab = 0;
    content = {};
    outline = [];
    vaultMenuOpen = false;
    treeReload += 1;
    const v = vaults.find((x) => x.id === id) ?? PERSONAL_VAULT;
    void loadIndex(v);
    if (opts.report !== false) report();
  }

  // First load.
  $effect(() => {
    untrack(() => {
      const initial = currentVaultId;
      currentVaultId = "";
      switchVault(initial, { report: false });
      if (path) openFile(path, { newTab: false, report: false });
    });
  });

  function openFile(p: string, opts: { newTab: boolean; report?: boolean }): void {
    if (!pathInVault(vault, p)) return;
    const existing = tabs.indexOf(p);
    if (existing >= 0) {
      activeTab = existing;
    } else if (opts.newTab || tabs.length === 0 || activeTab < 0) {
      tabs = [...tabs, p];
      activeTab = tabs.length - 1;
    } else {
      tabs = tabs.map((t, i) => (i === activeTab ? p : t));
    }
    if (isMarkdownPath(p) && !content[p]?.source) void loadContent(p);
    outline = [];
    if (opts.report !== false) report();
  }

  async function loadContent(p: string): Promise<void> {
    await ensureScope(vault);
    const res = await adapter.files.getFileContent(p);
    content = {
      ...content,
      [p]: res.ok ? { source: String(res.value ?? "") } : { error: res.message || "This file could not be read." },
    };
  }

  function closeTab(i: number): void {
    tabs = tabs.filter((_, idx) => idx !== i);
    if (activeTab < 0) {
      // Home stays home.
    } else if (activeTab >= tabs.length) activeTab = tabs.length - 1;
    else if (i < activeTab) activeTab -= 1;
    report();
  }

  // ---- side panels -------------------------------------------------------------
  let outline = $state<OutlineItem[]>([]);
  let scrollTo = $state<{ index: number; seq: number } | null>(null);
  let rightOpen = $state(true);
  let switcherOpen = $state(false);
  let vaultMenuOpen = $state(false);

  const backlinks = $derived(
    activePath && resolver && index ? backlinksFor(activePath, index.files, resolver) : [],
  );
  const outgoing = $derived.by(() => {
    if (!activePath || !resolver || !index) return [] as string[];
    const f = index.files.find((x) => x.path === activePath);
    const out: string[] = [];
    for (const t of f?.links ?? []) {
      const r = resolver.resolve(t, activePath);
      if (r && !out.includes(r)) out.push(r);
    }
    return out;
  });

  // Hubs: the notes the most other notes link to.
  const hubs = $derived.by(() => {
    if (!index || !resolver) return [] as Array<{ path: string; count: number }>;
    const counts = new Map<string, number>();
    for (const f of index.files) {
      for (const t of f.links) {
        const r = resolver.resolve(t, f.path);
        if (r && r !== f.path) counts.set(r, (counts.get(r) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([p]) => showSystem || !isSystemPath(vault, p))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([p, count]) => ({ path: p, count }));
  });

  // Top-level folders with file counts, for the vault home.
  const areas = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const f of files) {
      const rel = vaultRelativePath(vault, f.path);
      const top = rel.includes("/") ? rel.split("/")[0] : "";
      if (top) counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9);
  });

  function onkeydown(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
      event.preventDefault();
      switcherOpen = true;
    }
  }

  let copied = $state(false);
  async function copyPath(p: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(p);
      copied = true;
      setTimeout(() => (copied = false), 1400);
    } catch {
      copied = false;
    }
  }

  let revealError = $state<string | null>(null);
  async function reveal(p: string): Promise<void> {
    revealError = null;
    const res = await adapter.files.revealInFinder(p);
    if (!res.ok) revealError = res.message || "Could not open Finder.";
  }

  const canReveal = $derived(adapter.isAvailable("localFiles"));
  const canLaunchClaude = $derived(adapter.isAvailable("canLaunchApps"));

  function vaultInitial(v: Vault): string {
    return v.kind === "personal" ? "P" : (v.label.trim()[0] ?? "?").toUpperCase();
  }
</script>

<svelte:window {onkeydown} />

<div class="vx" data-testid="vault-explorer">
  <aside class="vx-side" aria-label="Vault">
    <div class="vx-side-head">
      <div class="vx-vault">
        <button
          type="button"
          class="vx-vault-btn"
          aria-haspopup="menu"
          aria-expanded={vaultMenuOpen}
          data-testid="vault-switcher"
          onclick={() => (vaultMenuOpen = !vaultMenuOpen)}
        >
          <span class="vx-avatar" class:personal={vault.kind === "personal"}>{vaultInitial(vault)}</span>
          <span class="vx-vault-name">{vault.label}</span>
          <svg viewBox="0 0 16 16" class="vx-caret" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        {#if vaultMenuOpen}
          <div class="vx-menu" role="menu" aria-label="Vaults">
            {#each vaults as v (v.id)}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={v.id === vault.id}
                class="vx-menu-item"
                class:is-current={v.id === vault.id}
                onclick={() => switchVault(v.id)}
              >
                <span class="vx-avatar small" class:personal={v.kind === "personal"}>{vaultInitial(v)}</span>
                <span>{v.label}</span>
                <span class="vx-menu-kind">{v.kind === "personal" ? "Just you" : "Company"}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <button type="button" class="vx-search" onclick={() => (switcherOpen = true)} data-testid="vault-search">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.3" /><path d="m10.2 10.2 3.3 3.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
        <span>Find a file</span>
        <kbd>⌘O</kbd>
      </button>
    </div>
    <div class="vx-tree">
      <VaultTree {vault} {listDir} {activePath} {showSystem} reloadKey={treeReload} onopen={(p, o) => openFile(p, o)} />
    </div>
    <footer class="vx-side-foot">
      {#if vault.kind === "personal"}
        <label class="vx-toggle">
          <input type="checkbox" bind:checked={showSystem} />
          <span>Show HQ system folders</span>
        </label>
      {/if}
      <span class="vx-count">
        {#if indexing}Indexing…{:else if index}{plural(stats.notes, "note")} · {plural(stats.files, "file")}{index.truncated ? "+" : ""}{/if}
      </span>
    </footer>
  </aside>

  <main class="vx-main">
    {#if tabs.length > 0}
      <div class="vx-tabs" role="tablist" aria-label="Open files">
        {#each tabs as t, i (t + i)}
          <div class="vx-tab" class:is-active={i === activeTab}>
            <button type="button" role="tab" aria-selected={i === activeTab} class="vx-tab-btn" onclick={() => { activeTab = i; report(); }} title={t}>
              {noteTitle(t)}
            </button>
            <button type="button" class="vx-tab-close" aria-label={`Close ${noteTitle(t)}`} onclick={() => closeTab(i)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
            </button>
          </div>
        {/each}
      </div>
    {/if}

    {#if activePath}
      <div class="vx-bar">
        <nav class="vx-crumbs" aria-label="Location">
          <button type="button" class="vx-crumb" title="Vault home" onclick={() => { activeTab = -1; report(); }}>{vault.label}</button>
          {#each breadcrumbs(vault, activePath) as c, i (c.path)}
            <span class="vx-sep" aria-hidden="true">/</span>
            <span class="vx-crumb" class:is-leaf={i === breadcrumbs(vault, activePath).length - 1}>{c.label}</span>
          {/each}
        </nav>
        {#if isMarkdownPath(activePath)}
          <div class="vx-actions">
            {#if canLaunchClaude}
              <OpenFileInClaudeCode shell={adapter.shell} file={activePath} authorizedFile variant="compact" />
            {/if}
            <button type="button" class="vx-action" onclick={() => copyPath(activePath)}>{copied ? "Copied" : "Copy path"}</button>
            {#if canReveal}
              <button type="button" class="vx-action" onclick={() => reveal(activePath)} title={revealError ?? "Show in Finder"}>Show in Finder</button>
            {/if}
          </div>
        {/if}
        <button
          type="button"
          class="vx-icon"
          aria-label={rightOpen ? "Hide outline and backlinks" : "Show outline and backlinks"}
          aria-pressed={rightOpen}
          onclick={() => (rightOpen = !rightOpen)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.75" width="12" height="10.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.2" /><path d="M10 3v10" stroke="currentColor" stroke-width="1.2" /></svg>
        </button>
      </div>
    {/if}

    <div class="vx-body">
      <div class="vx-scroll" data-testid="vault-content">
        {#if !activePath}
          <section class="vx-home" data-testid="vault-home">
            <p class="vx-eyebrow">{vault.kind === "personal" ? "Personal vault" : "Company vault"}</p>
            <h1>{vault.label}</h1>
            <p class="vx-lede">
              {#if vault.kind === "personal"}
                Your own notes and knowledge. Every bot and coding tool you use starts from what is in here.
              {:else}
                What {vault.label} knows. Everyone on the team, and every bot and coding tool they use, works from this same vault.
              {/if}
            </p>
            {#if index}
              <div class="vx-stats">
                <div><strong>{stats.notes.toLocaleString()}</strong><span>{stats.notes === 1 ? "note" : "notes"}</span></div>
                <div><strong>{stats.files.toLocaleString()}</strong><span>{stats.files === 1 ? "file" : "files"}</span></div>
                <div><strong>{stats.links.toLocaleString()}</strong><span>{stats.links === 1 ? "link" : "links"}</span></div>
              </div>
            {:else if indexing}
              <p class="vx-muted">Reading the vault…</p>
            {:else if indexError}
              <p class="vx-muted">{indexError}</p>
            {:else if !canIndex}
              <p class="vx-muted">Pick a file on the left to start reading.</p>
            {/if}

            {#if areas.length > 0}
              <h2>Folders</h2>
              <div class="vx-areas">
                {#each areas as [name, count] (name)}
                  <div class="vx-area">
                    <span class="vx-area-name">{name}</span>
                    <span class="vx-area-count">{plural(count, "file")}</span>
                  </div>
                {/each}
              </div>
            {/if}

            {#if hubs.length > 0}
              <h2>Most linked</h2>
              <ul class="vx-list">
                {#each hubs as h (h.path)}
                  <li>
                    <button type="button" onclick={(e) => openFile(h.path, { newTab: e.metaKey || e.ctrlKey })}>
                      <span>{noteTitle(h.path)}</span>
                      <span class="vx-muted">{plural(h.count, "link")} in</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {:else if isMarkdownPath(activePath)}
          {@const c = content[activePath]}
          {#if c?.source !== undefined}
            {#key activePath}
              <NoteView
                path={activePath}
                source={c.source}
                {resolver}
                onopen={(p, o) => openFile(p, o)}
                onoutline={(items) => (outline = items)}
                {scrollTo}
              />
            {/key}
            {#if backlinks.length > 0}
              <section class="vx-inline-links" aria-label="Linked here">
                <h3>Linked here <span class="vx-badge">{backlinks.length}</span></h3>
                <ul class="vx-links">
                  {#each backlinks as b (b.path)}
                    <li>
                      <button type="button" onclick={(e) => openFile(b.path, { newTab: e.metaKey || e.ctrlKey })}>
                        <span>{noteTitle(b.path)}</span>
                        <span class="vx-muted small">{vaultRelativePath(vault, b.path).split("/").slice(0, -1).join(" / ")}</span>
                      </button>
                    </li>
                  {/each}
                </ul>
              </section>
            {/if}
          {:else if c?.error}
            <p class="vx-empty">{c.error}</p>
          {:else}
            <div class="vx-note-skeleton" aria-hidden="true">
              <span style="width:46%;height:26px"></span>
              <span style="width:92%"></span><span style="width:86%"></span><span style="width:64%"></span>
            </div>
          {/if}
        {:else}
          {#key activePath}
            <div class="vx-preview"><FilePreviewPane {adapter} path={activePath} /></div>
          {/key}
        {/if}
      </div>

      {#if activePath && rightOpen}
        <aside class="vx-rail" aria-label="Outline and links" data-testid="vault-rail">
          {#if outline.length > 0}
            <section>
              <h3>Outline</h3>
              <ul class="vx-outline">
                {#each outline as item (item.index)}
                  <li style={`--lvl:${item.level}`}>
                    <button type="button" onclick={() => (scrollTo = { index: item.index, seq: (scrollTo?.seq ?? 0) + 1 })}>{item.text}</button>
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
          <section data-testid="vault-backlinks">
            <h3>Linked here <span class="vx-badge">{backlinks.length}</span></h3>
            {#if backlinks.length === 0}
              <p class="vx-muted small">{indexing ? "Finding links…" : "No other note links here yet."}</p>
            {:else}
              <ul class="vx-links">
                {#each backlinks as b (b.path)}
                  <li>
                    <button type="button" onclick={(e) => openFile(b.path, { newTab: e.metaKey || e.ctrlKey })}>
                      <span>{noteTitle(b.path)}</span>
                      <span class="vx-muted small">{vaultRelativePath(vault, b.path).split("/").slice(0, -1).join(" / ")}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
          {#if outgoing.length > 0}
            <section>
              <h3>Links out <span class="vx-badge">{outgoing.length}</span></h3>
              <ul class="vx-links">
                {#each outgoing as o (o)}
                  <li>
                    <button type="button" onclick={(e) => openFile(o, { newTab: e.metaKey || e.ctrlKey })}>
                      <span>{noteTitle(o)}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        </aside>
      {/if}
    </div>
  </main>

  {#if switcherOpen}
    <QuickSwitcher
      {vault}
      {files}
      {indexing}
      onopen={(p, o) => openFile(p, o)}
      onclose={() => (switcherOpen = false)}
    />
  {/if}
</div>

<style>
  .vx {
    position: relative;
    display: grid;
    grid-template-columns: 272px minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--v4-ground);
    color: var(--v4-text-1);
  }

  /* ---- left ---- */
  .vx-side {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--v4-hairline);
    background: var(--v4-secondary-sidebar, var(--v4-sidebar));
  }
  .vx-side-head {
    display: grid;
    gap: 8px;
    padding: 12px 10px 8px;
  }
  .vx-vault {
    position: relative;
  }
  .vx-vault-btn {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 6px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .vx-vault-btn:hover {
    background: var(--v4-control-faint);
  }
  .vx-vault-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vx-caret {
    width: 14px;
    height: 14px;
    margin-left: auto;
    color: var(--v4-text-3);
  }
  .vx-avatar {
    display: grid;
    flex: none;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    background: color-mix(in srgb, var(--v4-link) 18%, var(--v4-raised));
    color: var(--v4-link);
    font-size: 12px;
    font-weight: 700;
  }
  .vx-avatar.personal {
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
  }
  .vx-avatar.small {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    font-size: 11px;
  }
  .vx-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 20;
    display: grid;
    gap: 2px;
    max-height: 360px;
    padding: 5px;
    overflow-y: auto;
    border: 1px solid var(--v4-hairline);
    border-radius: 10px;
    background: var(--v4-popover-strong);
    box-shadow: var(--v4-shadow-popover);
  }
  .vx-menu-item {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 8px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .vx-menu-item:hover,
  .vx-menu-item.is-current {
    background: var(--v4-active-row);
  }
  .vx-menu-kind {
    margin-left: auto;
    color: var(--v4-text-3);
    font-size: 11px;
  }
  .vx-search {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    background: var(--v4-control-bg, transparent);
    color: var(--v4-text-3);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .vx-search:hover {
    color: var(--v4-text-2);
  }
  .vx-search svg {
    width: 14px;
    height: 14px;
  }
  .vx-search kbd {
    margin-left: auto;
    font: inherit;
    font-size: 11px;
  }
  .vx-tree {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .vx-side-foot {
    display: grid;
    gap: 6px;
    padding: 10px 14px 12px;
    border-top: 1px solid var(--v4-hairline);
    color: var(--v4-text-3);
    font-size: 11.5px;
  }
  .vx-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .vx-toggle input {
    accent-color: var(--v4-link);
  }

  /* ---- middle ---- */
  .vx-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .vx-tabs {
    display: flex;
    gap: 2px;
    padding: 8px 10px 0;
    border-bottom: 1px solid var(--v4-hairline);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .vx-tab {
    display: flex;
    flex: none;
    align-items: center;
    max-width: 220px;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: 8px 8px 0 0;
    color: var(--v4-text-3);
  }
  .vx-tab.is-active {
    border-color: var(--v4-hairline);
    background: var(--v4-ground);
    color: var(--v4-text-1);
    margin-bottom: -1px;
  }
  .vx-tab:hover {
    color: var(--v4-text-1);
  }
  .vx-tab-btn {
    padding: 7px 4px 7px 12px;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .vx-tab-close {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    margin-right: 6px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: inherit;
    opacity: 0;
    cursor: pointer;
  }
  .vx-tab:hover .vx-tab-close,
  .vx-tab.is-active .vx-tab-close,
  .vx-tab-close:focus-visible {
    opacity: 0.7;
  }
  .vx-tab-close:hover {
    background: var(--v4-control-faint);
    opacity: 1;
  }
  .vx-tab-close svg {
    width: 12px;
    height: 12px;
  }
  .vx-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 0 12px 0 18px;
    border-bottom: 1px solid var(--v4-hairline);
  }
  .vx-crumbs {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--v4-text-3);
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
  }
  .vx-crumb {
    flex: 0 1 auto;
    min-width: 28px;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    padding: 0;
  }
  button.vx-crumb {
    cursor: pointer;
  }
  button.vx-crumb:hover {
    color: var(--v4-text-1);
  }
  .vx-crumb.is-leaf {
    flex-shrink: 0.2;
    max-width: none;
    color: var(--v4-text-1);
  }
  .vx-sep {
    color: var(--v4-hairline);
  }
  .vx-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
  }
  .vx-action {
    white-space: nowrap;
    padding: 4px 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .vx-action:hover {
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }
  .vx-icon {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    margin-left: 4px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--v4-text-3);
    cursor: pointer;
  }
  .vx-actions + .vx-icon {
    margin-left: 0;
  }
  .vx-icon {
    flex: none;
  }
  .vx-icon[aria-pressed="true"] {
    color: var(--v4-text-1);
  }
  .vx-icon:hover {
    background: var(--v4-control-faint);
  }
  .vx-icon svg {
    width: 16px;
    height: 16px;
  }
  .vx-body {
    display: flex;
    flex: 1;
    min-height: 0;
    container-type: inline-size;
    container-name: vx-body;
  }
  .vx-scroll {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
  }
  .vx-preview {
    height: 100%;
  }
  .vx-empty {
    max-width: 560px;
    margin: 80px auto;
    color: var(--v4-text-3);
    text-align: center;
  }
  .vx-note-skeleton {
    display: grid;
    gap: 14px;
    max-width: 740px;
    margin: 0 auto;
    padding: 48px;
  }
  .vx-note-skeleton span {
    height: 12px;
    border-radius: 6px;
    background: var(--v4-control-faint);
  }

  /* ---- vault home ---- */
  .vx-home {
    max-width: 780px;
    margin: 0 auto;
    padding: 64px 48px 96px;
  }
  .vx-eyebrow {
    margin: 0 0 8px;
    color: var(--v4-text-3);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .vx-home h1 {
    margin: 0;
    font-size: 36px;
    font-weight: 680;
    letter-spacing: -0.025em;
  }
  .vx-lede {
    max-width: 560px;
    margin: 12px 0 28px;
    color: var(--v4-text-2);
    font-size: 15px;
    line-height: 1.6;
  }
  .vx-home h2 {
    margin: 36px 0 12px;
    color: var(--v4-text-2);
    font-size: 13px;
    font-weight: 600;
  }
  .vx-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .vx-stats div {
    display: grid;
    gap: 2px;
    padding: 16px 18px;
    border: 1px solid var(--v4-hairline);
    border-radius: 12px;
    background: var(--v4-raised);
  }
  .vx-stats strong {
    font-size: 24px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }
  .vx-stats span {
    color: var(--v4-text-3);
    font-size: 12px;
  }
  .vx-areas {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
  }
  .vx-area {
    display: grid;
    gap: 3px;
    padding: 12px 14px;
    border: 1px solid var(--v4-hairline);
    border-radius: 10px;
  }
  .vx-area-name {
    font-size: 14px;
    font-weight: 550;
  }
  .vx-area-count {
    color: var(--v4-text-3);
    font-size: 12px;
  }
  .vx-list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .vx-list button,
  .vx-links button {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: 13.5px;
    text-align: left;
    cursor: pointer;
  }
  .vx-list button:hover,
  .vx-links button:hover {
    background: var(--v4-control-faint);
  }
  .vx-list .vx-muted {
    margin-left: auto;
  }
  .vx-muted {
    color: var(--v4-text-3);
  }
  .small {
    font-size: 12px;
  }

  /* ---- right rail ---- */
  .vx-rail {
    flex: none;
    width: 260px;
    padding: 20px 14px 40px;
    border-left: 1px solid var(--v4-hairline);
    overflow-y: auto;
  }
  .vx-rail section + section {
    margin-top: 24px;
  }
  .vx-rail h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px 6px;
    color: var(--v4-text-3);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .vx-badge {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font-size: 10.5px;
    letter-spacing: 0;
  }
  .vx-outline,
  .vx-links {
    display: grid;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .vx-outline button {
    display: block;
    width: 100%;
    padding: 4px 6px 4px calc(6px + (var(--lvl) - 1) * 12px);
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: 12.5px;
    line-height: 1.4;
    text-align: left;
    cursor: pointer;
  }
  .vx-outline button:hover {
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }
  .vx-links button {
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 6px;
    font-size: 13px;
  }
  .vx-links .small {
    font-size: 11px;
  }

  /* The note keeps its reading width; below that the rail folds into the
     page as a "Linked here" section under the note. */
  .vx-inline-links {
    display: none;
    box-sizing: border-box;
    max-width: 740px;
    margin: -80px auto 0;
    padding: 20px 48px 80px;
    border-top: 1px solid var(--v4-hairline);
  }
  .vx-inline-links .vx-links button {
    padding-left: 0;
  }
  .vx-inline-links h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px;
    color: var(--v4-text-3);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  @container vx-body (max-width: 940px) {
    .vx-rail {
      display: none;
    }
    .vx-inline-links {
      display: block;
    }
  }
  @container vx-body (max-width: 620px) {
    .vx-inline-links {
      padding: 20px 24px 60px;
    }
  }
  @media (max-width: 760px) {
    .vx {
      grid-template-columns: 220px minmax(0, 1fr);
    }
    .vx-home {
      padding: 36px 24px 64px;
    }
  }
</style>
