<script lang="ts">
  import ReadLoader from "../../common/ReadLoader.svelte";
  import RailButton from "../../common/button/RailButton.svelte";
  import { dismissable } from "../../common/dismissable.js";
  /**
   * Company Brain (US-028): Knowledge, Policies, Skills, Workers.
   * First frame is the cache or a shimmer. Refresh runs after paint.
   * Heavy enough to stay behind a lazy door.
   */
  import type { AppShellApi, FilesApi, LibraryApi, PlatformAdapter, SettingsApi, ShellApi } from "@hq/platform";
  import { openAgentWorkflow } from "../agent-workflow.js";
  import { loadLibraryCompany } from "../../library/library.js";
  import type { DirEntry } from "../../files/file-tree.js";
  import ShowMoreRow from "../../shell/ShowMoreRow.svelte";
  import VaultTree from "../../files/explorer/VaultTree.svelte";
  import WorkerDetailPane from "./WorkerDetailPane.svelte";
  import { workerStatusLabel } from "./worker-detail.js";
  import type { TreeEntry, Vault } from "../../files/explorer/vault-model.js";
  import ListEmptyState from "../../common/ListEmptyState.svelte";
  import { publishCompanyPageCount } from "../../shell/company-page-counts.svelte.js";
  import { pageRows } from "../../shell/list-paging.js";
  import type { AdapterPromise, Json } from "@hq/platform";
  import { lastRunCell, mySkillUsage, runsCell, skillUsageRows, teamSkillUsage, type TeamSkillUsage } from "./skill-usage.js";
  import "../../home/tokens.css";
  import "../../common/button/rail-type.css";
  import "../../chat/chat-tokens.css";
  import {
    brainListView,
    emptyBrainCache,
    filterKnowledge,
    freshKnowledge,
    isConflictCopy,
    knowledgeDirListing,
    knowledgeTreeRoot,
    filterPolicies,
    filterSkills,
    filterWorkers,
    groupPolicies,
    knowledgeFromFile,
    policyCreatePrompt,
    policyFromFile,
    isPolicyFileName,
    mapLimit,
    readBrainCache,
    skillCreatePrompt,
    skillRowFromLibrary,
    skillRunPrompt,
    slugify,
    virtualWindow,
    workerCreatePrompt,
    workerRowFromLibrary,
    writeBrainCache,
    type BrainListLoad,
    type BrainPageId,
    type KnowledgeFile,
    type PolicyDoc,
    type PolicyDraft,
    type PolicyEnforcement,
    type PolicyFilter,
    type PolicyScope,
    type SkillDraft,
    type SkillFilter,
    type SkillRow,
    type SkillScope,
    type SkillTemplate,
    type WorkerDraft,
    type WorkerFilter,
    type WorkerRow,
    type WorkerScope,
    type WorkerScopeFilter,
    inspectedRow,
  } from "./brain-model.js";

  interface Props {
    page: BrainPageId;
    slug: string;
    files: FilesApi | null;
    library: LibraryApi | null;
    shell: ShellApi | null;
    settings: SettingsApi | null;
    /**
     * Binds the native read scope to this company before any file read. The
     * desktop file commands refuse company paths until the session's active
     * company is that slug (QA-009); without it every listing came back empty.
     */
    appShell?: Pick<AppShellApi, "setActiveCompany"> | null;
    onopenpage?: (rowId: string) => void;
    /** OWNER-R12: the worker pane opens files in the Files preview, which reads through the adapter. */
    adapter?: PlatformAdapter | null;
    /**
     * OWNER-R11: usage reads for the Skills Usage tab. `team` is hq-pro
     * company telemetry (the web Activity read); `mine` is /v1/telemetry/me.
     */
    usage?: {
      team?: ((slug: string, range: { from: string; to: string }) => AdapterPromise<Json>) | null;
      mine?: ((from: string, to: string) => AdapterPromise<Json>) | null;
    } | null;
  }

  let {
    page,
    slug,
    files,
    library,
    shell,
    settings,
    appShell = null,
    onopenpage,
    usage = null,
    adapter = null,
  }: Props = $props();

  let cache = $state(emptyBrainCache());
  let phase = $state<"shimmer" | "ready">("shimmer");
  // QA-100: "ready" can mean cached rows; only `load` says the read finished.
  let load = $state<BrainListLoad>("not-loaded");
  let status = $state("");
  let readError = $state("");
  // AUDIT-3-17: lists whose read failed; an empty failed list is not "No policies yet."
  let failedLists = $state<string[]>([]);
  let query = $state("");
  let lens = $state<"tree" | "fresh">("tree");
  let policyFilter = $state<PolicyFilter>("all");
  let skillFilter = $state<SkillFilter>("all");
  let skillTab = $state<"library" | "usage">("library");
  let usageRange = $state<"7d" | "30d" | "90d">("30d");
  let workerScope = $state<WorkerScopeFilter>("all");
  let workerFilter = $state<WorkerFilter>("all");
  // Every list shows all rows, in pages of 50 with a Show more row.
  let pages = $state(1);
  let scrollTop = $state(0);
  let selected = $state<string | null>(null);
  let sheet = $state<"policy" | "skill" | "worker" | "picker" | null>(null);
  // QA-034: the skill picker is nested inside New worker, so dismissing it
  // returns to that form instead of closing both.
  function dismissSheet(): void {
    sheet = sheet === "picker" ? "worker" : null;
  }
  let shareOpen = $state(false);

  // OWNER-R11: each read has its own state, so one failing never blanks the other.
  type UsageRead<T> = { state: "idle" | "loading" | "ok" | "failed"; data: T | null };
  let teamUsage = $state<UsageRead<Map<string, TeamSkillUsage>>>({ state: "idle", data: null });
  let myUsage = $state<UsageRead<Map<string, number>>>({ state: "idle", data: null });
  let usageNonce = $state(0);
  const usageDays = { "7d": 7, "30d": 30, "90d": 90 } as const;
  const isoDay = (ms: number) => new Date(ms).toISOString().split("T")[0]!;

  async function readUsage<T>(
    run: (() => AdapterPromise<Json>) | null,
    parse: (body: unknown) => T,
    set: (next: UsageRead<T>) => void,
    alive: () => boolean,
  ): Promise<void> {
    if (!run) {
      set({ state: "failed", data: null });
      return;
    }
    set({ state: "loading", data: null });
    try {
      const res = await run();
      if (!res.ok) throw new Error(res.message ?? res.reason);
      const data = parse(res.value);
      if (alive()) set({ state: "ok", data });
    } catch (err) {
      console.error("skill usage read failed:", err);
      if (alive()) set({ state: "failed", data: null });
    }
  }

  // The Usage tab and the skill detail both show usage; read once either is open.
  const wantUsage = $derived(page === "skills" && (skillTab === "usage" || selected !== null));
  $effect(() => {
    if (!wantUsage) return;
    const activeSlug = slug;
    const activeRange = usageRange;
    void usageNonce;
    const now = Date.now();
    const from = isoDay(now - (usageDays[activeRange] - 1) * 86_400_000);
    const to = isoDay(now);
    const alive = () => slug === activeSlug && usageRange === activeRange;
    const team = usage?.team ?? null;
    const mine = usage?.mine ?? null;
    void readUsage(team && activeSlug ? () => team(activeSlug, { from, to }) : null, teamSkillUsage, (n) => (teamUsage = n), alive);
    void readUsage(mine ? () => mine(from, to) : null, mySkillUsage, (n) => (myUsage = n), alive);
  });


  let policyDraft = $state<PolicyDraft>({
    title: "",
    enforcement: "hard",
    when: "",
    scope: "company",
    satisfiedBy: "",
    body: "",
  });
  let skillDraft = $state<SkillDraft>({
    name: "",
    scope: "company",
    triggers: [],
    template: "brief",
  });
  let triggerInput = $state("");
  let workerDraft = $state<WorkerDraft>({
    name: "",
    scope: "company",
    description: "",
    skills: [],
    tools: [],
    knowledge: "",
  });
  let pickerQuery = $state("");

  const knowledgeRows = $derived(filterKnowledge(cache.knowledge, query));
  // OWNER-R10: Browse tree is the Files tree, fed from the knowledge paths
  // already read; What's fresh is the flat list, most recently changed first.
  const freshRows = $derived(freshKnowledge(knowledgeRows));
  const knowledgeVault = $derived<Vault>({
    id: `knowledge:${slug}`,
    kind: "company",
    label: "Knowledge",
    root: knowledgeTreeRoot(slug),
    slug,
  });
  const knowledgePaths = $derived(knowledgeRows.map((row) => row.path));
  // A new search or a new read rebuilds the tree; switching tabs does not.
  const treeKey = $derived(`${query.trim()}|${cache.knowledge.length}`);
  let treeReload = $state(0);
  let lastTreeKey = "";
  $effect(() => {
    const key = treeKey;
    if (key !== lastTreeKey) {
      lastTreeKey = key;
      treeReload += 1;
    }
  });
  async function listKnowledgeDir(dir: string) {
    return { ok: true as const, value: knowledgeDirListing(knowledgePaths, dir) };
  }
  const conflictNote = (entry: TreeEntry) => (!entry.isDir && isConflictCopy(entry.name) ? "conflict copy" : null);
  const policyRows = $derived(filterPolicies(cache.policies, policyFilter, query));
  const skillRows = $derived(filterSkills(cache.skills, skillFilter, query));
  const workerRows = $derived(filterWorkers(cache.workers, workerScope, workerFilter, query));

  // The sidepane shows these same totals (QA-014), published once the page is ready.
  $effect(() => {
    if (phase !== "ready") return;
    publishCompanyPageCount(slug, "knowledge", cache.knowledge.length);
    publishCompanyPageCount(slug, "policies", cache.policies.length);
    publishCompanyPageCount(slug, "skills", cache.skills.length);
    publishCompanyPageCount(slug, "workers", cache.workers.length);
  });
  const activeList = $derived(
    page === "knowledge" ? knowledgeRows : page === "policies" ? policyRows : page === "skills" ? skillRows : workerRows,
  );
  $effect(() => {
    void page;
    void query;
    void policyFilter;
    void skillFilter;
    pages = 1;
  });
  const listPage = $derived(
    pageRows<KnowledgeFile | PolicyDoc | SkillRow | WorkerRow>(activeList, pages),
  );
  const shown = $derived(listPage.rows);
  const windowed = $derived(virtualWindow(shown.length, scrollTop, 640));
  const slice = $derived(shown.slice(windowed.start, windowed.end));
  const policyGroups = $derived(groupPolicies(policyRows));
  // QA-102: the inspector reads the filtered rows, so a search or filter that
  // hides the selection never leaves its detail and actions on screen.
  const selectedSkill = $derived(inspectedRow(skillRows, selected));
  const usageRows = $derived(skillUsageRows(skillRows, teamUsage.data, myUsage.data));
  const selectedUsage = $derived(selectedSkill ? skillUsageRows([selectedSkill], teamUsage.data, myUsage.data)[0] : null);
  const selectedWorker = $derived(inspectedRow(workerRows, selected));
  const selectedPolicy = $derived(inspectedRow(policyRows, selected));
  const selectedFile = $derived(inspectedRow(knowledgeRows, selected));
  $effect(() => {
    if (selected && !activeList.some((row) => row.path === selected)) selected = null;
  });
  const title = $derived(page === "knowledge" ? "Knowledge" : page === "policies" ? "Policies" : page === "skills" ? "Skills" : "Workers");
  // QA-058: the unfiltered total and filter state behind the shared empty state.
  const sourceTotal = $derived(
    page === "knowledge" ? cache.knowledge.length : page === "policies" ? cache.policies.length : page === "skills" ? cache.skills.length : cache.workers.length,
  );
  const listView = $derived(brainListView(load, sourceTotal));
  const listReadFailed = $derived(sourceTotal === 0 && failedLists.includes(page));
  const filterActive = $derived(
    page === "policies" ? policyFilter !== "all" : page === "skills" ? skillFilter !== "all" : page === "workers" ? workerScope !== "all" || workerFilter !== "all" : false,
  );
  const listNoun = $derived<readonly [string, string]>(
    page === "knowledge" ? ["file", "files"] : page === "policies" ? ["policy", "policies"] : page === "skills" ? ["skill", "skills"] : ["worker", "workers"],
  );
  function clearListFilters(): void {
    query = "";
    policyFilter = "all";
    skillFilter = "all";
    workerScope = "all";
    workerFilter = "all";
  }

  // AUDIT-3: Try again after a partial read re-runs the load below.
  let readAttempt = $state(0);

  $effect(() => {
    const key = slug;
    void readAttempt;
    readError = "";
    failedLists = [];
    const hit = readBrainCache(key);
    query = "";
    selected = null;
    pages = 1;
    sheet = null;
    load = "loading";
    if (hit) {
      cache = hit;
      phase = "ready";
    } else {
      cache = emptyBrainCache();
      phase = "shimmer";
    }
    let live = true;
    void refresh(key)
      .catch((err) => {
        console.warn("[brain] company files read did not finish", err);
        if (!live || slug !== key) return;
        readError = "Some company files could not be read.";
        failedLists = ["knowledge", "policies", "skills", "workers"];
      })
      .then(() => {
        if (!live) return;
        phase = "ready";
        load = "loaded";
      });
    return () => {
      live = false;
    };
  });

  async function refresh(key: string): Promise<void> {
    const next = readBrainCache(key) ?? emptyBrainCache();
    if (files && key) {
      if (appShell) {
        const bound = await appShell.setActiveCompany(key);
        if (!bound.ok) console.warn("[brain] could not bind company scope", bound.message);
      }
      const [knowledge, policies] = await Promise.all([
        readKnowledge(files, `companies/${key}/knowledge`),
        readPolicies(files, `companies/${key}/policies`),
      ]);
      if ((knowledge === null || policies === null) && slug === key) {
        readError = "Some company files could not be read.";
        failedLists = [...failedLists, ...(knowledge === null ? ["knowledge"] : []), ...(policies === null ? ["policies"] : [])];
      }
      next.knowledge = knowledge ?? next.knowledge;
      next.policies = policies ?? next.policies;
    }
    if (library && key) {
      const result = await loadLibraryCompany(library, key);
      if (result.ok) {
        next.skills = result.value.skills.map((skill) => skillRowFromLibrary(skill, key));
        next.workers = result.value.workers.map(workerRowFromLibrary);
      } else {
        console.warn("[brain] library read failed", result.message);
        if (slug === key) {
          readError = "Some company files could not be read.";
          failedLists = [...failedLists, "skills", "workers"];
        }
      }
    }
    writeBrainCache(key, next);
    if (slug === key) cache = next;
  }

  const READ_CONCURRENCY = 16;

  /** Null when the folder listing itself failed (kept apart from "empty"). */
  async function readKnowledge(api: FilesApi, root: string): Promise<KnowledgeFile[] | null> {
    const paths = await collectFiles(api, root, 0, () => true);
    if (paths === null) return null;
    return mapLimit(paths, READ_CONCURRENCY, async (path) => {
      const res = await api.getFileContent(path);
      return knowledgeFromFile(path, res.ok ? res.value : "");
    });
  }

  async function readPolicies(api: FilesApi, root: string): Promise<PolicyDoc[] | null> {
    const paths = await collectFiles(api, root, 0, isPolicyFileName);
    if (paths === null) return null;
    return mapLimit(paths, READ_CONCURRENCY, async (path) => {
      const res = await api.getFileContent(path);
      return policyFromFile(path, res.ok ? res.value : "");
    });
  }

  async function collectFiles(
    api: FilesApi,
    root: string,
    depth: number,
    keep: (name: string, isDir: boolean) => boolean,
  ): Promise<string[] | null> {
    if (depth > 4) return [];
    const res = await api.listDir(root);
    if (!res.ok || !Array.isArray(res.value)) {
      if (!res.ok) console.warn("[brain] listing failed", root, res.message);
      return depth === 0 ? null : [];
    }
    const entries = res.value as unknown as DirEntry[];
    const filesOut: string[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry.path !== "string" || typeof entry.name !== "string") continue;
      if (!keep(entry.name, entry.isDir)) continue;
      if (entry.isDir) filesOut.push(...((await collectFiles(api, entry.path, depth + 1, keep)) ?? []));
      else if (entry.name.endsWith(".md") || entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) {
        filesOut.push(entry.path);
      }
    }
    return filesOut;
  }

  async function runPrompt(prompt: string, label: string): Promise<void> {
    if (!shell || !settings) {
      status = "Claude Code is not available in this host.";
      return;
    }
    const result = await openAgentWorkflow({ shell, settings }, prompt, label);
    status = result.message;
  }

  async function openPath(path: string): Promise<void> {
    if (!shell) {
      status = "Open is not available in this host.";
      return;
    }
    const res = await shell.openInEditor(path);
    if (!res.ok) console.warn("[brain] open in editor failed", res.code, res.message);
    status = res.ok ? `Opened ${path}` : "Could not open the file. Try again.";
  }

  async function openInClaude(path: string): Promise<void> {
    if (!shell) return;
    const res = await shell.openFileInClaude(path);
    if (!res.ok) console.warn("[brain] open in Claude Code failed", res.code, res.message);
    status = res.ok ? "Opened in Claude Code." : "Could not open Claude Code. Try again.";
  }

  async function copyPath(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
      status = "Path copied.";
    } catch {
      status = path;
    }
  }

  function onListScroll(event: Event): void {
    const el = event.currentTarget as HTMLElement;
    scrollTop = el.scrollTop;
  }

  async function submitPolicy(): Promise<void> {
    if (!policyDraft.title.trim()) return;
    await runPrompt(policyCreatePrompt(slug, policyDraft), "policy");
    sheet = null;
  }

  async function submitSkill(): Promise<void> {
    if (!skillDraft.name.trim()) return;
    await runPrompt(skillCreatePrompt(slug, skillDraft), "skill");
    sheet = null;
  }

  async function submitWorker(): Promise<void> {
    if (!workerDraft.name.trim()) return;
    await runPrompt(workerCreatePrompt(slug, workerDraft), "worker");
    sheet = null;
  }

  function addTrigger(): void {
    const value = triggerInput.trim();
    if (!value || skillDraft.triggers.includes(value)) return;
    skillDraft = { ...skillDraft, triggers: [...skillDraft.triggers, value] };
    triggerInput = "";
  }

  function toggleWorkerSkill(name: string): void {
    const has = workerDraft.skills.includes(name);
    workerDraft = {
      ...workerDraft,
      skills: has ? workerDraft.skills.filter((item) => item !== name) : [...workerDraft.skills, name],
    };
  }

  const pickerSkills = $derived(
    cache.skills.filter((row) => row.name.toLowerCase().includes(pickerQuery.trim().toLowerCase())),
  );
