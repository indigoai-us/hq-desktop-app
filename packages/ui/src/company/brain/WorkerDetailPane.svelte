<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  /**
   * OWNER-R12: the worker pane. The header paints at once from the registry
   * row; details, skills, files and policies each load on their own, with
   * their own failed state and Try again. Files use the Files pane's tree
   * (and its deny filter); a selected file opens in the Files preview.
   */
  import type { FilesApi, PlatformAdapter } from "@hq/platform";
  import ReadLoader from "../../common/ReadLoader.svelte";
  import RailButton from "../../common/button/RailButton.svelte";
  import VaultTree from "../../files/explorer/VaultTree.svelte";
  import FilePreviewPane from "../../files/FilePreviewPane.svelte";
  import type { Vault } from "../../files/explorer/vault-model.js";
  import type { DirEntry } from "../../files/file-tree.js";
  import { isPolicyFileName, policyFromFile, type PolicyDoc, type WorkerRow } from "./brain-model.js";
  import {
    resolveSkillFiles,
    workerSkillRunPrompt,
    workerStatusLabel,
    workerYamlDetail,
    type WorkerYamlDetail,
  } from "./worker-detail.js";

  interface Props {
    worker: WorkerRow;
    slug: string;
    files: FilesApi | null;
    adapter?: PlatformAdapter | null;
    onrun: (prompt: string, label: string) => void;
    onopenclaude: (path: string) => void;
    onedit: (path: string) => void;
    onclose: () => void;
    onmore?: () => void;
  }

  let { worker, slug, files, adapter = null, onrun, onopenclaude, onedit, onclose, onmore }: Props = $props();

  type Read<T> = { state: "loading" | "ok" | "failed"; data: T | null };

  const dir = $derived(worker.path.replace(/\/+$/, ""));
  let detail = $state<Read<WorkerYamlDetail>>({ state: "loading", data: null });
  let skillPaths = $state<string[]>([]);
  let policies = $state<Read<PolicyDoc[]>>({ state: "loading", data: null });
  let detailAttempt = $state(0);
  let policyAttempt = $state(0);
  let treeReload = $state(0);
  let viewing = $state<string | null>(null);

  const scopeLabel = $derived(worker.scope === "company" ? "Company" : worker.scope === "root" ? "HQ" : "Personal overlay");
  const statusLabel = $derived(worker.live ? "Live" : workerStatusLabel(worker.status));
  const skills = $derived(detail.data ? resolveSkillFiles(detail.data.skills, skillPaths) : []);
  const treeVault = $derived<Vault>({ id: `worker:${dir}`, kind: "company", label: worker.name, root: dir, slug });

  async function listDir(path: string) {
    if (!files) return { ok: false as const, message: "files unavailable" };
    const res = await files.listDir(path);
    return res.ok ? { ok: true as const, value: res.value as unknown[] } : { ok: false as const, message: res.message };
  }

  async function collectSkillPaths(api: FilesApi, root: string): Promise<string[]> {
    const res = await api.listDir(`${root}/skills`);
    if (!res.ok || !Array.isArray(res.value)) return [];
    const out: string[] = [];
    for (const raw of res.value as unknown as DirEntry[]) {
      if (!raw || typeof raw.path !== "string") continue;
      if (!raw.isDir) out.push(raw.path);
      else out.push(`${raw.path}/SKILL.md`);
    }
    return out;
  }

  $effect(() => {
    const root = dir;
    void detailAttempt;
    viewing = null;
    detail = { state: "loading", data: null };
    skillPaths = [];
    let live = true;
    void (async () => {
      if (!files) {
        if (live) detail = { state: "failed", data: null };
        return;
      }
      try {
        const res = await files.getFileContent(`${root}/worker.yaml`);
        if (!res.ok) throw new Error(res.message ?? res.reason);
        const parsed = workerYamlDetail(res.value, root);
        const paths = parsed.skills.some((s) => !s.file) ? await collectSkillPaths(files, root) : [];
        if (!live) return;
        skillPaths = paths;
        detail = { state: "ok", data: parsed };
      } catch (err) {
        console.warn("[workers] worker.yaml read failed", root, err);
        if (live) detail = { state: "failed", data: null };
      }
    })();
    return () => {
      live = false;
    };
  });

  $effect(() => {
    const root = dir;
    void policyAttempt;
    policies = { state: "loading", data: null };
    let live = true;
    void (async () => {
      if (!files) {
        if (live) policies = { state: "ok", data: [] };
        return;
      }
      try {
        const res = await files.listDir(`${root}/policies`);
        // No policies folder: the section is left out.
        if (!res.ok || !Array.isArray(res.value)) {
          if (live) policies = { state: "ok", data: [] };
          return;
        }
        const entries = (res.value as unknown as DirEntry[]).filter(
          (e) => e && typeof e.path === "string" && !e.isDir && e.name.endsWith(".md") && isPolicyFileName(e.name),
        );
        const docs: PolicyDoc[] = [];
        for (const entry of entries) {
          const body = await files.getFileContent(entry.path);
          if (!body.ok) throw new Error(body.message ?? body.reason);
          docs.push(policyFromFile(entry.path, body.value));
        }
        if (live) policies = { state: "ok", data: docs };
      } catch (err) {
        console.warn("[workers] worker policies read failed", root, err);
        if (live) policies = { state: "failed", data: null };
      }
    })();
    return () => {
      live = false;
    };
  });
