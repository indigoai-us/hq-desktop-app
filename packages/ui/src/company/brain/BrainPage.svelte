<script lang="ts">
  import { dismissable } from "../../common/dismissable.js";
  /**
   * Company Brain (US-028): Knowledge, Policies, Skills, Workers.
   * First frame is the cache or a shimmer. Refresh runs after paint.
   * Heavy enough to stay behind a lazy door.
   */
  import type { FilesApi, LibraryApi, SettingsApi, ShellApi } from "@hq/platform";
  import { openAgentWorkflow } from "../agent-workflow.js";
  import { loadLibraryCompany } from "../../library/library.js";
  import type { DirEntry } from "../../files/file-tree.js";
  import ShowMoreRow from "../../shell/ShowMoreRow.svelte";
  import { pageRows } from "../../shell/list-paging.js";
  import "../../home/tokens.css";
  import "../../chat/chat-tokens.css";
  import {
    emptyBrainCache,
    filterKnowledge,
    filterPolicies,
    filterSkills,
    filterWorkers,
    groupPolicies,
    knowledgeFromFile,
    policyCreatePrompt,
    policyFromFile,
    readBrainCache,
    skillCreatePrompt,
    skillRowFromLibrary,
    skillRunPrompt,
    slugify,
    virtualWindow,
    workerCreatePrompt,
    workerRowFromLibrary,
    workerRunPrompt,
    writeBrainCache,
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
  } from "./brain-model.js";

  interface Props {
    page: BrainPageId;
    slug: string;
    files: FilesApi | null;
    library: LibraryApi | null;
    shell: ShellApi | null;
    settings: SettingsApi | null;
    onopenpage?: (rowId: string) => void;
  }

  let {
    page,
    slug,
    files,
    library,
    shell,
    settings,
    onopenpage,
  }: Props = $props();

  let cache = $state(emptyBrainCache());
  let phase = $state<"shimmer" | "ready">("shimmer");
  let status = $state("");
  let query = $state("");
  let lens = $state<"tree" | "fresh">("tree");
  let policyFilter = $state<PolicyFilter>("all");
  let skillFilter = $state<SkillFilter>("all");
  let skillTab = $state<"library" | "usage">("library");
  let usageRange = $state<"7d" | "30d" | "90d">("30d");
  let workerScope = $state<WorkerScopeFilter>("all");
  let workerFilter = $state<WorkerFilter>("active");
  // Every list shows all rows, in pages of 50 with a Show more row.
  let pages = $state(1);
  let scrollTop = $state(0);
  let selected = $state<string | null>(null);
  let sheet = $state<"policy" | "skill" | "worker" | "picker" | null>(null);
  let shareOpen = $state(false);

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
  const policyRows = $derived(filterPolicies(cache.policies, policyFilter, query));
  const skillRows = $derived(filterSkills(cache.skills, skillFilter, query));
  const workerRows = $derived(filterWorkers(cache.workers, workerScope, workerFilter, query));
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
  const selectedSkill = $derived(cache.skills.find((row) => row.path === selected) ?? cache.skills[0] ?? null);
  const selectedWorker = $derived(cache.workers.find((row) => row.path === selected) ?? cache.workers[0] ?? null);
  const selectedPolicy = $derived(cache.policies.find((row) => row.path === selected) ?? cache.policies[0] ?? null);
  const selectedFile = $derived(cache.knowledge.find((row) => row.path === selected) ?? cache.knowledge[0] ?? null);
  const title = $derived(page === "knowledge" ? "Knowledge" : page === "policies" ? "Policies" : page === "skills" ? "Skills" : "Workers");

  $effect(() => {
    const key = slug;
    const hit = readBrainCache(key);
    query = "";
    selected = null;
    pages = 1;
    sheet = null;
    if (hit) {
      cache = hit;
      phase = "ready";
    } else {
      cache = emptyBrainCache();
      phase = "shimmer";
    }
    let live = true;
    void refresh(key).then(() => {
      if (live) phase = "ready";
    });
    return () => {
      live = false;
    };
  });

  async function refresh(key: string): Promise<void> {
    const next = readBrainCache(key) ?? emptyBrainCache();
    if (files && key) {
      next.knowledge = await readKnowledge(files, `companies/${key}/knowledge`);
      next.policies = await readPolicies(files, `companies/${key}/policies`);
    }
    if (library && key) {
      const result = await loadLibraryCompany(library, key);
      if (result.ok) {
        next.skills = result.value.skills.map((skill) => skillRowFromLibrary(skill, key));
        next.workers = result.value.workers.map(workerRowFromLibrary);
      }
    }
    writeBrainCache(key, next);
    if (slug === key) cache = next;
  }

  async function readKnowledge(api: FilesApi, root: string): Promise<KnowledgeFile[]> {
    const paths = await collectFiles(api, root, 0);
    const out: KnowledgeFile[] = [];
    for (const path of paths) {
      const res = await api.getFileContent(path);
      const text = res.ok ? res.value : "";
      out.push(knowledgeFromFile(path, text));
    }
    return out;
  }

  async function readPolicies(api: FilesApi, root: string): Promise<PolicyDoc[]> {
    const paths = await collectFiles(api, root, 0);
    const out: PolicyDoc[] = [];
    for (const path of paths) {
      const res = await api.getFileContent(path);
      out.push(policyFromFile(path, res.ok ? res.value : ""));
    }
    return out;
  }

  async function collectFiles(api: FilesApi, root: string, depth: number): Promise<string[]> {
    if (depth > 4) return [];
    const res = await api.listDir(root);
    if (!res.ok || !Array.isArray(res.value)) return [];
    const entries = res.value as unknown as DirEntry[];
    const filesOut: string[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry.path !== "string") continue;
      if (entry.isDir) filesOut.push(...(await collectFiles(api, entry.path, depth + 1)));
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
    status = res.ok ? `Opened ${path}` : res.message ?? "Could not open the file.";
  }

  async function openInClaude(path: string): Promise<void> {
    if (!shell) return;
    const res = await shell.openFileInClaude(path);
    status = res.ok ? "Opened in Claude Code." : res.message ?? "Could not open Claude Code.";
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
      <span class="chip">{policyGroups.hard.length} hard · {policyGroups.soft.length} soft</span>
      <div class="tabs" role="tablist">
        {#each ["all", "hard", "soft"] as id (id)}
          <button type="button" role="tab" class="tab" aria-selected={policyFilter === id} onclick={() => (policyFilter = id as PolicyFilter)}>{id === "all" ? "All" : id === "hard" ? "Hard" : "Soft"}</button>
        {/each}
      </div>
    {:else if page === "skills"}
      <span class="chip">{cache.skills.length} skills</span>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab" aria-selected={skillTab === "library"} onclick={() => (skillTab = "library")}>Library</button>
        <button type="button" role="tab" class="tab" aria-selected={skillTab === "usage"} onclick={() => (skillTab = "usage")}>Usage</button>
      </div>
    {:else if page === "workers"}
      <span class="chip">{cache.workers.length} workers</span>
      <div class="tabs" role="tablist">
        {#each [["all", "All"], ["company", "Company"], ["personal", "Personal overlay"]] as [id, label] (id)}
          <button type="button" role="tab" class="tab" aria-selected={workerScope === id} onclick={() => (workerScope = id as WorkerScopeFilter)}>{label}</button>
        {/each}
      </div>
    {:else}
      <span class="chip">{cache.knowledge.length} files</span>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab" aria-selected={lens === "fresh"} onclick={() => (lens = "fresh")}>What's fresh</button>
        <button type="button" role="tab" class="tab" aria-selected={lens === "tree"} onclick={() => (lens = "tree")}>Browse tree</button>
      </div>
    {/if}
    <span class="grow"></span>
    <input class="search" type="search" placeholder={`Search ${title.toLowerCase()}`} bind:value={query} aria-label={`Search ${title}`} />
    {#if page === "knowledge" || page === "policies"}
      <button type="button" class="btn" onclick={() => onopenpage?.("vault")}>Vault</button>
    {/if}
    {#if page === "policies"}
      <button type="button" class="btn primary" onclick={() => (sheet = "policy")}>New policy</button>
    {:else if page === "skills"}
      <button type="button" class="btn primary" onclick={() => (sheet = "skill")}>New skill</button>
    {:else if page === "workers"}
      <button type="button" class="btn primary" onclick={() => (sheet = "worker")}>New worker</button>
    {/if}
  </header>

  {#if phase === "shimmer" && activeList.length === 0}
    <div class="shimmer" data-testid="brain-shimmer" aria-busy="true">
      <div class="bar"></div><div class="bar"></div><div class="bar short"></div>
    </div>
  {:else if page === "skills" && skillTab === "usage"}
    <div class="usage" data-testid="skills-usage">
      <div class="filters">
        {#each ["7d", "30d", "90d"] as range (range)}
          <button type="button" role="tab" class="tab" aria-selected={usageRange === range} onclick={() => (usageRange = range as typeof usageRange)}>{range}</button>
        {/each}
        <span class="grow"></span>
        <span class="meta">Sort · runs</span>
      </div>
      <div class="head usage-grid"><span>Skill</span><span>Runs</span><span>Last run</span></div>
      {#each pageRows(skillRows, pages).rows as row (row.path)}
        <div class="row usage-grid">
          <span class="name">{row.name}</span>
          <span class="meta">{row.runs}</span>
          <span class="meta">{row.lastRun || "No runs in this window"}</span>
        </div>
      {/each}
      {#if skillRows.length === 0}
        <p class="empty">No skill runs in this window yet. Usage fills in from the library listing.</p>
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
        {:else if page === "knowledge" && lens === "fresh"}
          <div class="sec">Recent</div>
          {#each pageRows(knowledgeRows, pages).rows as row (row.path)}
            <button type="button" class="item" aria-current={selectedFile?.path === row.path} onclick={() => (selected = row.path)}>
              <span class="name">{row.title}</span>
              {#if row.mark}<span class="badge" class:hard={row.mark === "new"}>{row.mark}</span>{/if}
              <span class="meta">{row.path}</span>
            </button>
          {/each}
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
              <button type="button" class="item" class:muted={worker.parked} aria-current={selectedWorker?.path === worker.path} onclick={() => (selected = worker.path)}>
                <span class="name">{worker.name}</span>
                <span class="meta">{worker.description}</span>
                <span class="meta" class:live={worker.live}>{worker.live ? "Live" : worker.lastRun || worker.scope}</span>
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
        {#if page !== "policies" && listPage.remaining > 0}
          <ShowMoreRow shown={listPage.rows.length} total={listPage.total} next={listPage.next} noun={title.toLowerCase()} testid="brain-show-more" onmore={() => (pages += 1)} />
        {/if}
        {#if activeList.length === 0}
          <p class="empty">Nothing in this {title.toLowerCase()} listing yet.</p>
        {/if}
      </div>

      <aside class="detail" data-testid="brain-detail">
        {#if page === "skills" && selectedSkill}
          <p class="kind">Skill</p>
          <h2>{selectedSkill.name}</h2>
          <p class="path">{selectedSkill.path}</p>
          <p>{selectedSkill.description}</p>
          <div class="actions">
            <button type="button" class="btn primary" data-testid="skill-run" onclick={() => runPrompt(skillRunPrompt(selectedSkill.name), selectedSkill.name)}>Run</button>
            <button type="button" class="btn" onclick={() => openInClaude(selectedSkill.path)}>Open in Claude Code</button>
            <button type="button" class="btn" onclick={() => (shareOpen = true)}>Share</button>
          </div>
        {:else if page === "workers" && selectedWorker}
          <div class="detail-head">
            <h2>{selectedWorker.name}</h2>
            <button type="button" class="btn" onclick={() => (sheet = "picker")}>⋯</button>
            <button type="button" class="btn" onclick={() => (selected = null)} aria-label="Close">✕</button>
          </div>
          <p class="kind">{selectedWorker.scope}</p>
          <p class="path">{selectedWorker.path}</p>
          <p>{selectedWorker.description}</p>
          <div class="actions">
            <button type="button" class="btn primary" data-testid="worker-run" onclick={() => runPrompt(workerRunPrompt(selectedWorker.id), selectedWorker.name)}>Run</button>
            <button type="button" class="btn" onclick={() => openInClaude(selectedWorker.path)}>Open in Claude Code</button>
            <button type="button" class="btn" onclick={() => openPath(selectedWorker.path)}>Edit worker.yaml</button>
          </div>
          {#each selectedWorker.skills as name (name)}
            <div class="sub">
              <span>{name}</span>
              <button type="button" class="btn" onclick={() => runPrompt(skillRunPrompt(name), name)}>Run</button>
            </div>
          {/each}
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
            <button type="button" class="btn" onclick={() => openPath(selectedPolicy.path)}>Open</button>
            <button type="button" class="btn" onclick={() => copyPath(selectedPolicy.path)}>Copy path</button>
          </div>
          <div class="body">{selectedPolicy.body}</div>
        {:else if page === "knowledge" && selectedFile}
          <p class="path">{selectedFile.path}</p>
          <h2>{selectedFile.title}</h2>
          <div class="actions">
            <button type="button" class="btn" onclick={() => openPath(selectedFile.path)}>Open</button>
            <button type="button" class="btn" onclick={() => copyPath(selectedFile.path)}>Copy path</button>
          </div>
          <div class="body">{selectedFile.body}</div>
        {:else}
          <p class="empty">Select a row.</p>
        {/if}
      </aside>
    </div>
  {/if}

  {#if status}<p class="status" data-testid="brain-status">{status}</p>{/if}

  {#if sheet}
    <div class="scrim" role="presentation" onclick={() => (sheet = null)}></div>
    <div class="sheet" role="dialog" aria-label={sheet === "policy" ? "New policy" : sheet === "skill" ? "New skill" : sheet === "picker" ? "Skill picker" : "New worker"} data-testid="brain-sheet" use:dismissable={{ onclose: () => (sheet = null) }}>
      <header class="sheet-head">
        <h2>{sheet === "policy" ? "New policy" : sheet === "skill" ? "New skill" : sheet === "picker" ? "Skills" : "New worker"}</h2>
        <button type="button" class="btn" aria-label="Close" onclick={() => (sheet = null)}>✕</button>
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
          <button type="button" class="btn" onclick={() => (sheet = null)}>Cancel</button>
          <button type="button" class="btn primary" data-testid="create-policy" onclick={submitPolicy}>Create policy</button>
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
          <button type="button" class="btn" onclick={() => (sheet = null)}>Cancel</button>
          <button type="button" class="btn primary" data-testid="create-skill" onclick={submitSkill}>Create skill</button>
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
          <button type="button" class="btn primary" onclick={() => (sheet = "worker")}>Done</button>
        </footer>
      {:else}
        <label>Name <input bind:value={workerDraft.name} /></label>
        <p class="meta">Slug for /run {slugify(workerDraft.name) || "worker"}</p>
        <div class="tabs">
          <button type="button" role="tab" class="tab" aria-selected={workerDraft.scope === "company"} onclick={() => (workerDraft.scope = "company" as WorkerScope)}>Company</button>
          <button type="button" role="tab" class="tab" aria-selected={workerDraft.scope === "personal"} onclick={() => (workerDraft.scope = "personal" as WorkerScope)}>Personal overlay</button>
        </div>
        <label>Description <textarea rows="3" bind:value={workerDraft.description}></textarea></label>
        <button type="button" class="btn" onclick={() => (sheet = "picker")}>Pick skills ({workerDraft.skills.length})</button>
        <label>Knowledge paths <textarea rows="3" bind:value={workerDraft.knowledge}></textarea></label>
        <footer class="sheet-foot">
          <span class="meta">Writes worker.yaml and opens it in Claude Code</span>
          <button type="button" class="btn" onclick={() => (sheet = null)}>Cancel</button>
          <button type="button" class="btn primary" data-testid="create-worker" onclick={submitWorker}>Create worker</button>
        </footer>
      {/if}
    </div>
  {/if}

  {#if shareOpen && selectedSkill}
    <div class="sheet share" role="dialog" aria-label="Share" data-testid="share-sheet" use:dismissable={{ onclose: () => (shareOpen = false), outside: true }}>
      <header class="sheet-head"><h2>Share</h2><button type="button" class="btn" aria-label="Close" onclick={() => (shareOpen = false)}>✕</button></header>
      <p class="path">{selectedSkill.path}</p>
      <p class="meta">Grant level is read or write. The vault share sheet sends the grant.</p>
      <div class="tabs" role="group" aria-label="Grant level">
        <button type="button" role="radio" class="tab" aria-checked="true">Read</button>
        <button type="button" role="radio" class="tab" aria-checked="false">Write</button>
      </div>
      <footer class="sheet-foot">
        <button type="button" class="btn" onclick={() => copyPath(selectedSkill.path)}>Copy path</button>
        <button type="button" class="btn primary" onclick={() => { shareOpen = false; onopenpage?.("vault"); }}>Open vault</button>
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
    color: var(--v4-text-1);
    font-family: var(--font-sans);
  }
  .toolbar, .filters, .actions, .chips, .tabs, .sheet-head, .sheet-foot, .detail-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .toolbar {
    padding: 12px 20px;
    border-bottom: 1px solid var(--v4-rowline);
  }
  h1, h2 { margin: 0; font-weight: 600; }
  h1 { font-size: var(--type-section); }
  h2 { font-size: var(--type-secondary); }
  .grow { flex: 1; }
  .chip, .badge, .tab, .btn, .search, .item, .opt {
    font: inherit;
    color: var(--v4-text-2);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
  }
  .chip, .badge {
    font-size: var(--type-metadata);
    padding: 0 6px;
    border-color: var(--v4-control-border);
  }
  .badge.hard, .chip.hard { color: var(--v4-text-1); border-color: var(--v4-text-3); }
  .tab[aria-selected="true"], .item[aria-current="true"], .opt[aria-checked="true"] {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }
  .tab:hover, .btn:hover, .item:hover { background: var(--v4-hover); }
  .btn { border-color: var(--v4-control-border); padding: 4px 10px; }
  .btn.primary { background: var(--v4-active-row); color: var(--v4-text-1); }
  .search {
    border-color: var(--v4-control-border);
    padding: 4px 8px;
    width: 200px;
  }
  .split { display: grid; grid-template-columns: minmax(280px, 1fr) 380px; flex: 1; min-height: 0; }
  .list, .detail { min-height: 0; overflow: auto; }
  .list { padding: 12px 20px 24px; }
  .detail {
    border-left: 1px solid var(--v4-rowline);
    background: var(--v4-secondary-sidebar);
    padding: 16px;
  }
  .item {
    display: grid;
    width: 100%;
    text-align: left;
    padding: 8px;
    gap: 2px;
  }
  .name { color: var(--v4-text-1); }
  .meta, .path, .kind, .status, .empty {
    color: var(--v4-text-3);
    font-size: var(--type-metadata);
  }
  .path, .kind { font-family: var(--font-mono); }
  .live { color: var(--v4-ok); }
  .muted .name { color: var(--v4-text-3); }
  .sec {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--v4-text-3);
    padding: 10px 8px 4px;
  }
  .body { white-space: pre-wrap; color: var(--v4-text-2); line-height: 1.5; margin-top: 12px; }
  .gate { border-left: 2px solid var(--v4-hairline); padding-left: 10px; color: var(--v4-text-2); }
  .usage { padding: 12px 20px; overflow: auto; }
  .usage-grid { display: grid; grid-template-columns: 1fr 80px 180px; gap: 12px; padding: 8px; }
  .head { color: var(--v4-text-3); border-bottom: 1px solid var(--v4-rowline); }
  .shimmer { padding: 20px; display: grid; gap: 8px; }
  .bar {
    height: 14px;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-hover), var(--v4-control-faint), var(--v4-hover));
    background-size: 200% 100%;
    animation: shine 1.2s linear infinite;
  }
  .bar.short { width: 40%; }
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
    background: var(--v4-ground);
    border: 1px solid var(--v4-rowline);
    border-radius: 10px;
    padding: 16px;
    display: grid;
    gap: 10px;
    z-index: 2;
  }
  .sheet label { display: grid; gap: 4px; font-size: var(--type-metadata); color: var(--v4-text-3); }
  .sheet input, .sheet textarea {
    font: inherit;
    color: var(--v4-text-1);
    background: transparent;
    border: 1px solid var(--v4-control-border);
    border-radius: 6px;
    padding: 6px 8px;
  }
  .opt { text-align: left; padding: 6px; border-color: var(--v4-control-border); }
  .sub { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--v4-rowline); }
  .brain { position: relative; }
</style>