</script>

<section class="brain" data-testid="brain-page" data-page={page} data-phase={phase} aria-label={title}>
  <header class="toolbar">
    <h1>{title}</h1>
    {#if page === "policies"}
      <!-- BLANK-2: counts wait for a read that succeeded (BLANK-3: not while loading). -->
      {#if !listReadFailed && listView.body !== "skeleton"}<span class="meta-line" data-meta-line>{policyGroups.hard.length} hard · {policyGroups.soft.length} soft</span>{/if}
      <div class="tabs" role="tablist">
        {#each ["all", "hard", "soft"] as id (id)}
          <button type="button" role="tab" class="tab" aria-selected={policyFilter === id} onclick={() => (policyFilter = id as PolicyFilter)}>{id === "all" ? "All" : id === "hard" ? "Hard" : "Soft"}</button>
        {/each}
      </div>
    {:else if page === "skills"}
      {#if listView.count !== null && !listReadFailed && listView.body !== "skeleton"}<span class="meta-line" data-meta-line>{listView.count} skills</span>{/if}
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab" aria-selected={skillTab === "library"} onclick={() => (skillTab = "library")}>Library</button>
        <button type="button" role="tab" class="tab" aria-selected={skillTab === "usage"} onclick={() => (skillTab = "usage")}>Usage</button>
      </div>
    {:else if page === "workers"}
      {#if !listReadFailed && listView.body !== "skeleton"}<span class="meta-line" data-meta-line data-testid="brain-worker-count">{workerRows.length} workers</span>{/if}
      <div class="tabs" role="tablist">
        {#each [["all", "All"], ["company", "Company"], ["personal", "Personal overlay"]] as [id, label] (id)}
          <button type="button" role="tab" class="tab" aria-selected={workerScope === id} onclick={() => (workerScope = id as WorkerScopeFilter)}>{label}</button>
        {/each}
      </div>
    {:else}
      {#if listView.count !== null && !listReadFailed && listView.body !== "skeleton"}<span class="meta-line" data-meta-line data-testid="brain-knowledge-count">{listView.count} {listView.count === 1 ? "file" : "files"}</span>{/if}
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab" aria-selected={lens === "fresh"} onclick={() => (lens = "fresh")}>What's fresh</button>
        <button type="button" role="tab" class="tab" aria-selected={lens === "tree"} onclick={() => (lens = "tree")}>Browse tree</button>
      </div>
    {/if}
    <span class="grow"></span>
    <input class="search" type="search" placeholder={`Search ${title.toLowerCase()}`} bind:value={query} aria-label={`Search ${title}`} />
    {#if page === "knowledge" || page === "policies"}
      <RailButton icon="folder" onclick={() => onopenpage?.("vault")}>Vault</RailButton>
    {/if}
    {#if page === "policies"}
      <RailButton icon="plus" variant="primary" onclick={() => (sheet = "policy")}>New policy</RailButton>
    {:else if page === "skills"}
      <RailButton icon="plus" variant="primary" onclick={() => (sheet = "skill")}>New skill</RailButton>
    {:else if page === "workers"}
      <RailButton icon="plus" variant="primary" onclick={() => (sheet = "worker")}>New worker</RailButton>
    {/if}
  </header>

  {#if listView.body === "skeleton"}
    <div class="shimmer" data-testid="brain-shimmer" aria-busy="true">
      <div class="bar"></div><div class="bar"></div><div class="bar short"></div>
      <p class="reading" role="status">Reading {listNoun[1]}…</p>
      <ReadLoader testid="brain-loader" onretry={() => (readAttempt += 1)} />
    </div>
  {:else if page === "skills" && skillTab === "usage"}
    <div class="usage" data-testid="skills-usage">
      <div class="filters">
        {#each ["7d", "30d", "90d"] as range (range)}
          <button type="button" role="tab" class="tab" aria-selected={usageRange === range} onclick={() => (usageRange = range as typeof usageRange)}>{range}</button>
        {/each}
        <span class="grow"></span>
        <span class="meta">Sort · team runs</span>
      </div>
      {#if teamUsage.state === "failed"}
        <p class="note" data-testid="skills-usage-team-failed">Team runs could not be read. Only company owners and admins can see them. <button type="button" class="link" onclick={() => (usageNonce += 1)}>Try again</button></p>
      {/if}
      {#if myUsage.state === "failed"}
        <p class="note" data-testid="skills-usage-mine-failed">Your runs could not be read. <button type="button" class="link" onclick={() => (usageNonce += 1)}>Try again</button></p>
      {/if}
      <div class="head usage-grid">
        <span>Skill</span><span>Team runs</span><span title="Across all of your companies">Your runs (all companies)</span><span>People</span><span title="The day of the latest run; the read does not say who ran it">Last run (date)</span>
      </div>
      {#each pageRows(usageRows, pages).rows as row (row.path)}
        <div class="row usage-grid" data-testid="skills-usage-row">
          <span class="name">{row.name}</span>
          <span class="meta">{teamUsage.state === "loading" ? "…" : runsCell(row.teamRuns)}</span>
          <span class="meta">{myUsage.state === "loading" ? "…" : runsCell(row.yourRuns)}</span>
          <span class="meta">{teamUsage.state === "loading" ? "…" : runsCell(row.people)}</span>
          <span class="meta">{teamUsage.state === "loading" ? "…" : lastRunCell(row.lastDay)}</span>
        </div>
      {/each}
      {#if skillRows.length === 0}
        <p class="empty">No skills in this company yet.</p>
      {/if}
    </div>
  {:else}
    <div class="split">
      <div class="list" onscroll={onListScroll} data-testid="brain-list">
        {#if page === "policies"}
          {#each [{ label: "Hard", rows: policyGroups.hard }, { label: "Soft", rows: policyGroups.soft }] as group (group.label)}
            {#if policyFilter === "all" || policyFilter === group.label.toLowerCase()}
              <div class="sec">{group.label}</div>
              {#each group.rows as row (row.path)}
                <button type="button" class="item" aria-current={selectedPolicy?.path === row.path} onclick={() => (selected = row.path)}>
                  <span class="name">{row.title}</span>
                  <span class="badge" class:hard={row.enforcement === "hard"}>{row.enforcement}</span>
                  <span class="meta">{row.createdBy ? `created by ${row.createdBy}` : row.path}{row.edited ? ` · edited ${row.edited}` : ""}</span>
                </button>
              {/each}
            {/if}
          {/each}
        {:else if page === "knowledge"}
          <!-- Kept mounted on What's fresh so the tree's open folders survive a tab switch. -->
          <div class="ktree" hidden={lens !== "tree"} data-testid="brain-knowledge-tree">
            <VaultTree
              vault={knowledgeVault}
              listDir={listKnowledgeDir}
              activePath={selectedFile?.path ?? null}
              showSystem={false}
              reloadKey={treeReload}
              revealAll={query.trim() !== ""}
              noteFor={conflictNote}
              onopen={(path) => (selected = path)}
            />
          </div>
          {#if lens === "fresh"}
            <div class="sec">Recent</div>
            {#each pageRows(freshRows, pages).rows as row (row.path)}
              <button type="button" class="item" aria-current={selectedFile?.path === row.path} onclick={() => (selected = row.path)} data-testid="brain-fresh-row">
                <span class="name">{row.title}</span>
                {#if row.mark}<span class="badge" class:hard={row.mark === "new"}>{row.mark}</span>{/if}
                {#if isConflictCopy(row.name)}<span class="meta">conflict copy</span>{/if}
                {#if row.changed}<span class="meta" data-testid="brain-fresh-changed">{row.changed}</span>{/if}
              </button>
            {/each}
          {/if}
        {:else}
          <div style:height={`${windowed.padTop}px`}></div>
          {#each slice as row (page === "skills" ? (row as unknown as SkillRow).path : page === "workers" ? (row as unknown as WorkerRow).path : (row as unknown as KnowledgeFile).path)}
            {#if page === "skills"}
              {@const skill = row as unknown as SkillRow}
              <button type="button" class="item" aria-current={selectedSkill?.path === skill.path} onclick={() => (selected = skill.path)} data-testid="skill-row">
                <span class="name">{skill.name}</span>
                <span class="meta">{skill.description}</span>
                <span class="meta">{skill.triggers.join(" · ")}</span>
              </button>
            {:else if page === "workers"}
              {@const worker = row as unknown as WorkerRow}
              <button type="button" class="item" class:muted={worker.parked} aria-current={selectedWorker?.path === worker.path} onclick={() => (selected = worker.path)} data-testid="worker-row">
                <span class="name">{worker.name}</span>
                <span class="meta">{worker.description}</span>
                <span class="meta" class:live={worker.live} data-testid="worker-row-status">{worker.live ? "Live" : workerStatusLabel(worker.status)}</span>
              </button>
            {:else}
              {@const file = row as KnowledgeFile}
              <button type="button" class="item" aria-current={selectedFile?.path === file.path} onclick={() => (selected = file.path)}>
                <span class="name">{file.title}</span>
                <span class="meta">{file.path}</span>
              </button>
            {/if}
          {/each}
          <div style:height={`${windowed.padBottom}px`}></div>
        {/if}
        {#if page !== "policies" && !(page === "knowledge" && lens === "tree") && listPage.remaining > 0}
          <ShowMoreRow shown={listPage.rows.length} total={listPage.total} next={listPage.next} noun={title.toLowerCase()} testid="brain-show-more" onmore={() => (pages += 1)} />
        {/if}
        {#if listReadFailed}
          <!-- AUDIT-3-17: the failed-read line and Try again below stand in for the empty line. -->
        {:else if activeList.length === 0}
          <ListEmptyState
            total={sourceTotal}
            shown={activeList.length}
            {query}
            filtered={filterActive}
            noun={listNoun}
            emptyCopy={page === "knowledge" ? "No knowledge files yet." : `No ${title.toLowerCase()} yet.`}
            onclear={clearListFilters}
            testid="brain-empty"
          />
        {/if}
      </div>

      <aside class="detail" data-testid="brain-detail">
        {#if page === "skills" && selectedSkill}
          <p class="kind">Skill</p>
          <h2>{selectedSkill.name}</h2>
          <p class="path">{selectedSkill.path}</p>
          <p>{selectedSkill.description}</p>
          {#if usage && selectedUsage}
            <dl class="skill-usage" data-testid="skill-usage-block">
              <div><dt>Team runs</dt><dd>{runsCell(selectedUsage.teamRuns)}</dd></div>
              <div><dt>Your runs</dt><dd>{runsCell(selectedUsage.yourRuns)}</dd></div>
              <div><dt>People</dt><dd>{runsCell(selectedUsage.people)}</dd></div>
              <div><dt>Last run</dt><dd>{lastRunCell(selectedUsage.lastDay)}</dd></div>
            </dl>
          {/if}
          <div class="actions">
            <RailButton icon="play" variant="primary" data-testid="skill-run" onclick={() => runPrompt(skillRunPrompt(selectedSkill.name), selectedSkill.name)}>Run</RailButton>
            <RailButton icon="claude-code" onclick={() => openInClaude(selectedSkill.path)}>Open in Claude Code</RailButton>
            <RailButton icon="link" onclick={() => (shareOpen = true)}>Share</RailButton>
          </div>
        {:else if page === "workers" && selectedWorker}
          <WorkerDetailPane
            worker={selectedWorker}
            {slug}
            {files}
            {adapter}
            onrun={(prompt, label) => void runPrompt(prompt, label)}
            onopenclaude={(path) => void openInClaude(path)}
            onedit={(path) => void openPath(path)}
            onclose={() => (selected = null)}
            onmore={() => (sheet = "picker")}
          />
        {:else if page === "policies" && selectedPolicy}
          <p class="path">{selectedPolicy.path}</p>
          <h2>{selectedPolicy.title}</h2>
          <div class="chips">
            <span class="chip">scope {selectedPolicy.scope}</span>
            <span class="chip" class:hard={selectedPolicy.enforcement === "hard"}>enforcement {selectedPolicy.enforcement}</span>
            {#if selectedPolicy.when}<span class="chip">when {selectedPolicy.when}</span>{/if}
            {#if selectedPolicy.satisfiedBy}<span class="chip">satisfied by {selectedPolicy.satisfiedBy}</span>{/if}
          </div>
          {#if selectedPolicy.enforcement === "hard"}
            <p class="gate"><b>Hard gate.</b> Unmet HARD policies block completion.</p>
          {/if}
          <div class="actions">
            <RailButton icon="external" onclick={() => openPath(selectedPolicy.path)}>Open</RailButton>
            <RailButton icon="copy" onclick={() => copyPath(selectedPolicy.path)}>Copy path</RailButton>
          </div>
          <div class="body">{selectedPolicy.body}</div>
        {:else if page === "knowledge" && selectedFile}
          <p class="path">{selectedFile.path}</p>
          <h2>{selectedFile.title}</h2>
          <div class="actions">
            <RailButton icon="external" onclick={() => openPath(selectedFile.path)}>Open</RailButton>
            <RailButton icon="copy" onclick={() => copyPath(selectedFile.path)}>Copy path</RailButton>
          </div>
          <div class="body">{selectedFile.body}</div>
        {:else if activeList.length === 0 && sourceTotal > 0 && query.trim()}
          <div class="detail-empty" data-testid="brain-detail-empty">
            <p class="empty">No {listNoun[1]} match “{query.trim()}”</p>
            <RailButton icon="x" onclick={clearListFilters}>Clear search</RailButton>
          </div>
        {:else}
          <p class="empty">Select a row.</p>
        {/if}
      </aside>
    </div>
  {/if}

  {#if readError}
    <div class="status load-error" role="alert" data-testid="brain-read-error">
      <p>{readError}</p>
      <RailButton icon="refresh" data-testid="brain-retry" onclick={() => (readAttempt += 1)}>Try again</RailButton>
    </div>
  {/if}
  {#if status}<p class="status" data-testid="brain-status">{status}</p>{/if}

  {#if sheet}
    <div class="scrim" role="presentation" onclick={dismissSheet}></div>
    <div class="sheet" role="dialog" aria-label={sheet === "policy" ? "New policy" : sheet === "skill" ? "New skill" : sheet === "picker" ? "Skill picker" : "New worker"} data-testid="brain-sheet" use:dismissable={{ onclose: dismissSheet }}>
      <header class="sheet-head">
        <h2>{sheet === "policy" ? "New policy" : sheet === "skill" ? "New skill" : sheet === "picker" ? "Skills" : "New worker"}</h2>
        <button type="button" class="icon-btn" aria-label="Close" onclick={dismissSheet}>✕</button>
      </header>
      {#if sheet === "policy"}
        <label>Title <input bind:value={policyDraft.title} /></label>
        <p class="meta">Saved as companies/{slug}/policies/{slugify(policyDraft.title) || "policy"}.md</p>
        <div class="tabs">
          <button type="button" role="tab" class="tab" aria-selected={policyDraft.enforcement === "hard"} onclick={() => (policyDraft.enforcement = "hard" as PolicyEnforcement)}>Hard</button>
          <button type="button" role="tab" class="tab" aria-selected={policyDraft.enforcement === "soft"} onclick={() => (policyDraft.enforcement = "soft" as PolicyEnforcement)}>Soft</button>
        </div>
        <p class="meta">Hard blocks completion when unmet. Soft steers defaults and never blocks.</p>
        <label>When <input bind:value={policyDraft.when} /></label>
        <div class="tabs">
          {#each ["company", "project", "personal"] as scope (scope)}
            <button type="button" role="tab" class="tab" aria-selected={policyDraft.scope === scope} onclick={() => (policyDraft.scope = scope as PolicyScope)}>{scope}</button>
          {/each}
        </div>
        <label>Satisfied by <input bind:value={policyDraft.satisfiedBy} placeholder="/sync-docs" /></label>
        <label>Body <textarea rows="6" bind:value={policyDraft.body}></textarea></label>
        <footer class="sheet-foot">
          <span class="meta">Versioned in Vault · opens in Claude Code</span>
          <RailButton icon="x" onclick={() => (sheet = null)}>Cancel</RailButton>
          <RailButton icon="check" variant="primary" data-testid="create-policy" onclick={submitPolicy}>Create policy</RailButton>
        </footer>
      {:else if sheet === "skill"}
        <label>Name <input bind:value={skillDraft.name} /></label>
        <p class="meta">Surfaces as /{slugify(skillDraft.name) || "skill"}</p>
        <div class="tabs">
          <button type="button" role="tab" class="tab" aria-selected={skillDraft.scope === "company"} onclick={() => (skillDraft.scope = "company" as SkillScope)}>Company</button>
          <button type="button" role="tab" class="tab" aria-selected={skillDraft.scope === "personal"} onclick={() => (skillDraft.scope = "personal" as SkillScope)}>Personal</button>
        </div>
        <label>Trigger phrases
          <input bind:value={triggerInput} onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTrigger(); } }} />
        </label>
        <div class="chips">
          {#each skillDraft.triggers as phrase (phrase)}
            <button type="button" class="chip" onclick={() => (skillDraft = { ...skillDraft, triggers: skillDraft.triggers.filter((item) => item !== phrase) })}>{phrase} ×</button>
          {/each}
        </div>
        <div class="templates">
          {#each [["blank", "Blank", "Frontmatter only."], ["brief", "Brief", "Reads sources, writes one document."], ["monitor", "Monitor", "Scheduled check with a DM."], ["pipeline", "Pipeline", "Approval gate before anything external."]] as [id, label, hint] (id)}
            <button type="button" role="radio" class="opt" aria-checked={skillDraft.template === id} onclick={() => (skillDraft.template = id as SkillTemplate)}>
              <b>{label}</b> {hint}
            </button>
          {/each}
        </div>
        <footer class="sheet-foot">
          <span class="meta">Creates SKILL.md and opens it in Claude Code</span>
          <RailButton icon="x" onclick={() => (sheet = null)}>Cancel</RailButton>
          <RailButton icon="check" variant="primary" data-testid="create-skill" onclick={submitSkill}>Create skill</RailButton>
        </footer>
      {:else if sheet === "picker"}
        <input placeholder="Search skills" bind:value={pickerQuery} aria-label="Search skills" />
        <p class="meta">{workerDraft.skills.length} selected</p>
        {#each pickerSkills as row (row.path)}
          <button type="button" class="item" aria-pressed={workerDraft.skills.includes(row.name)} onclick={() => toggleWorkerSkill(row.name)}>
            <span class="name">{row.name}</span>
            <span class="meta">{row.description}</span>
          </button>
        {/each}
        <footer class="sheet-foot">
          <RailButton icon="check" variant="primary" onclick={() => (sheet = "worker")}>Done</RailButton>
        </footer>
      {:else}
        <label>Name <input bind:value={workerDraft.name} /></label>
        <p class="meta">Slug for /run {slugify(workerDraft.name) || "worker"}</p>
        <div class="tabs">
          <button type="button" role="tab" class="tab" aria-selected={workerDraft.scope === "company"} onclick={() => (workerDraft.scope = "company" as WorkerScope)}>Company</button>
          <button type="button" role="tab" class="tab" aria-selected={workerDraft.scope === "personal"} onclick={() => (workerDraft.scope = "personal" as WorkerScope)}>Personal overlay</button>
        </div>
        <label>Description <textarea rows="3" bind:value={workerDraft.description}></textarea></label>
        <RailButton icon="plus" onclick={() => (sheet = "picker")}>Pick skills ({workerDraft.skills.length})</RailButton>
        <label>Knowledge paths <textarea rows="3" bind:value={workerDraft.knowledge}></textarea></label>
        <footer class="sheet-foot">
          <span class="meta">Writes worker.yaml and opens it in Claude Code</span>
          <RailButton icon="x" onclick={() => (sheet = null)}>Cancel</RailButton>
          <RailButton icon="check" variant="primary" data-testid="create-worker" onclick={submitWorker}>Create worker</RailButton>
        </footer>
      {/if}
    </div>
  {/if}

  {#if shareOpen && selectedSkill}
    <div class="sheet share" role="dialog" aria-label="Share" data-testid="share-sheet" use:dismissable={{ onclose: () => (shareOpen = false), outside: true }}>
      <header class="sheet-head"><h2>Share</h2><button type="button" class="icon-btn" aria-label="Close" onclick={() => (shareOpen = false)}>✕</button></header>
      <p class="path">{selectedSkill.path}</p>
      <p class="meta">Grant level is read or write. The vault share sheet sends the grant.</p>
      <div class="tabs" role="group" aria-label="Grant level">
        <button type="button" role="radio" class="tab" aria-checked="true">Read</button>
        <button type="button" role="radio" class="tab" aria-checked="false">Write</button>
      </div>
      <footer class="sheet-foot">
        <RailButton icon="copy" onclick={() => copyPath(selectedSkill.path)}>Copy path</RailButton>
        <RailButton icon="folder" variant="primary" onclick={() => { shareOpen = false; onopenpage?.("vault"); }}>Open vault</RailButton>
      </footer>
    </div>
  {/if}
</section>

<style>
  .brain {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--v4-ground);
    color: var(--t1, var(--v4-text-1));
    font-family: var(--font-sans);
    font-size: 13px;
  }
  .toolbar, .filters, .actions, .chips, .tabs, .sheet-head, .sheet-foot, .detail-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .toolbar {
    min-height: 52px;
    box-sizing: border-box;
    padding: 0 20px;
    border-bottom: 1px solid var(--line, var(--v4-rowline));
  }
  h1, h2 { margin: 0; font-weight: 500; }
  h1 { font-size: var(--type-title, 20px); line-height: var(--type-title-line, 1.25); }
  h2 { font-size: 13px; }
  .grow { flex: 1; }
  .chip, .badge, .tab, .icon-btn, .search, .item, .opt {
    font: inherit;
    font-size: 13px;
    color: var(--t2, var(--v4-text-2));
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
  }
  .chip, .badge { padding: 0; }
  .badge.hard, .chip.hard { color: var(--t1, var(--v4-text-1)); }
  .tab { height: 26px; padding: 0 8px; cursor: pointer; }
  .tab[aria-selected="true"], .item[aria-current="true"], .opt[aria-checked="true"] {
    background: var(--sel, var(--v4-active-row));
    color: var(--t1, var(--v4-text-1));
  }
  .tab:hover, .icon-btn:hover, .item:hover { background: var(--hover, var(--v4-hover)); }
  .icon-btn { height: 26px; box-sizing: border-box; border-color: var(--line2, var(--v4-control-border)); background: var(--btn-bg, transparent); color: var(--t1, var(--v4-text-1)); padding: 0 10px; cursor: pointer; }
  .search {
    height: 28px;
    box-sizing: border-box;
    border-color: var(--line2, var(--v4-control-border));
    background: var(--btn-bg, transparent);
    padding: 0 8px;
    width: 200px;
  }
  .split { display: grid; grid-template-columns: minmax(280px, 1fr) 380px; flex: 1; min-height: 0; }
  .list, .detail { min-height: 0; overflow: auto; }
  .ktree { height: 100%; min-height: 240px; }
  .ktree[hidden] { display: none; }
  .list { padding: 12px 12px 24px; }
  .detail {
    border-left: 1px solid var(--line, var(--v4-rowline));
    padding: 24px 20px;
  }
  .item {
    display: grid;
    width: 100%;
    text-align: left;
    padding: 7px 8px;
    line-height: 17px;
    border-radius: 8px;
    gap: 2px;
    cursor: pointer;
  }
  .name { color: var(--t1, var(--v4-text-1)); }
  .meta, .path, .kind, .status, .empty {
    color: var(--t3, var(--v4-text-3));
    font-size: 13px;
  }
  .path { font-family: var(--font-mono); }
  .live { color: var(--t2, var(--v4-text-2)); }
  .live::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: var(--ok, var(--v4-ok)); vertical-align: 1px; }
  .muted .name { color: var(--t3, var(--v4-text-3)); }
  .sec {
    font-size: 13px;
    font-weight: 500;
    color: var(--t2, var(--v4-text-2));
    padding: 16px 8px 4px;
  }
  .body { white-space: pre-wrap; color: var(--t2, var(--v4-text-2)); line-height: 1.45; margin-top: 12px; }
  .gate { padding: 10px 12px; border-radius: 8px; background: var(--raised, var(--v4-control-faint)); color: var(--t2, var(--v4-text-2)); }
  .usage { padding: 12px 20px; overflow: auto; }
  .usage-grid { display: grid; grid-template-columns: minmax(0, 1fr) 80px 120px 64px 110px; gap: 12px; padding: 8px; }
  .note { margin: 4px 8px; color: var(--v4-text-2, inherit); }
  .link { background: none; border: 0; padding: 0; color: inherit; text-decoration: underline; cursor: pointer; font: inherit; min-height: 28px; }
  .skill-usage { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 12px; margin: 8px 0; }
  .skill-usage dt { color: var(--v4-text-2, inherit); }
  .skill-usage dd { margin: 0; }
  .head { color: var(--t3, var(--v4-text-3)); border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  .shimmer { padding: 20px; display: grid; gap: 8px; }
  .bar {
    height: 14px;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-hover), var(--v4-control-faint), var(--v4-hover));
    background-size: 200% 100%;
    animation: shine 1.2s linear infinite;
  }
  .bar.short { width: 40%; }
  .reading { margin: 4px 0 0; color: var(--t3, var(--v4-text-3)); }
  @media (prefers-reduced-motion: reduce) { .bar { animation: none; } }
  @keyframes shine { from { background-position: 100% 0; } to { background-position: -100% 0; } }
  .scrim { position: absolute; inset: 0; background: var(--v4-scrim, rgba(0, 0, 0, 0.35)); }
  .sheet {
    position: absolute;
    top: 48px;
    right: 24px;
    width: min(520px, calc(100% - 48px));
    max-height: calc(100% - 80px);
    overflow: auto;
    background: var(--overlay-bg);
    border: 1px solid var(--overlay-border);
    border-radius: 8px;
    box-shadow: var(--overlay-shadow);
    padding: 16px 20px;
    display: grid;
    gap: 10px;
    z-index: 2;
  }
  .sheet label { display: grid; gap: 4px; font-size: 13px; color: var(--t2, var(--v4-text-3)); }
  .sheet input, .sheet textarea {
    font: inherit;
    color: var(--v4-text-1);
    font-size: 13px;
    border: 1px solid var(--overlay-field-border);
    background: var(--overlay-field-bg);
    border-radius: 6px;
    padding: 4px 8px;
  }
  .opt { text-align: left; padding: 6px 8px; border-color: var(--line2, var(--v4-control-border)); }
  .brain { position: relative; }
  .load-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .load-error p { margin: 0; }
</style>