</script>

<div class="wd" data-testid="worker-detail">
  <div class="detail-head">
    <h2>{worker.name}</h2>
    {#if onmore}<button type="button" class="icon-btn" onclick={onmore} aria-label="More">⋯</button>{/if}
    <button type="button" class="icon-btn" onclick={onclose} aria-label="Close">✕</button>
  </div>
  <p class="labels">
    <span data-testid="worker-scope">{scopeLabel}</span>
    <span class:live={worker.live} data-testid="worker-status">{statusLabel}</span>
  </p>
  <p class="path">{worker.path}</p>
  {#if worker.description}<p class="desc">{worker.description}</p>{/if}
  <div class="actions">
    <RailButton icon="play" variant="primary" data-testid="worker-run" onclick={() => onrun(`/run ${worker.id}`, worker.name)}>Run</RailButton>
    <RailButton icon="claude-code" onclick={() => onopenclaude(worker.path)}>Open in Claude Code</RailButton>
    <RailButton icon="pencil" onclick={() => onedit(worker.path)}>Edit worker.yaml</RailButton>
  </div>

  {#if viewing && adapter}
    <section class="sec viewer" data-testid="worker-file-viewer">
      <div class="sec-head">
        <h3>File</h3>
        <button type="button" class="link" data-testid="worker-file-back" onclick={() => (viewing = null)}><RailIcon name="arrow-left" />Back to worker</button>
      </div>
      <div class="viewer-body">
        <FilePreviewPane {adapter} path={viewing} scopeRoot={dir} scopeLabel="worker" onopenpath={(p) => (viewing = p)} />
      </div>
    </section>
  {/if}

  <section class="sec" data-testid="worker-details" hidden={!!viewing}>
    <h3>Details</h3>
    {#if detail.state === "loading"}
      <ReadLoader testid="worker-details-loader" onretry={() => (detailAttempt += 1)} />
    {:else if detail.state === "failed"}
      <div class="failed" role="alert" data-testid="worker-details-failed">
        <p>The worker's details could not be read.</p>
        <RailButton icon="refresh" onclick={() => (detailAttempt += 1)}>Try again</RailButton>
      </div>
    {:else if detail.data}
      <dl class="rows">
        {#each detail.data.rows as row (row.label)}
          <div><dt>{row.label}</dt><dd>{row.value}</dd></div>
        {/each}
      </dl>
      {#each detail.data.asksBefore as line, i (i)}
        <p class="ask" data-testid="worker-asks">{line}</p>
      {/each}
      {#if detail.data.contextFiles.length}
        <p class="sub-h">Context files</p>
        <ul class="files">
          {#each detail.data.contextFiles as path (path)}<li class="path">{path}</li>{/each}
        </ul>
      {/if}
      {#if detail.data.knowledgeFiles.length}
        <p class="sub-h">Knowledge files</p>
        <ul class="files">
          {#each detail.data.knowledgeFiles as path (path)}<li class="path">{path}</li>{/each}
        </ul>
      {/if}
    {/if}
  </section>

  <section class="sec" data-testid="worker-skills" hidden={!!viewing}>
    <h3>Skills{#if detail.state === "ok"} <span class="count">{skills.length}</span>{/if}</h3>
    {#if detail.state === "loading"}
      <ReadLoader testid="worker-skills-loader" onretry={() => (detailAttempt += 1)} />
    {:else if detail.state === "failed"}
      <div class="failed" role="alert" data-testid="worker-skills-failed">
        <p>The worker's skills could not be read.</p>
        <RailButton icon="refresh" onclick={() => (detailAttempt += 1)}>Try again</RailButton>
      </div>
    {:else if skills.length === 0}
      <p class="muted" data-testid="worker-skills-none">This worker has no skills listed in worker.yaml.</p>
    {:else}
      {#each skills as skill (skill.name)}
        <div class="skill" data-testid="worker-skill">
          <div class="skill-text">
            <span class="name">{skill.name}</span>
            {#if skill.description}<span class="muted">{skill.description}</span>{/if}
            {#if skill.file}
              <button type="button" class="link path" data-testid="worker-skill-file" onclick={() => (viewing = skill.file)}>{skill.file.slice(dir.length + 1)}</button>
            {/if}
          </div>
          <RailButton icon="play" data-testid="worker-skill-run" onclick={() => onrun(workerSkillRunPrompt(worker.id, skill.name), skill.name)}>Run</RailButton>
        </div>
      {/each}
    {/if}
  </section>

  <section class="sec" data-testid="worker-files" hidden={!!viewing}>
    <h3>Files</h3>
    {#if files}
      <div class="tree">
        <VaultTree
          vault={treeVault}
          {listDir}
          activePath={viewing}
          showSystem={false}
          reloadKey={treeReload}
          onopen={(path) => (viewing = path)}
        />
      </div>
    {:else}
      <p class="muted">Files open in the desktop app, which reads your local HQ folder.</p>
    {/if}
  </section>

  {#if policies.state === "failed"}
    <section class="sec" data-testid="worker-policies" hidden={!!viewing}>
      <h3>Policies</h3>
      <div class="failed" role="alert" data-testid="worker-policies-failed">
        <p>The worker's policies could not be read.</p>
        <RailButton icon="refresh" onclick={() => (policyAttempt += 1)}>Try again</RailButton>
      </div>
    </section>
  {:else if policies.state === "ok" && policies.data && policies.data.length > 0}
    <section class="sec" data-testid="worker-policies" hidden={!!viewing}>
      <h3>Policies <span class="count">{policies.data.length}</span></h3>
      {#each policies.data as policy (policy.path)}
        <button type="button" class="policy" data-testid="worker-policy" onclick={() => (viewing = policy.path)}>
          <span class="name">{policy.title}</span>
          <span class="muted">{policy.enforcement === "hard" ? "Hard" : "Soft"}</span>
        </button>
      {/each}
    </section>
  {/if}
</div>

<style>
  .wd { display: grid; gap: 10px; min-width: 0; overflow-wrap: anywhere; }
  .detail-head, .actions, .sec-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .detail-head h2 { flex: 1; min-width: 0; margin: 0; font-size: 13px; font-weight: 500; }
  .icon-btn { font: inherit; font-size: 13px; height: 26px; padding: 0 10px; border: 1px solid var(--line2, var(--v4-control-border)); border-radius: 6px; background: transparent; color: var(--t1, var(--v4-text-1)); cursor: pointer; }
  .labels { display: flex; gap: 12px; margin: 0; color: var(--t2, var(--v4-text-2)); }
  .live::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: var(--ok, var(--v4-ok)); vertical-align: 1px; }
  .path { font-family: var(--font-mono); color: var(--t3, var(--v4-text-3)); margin: 0; }
  .desc { margin: 0; color: var(--t2, var(--v4-text-2)); line-height: 1.45; }
  .sec { display: grid; gap: 6px; padding-top: 12px; border-top: 1px solid var(--line, var(--v4-rowline)); min-width: 0; }
  .sec[hidden] { display: none; }
  h3 { margin: 0; font-size: 13px; font-weight: 500; color: var(--t1, var(--v4-text-1)); }
  .sec-head h3 { flex: 1; }
  .count, .muted { color: var(--t3, var(--v4-text-3)); font-weight: 400; }
  .rows { display: grid; gap: 4px; margin: 0; }
  .rows div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 8px; }
  .rows dt { color: var(--t3, var(--v4-text-3)); }
  .rows dd { margin: 0; color: var(--t1, var(--v4-text-1)); }
  .ask { margin: 0; color: var(--t2, var(--v4-text-2)); }
  .sub-h { margin: 6px 0 0; color: var(--t2, var(--v4-text-2)); }
  .files { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; }
  .skill { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--v4-rowline); }
  .skill-text { display: grid; gap: 2px; flex: 1; min-width: 0; }
  .name { color: var(--t1, var(--v4-text-1)); }
  .link { background: none; border: 0; padding: 0; color: inherit; text-align: left; text-decoration: underline; cursor: pointer; font: inherit; }
  .link.path { font-family: var(--font-mono); color: var(--t3, var(--v4-text-3)); }
  .tree { height: 280px; min-width: 0; border: 1px solid var(--line, var(--v4-rowline)); border-radius: 6px; overflow: hidden; }
  .policy { display: flex; justify-content: space-between; gap: 8px; width: 100%; padding: 6px 0; border: 0; border-bottom: 1px solid var(--v4-rowline); background: transparent; font: inherit; text-align: left; cursor: pointer; }
  .viewer-body { display: flex; min-height: 360px; min-width: 0; }
  .failed { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .failed p { margin: 0; }
</style>
