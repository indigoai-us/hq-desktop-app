<script lang="ts">
  /**
   * Company Outpost list, detail, and add flow.
   * Owners and admins manage. Members see the same list and detail, read only.
   * Jobs link to the stable route outpost-jobs. That screen is a stub until
   * the jobs lane lands. Sign-in again never opens a browser.
   */
  import { onMount } from "svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import {
    OUTPOST_JOBS_ROUTE,
    PREP_STEPS,
    blockedNote,
    canManageRole,
    healthLabel,
    jobHealthSummary,
    lastSeenLabel,
    listAfterProvision,
    UNAVAILABLE_COPY,
    needsAttentionNote,
    renameError,
    stateLabel,
    whenLabel,
    type CompanyOutpostDetail,
    type CompanyOutpostJob,
    type CompanyOutpostListItem,
    type CompanyOutpostRole,
    type ProvisionResult,
  } from "./company-outpost-model.js";
  import type { CompanyOutpostClient } from "./company-outpost-client.js";

  interface Props {
    companyUid: string;
    role: CompanyOutpostRole;
    client: CompanyOutpostClient;
    now?: number;
    pollMs?: number | null;
    initialScreen?: "list" | "add" | "confirm" | "detail" | "remove" | "preparing" | "unavailable" | "job";
    initialOutpostId?: string;
    initialJobId?: string;
    initialNotice?: string;
    onOpenJob?: (target: { route: typeof OUTPOST_JOBS_ROUTE; companyUid: string; outpostId: string; jobId: string }) => void;
  }

  let {
    companyUid,
    role,
    client,
    now = Date.now(),
    pollMs = null,
    initialScreen = "list",
    initialOutpostId = "",
    initialJobId = "",
    initialNotice = "",
    onOpenJob,
  }: Props = $props();

  const manage = $derived(canManageRole(role));

  // Preview screens pass the first frame. These are not live bindings.
  // svelte-ignore state_referenced_locally
  let screen = $state(initialScreen);
  let items = $state<CompanyOutpostListItem[]>([]);
  let cap = $state(5);
  // svelte-ignore state_referenced_locally
  let selectedId = $state(initialOutpostId);
  let detail = $state<CompanyOutpostDetail | null>(null);
  let selectedJob = $state<CompanyOutpostJob | null>(null);
  // svelte-ignore state_referenced_locally
  let notice = $state(initialNotice);
  let loadMessage = $state("");
  // svelte-ignore state_referenced_locally
  let ready = $state(role === "guest");
  let previewName = $state("");
  let renaming = $state(false);
  let renameName = $state("");
  let renameMessage = $state("");
  let removeTyped = $state("");
  let busy = $state(false);
  let attemptId = $state("");
  let prepStep = $state(0);

  const atCap = $derived(manage && items.length >= cap);
  const selected = $derived(items.find((item) => item.id === selectedId) ?? null);

  function applyList(next: CompanyOutpostListItem[], nextCap: number) {
    items = next;
    cap = nextCap;
  }

  async function refresh() {
    const result = await client.list();
    if (!result.ok) {
      loadMessage = role === "member" && result.code.includes("403")
        ? "Outposts are not available to members yet."
        : result.message;
      return false;
    }
    loadMessage = "";
    applyList(result.items, result.cap);
    return true;
  }

  async function openDetail(id: string) {
    selectedId = id;
    screen = "detail";
    renaming = false;
    const result = await client.detail(id);
    if (result.ok) detail = result.outpost;
  }

  function applyProvision(result: ProvisionResult) {
    items = listAfterProvision(items, result);
    if (result.status === "pending") {
      attemptId = result.attemptId;
      prepStep = 0;
      screen = "preparing";
      notice = "";
      return;
    }
    attemptId = "";
    if (result.status === "success") {
      notice = "";
      void refresh().then(() => openDetail(result.outpost.id));
      return;
    }
    if (result.status === "already_exists") {
      notice = "An Outpost already exists for this company.";
      screen = "confirm";
      return;
    }
    if (result.status === "unavailable") {
      notice = "";
      screen = "unavailable";
      return;
    }
    if (result.status === "forbidden") {
      notice = "Only company owners and admins can manage Outposts.";
      screen = "list";
      return;
    }
    notice = result.message;
    screen = "confirm";
  }

  function beginAdd() {
    if (!manage || atCap) return;
    notice = "";
    previewName = client.previewAdd(items.map((item) => item.name)).name;
    screen = "add";
  }

  function continueAdd() {
    if (!manage) return;
    previewName = client.previewAdd(items.map((item) => item.name)).name;
    screen = "confirm";
  }

  async function createOutpost() {
    if (!manage || busy) return;
    busy = true;
    try {
      applyProvision(await client.provision());
    } finally {
      busy = false;
    }
  }

  async function checkNow() {
    if (attemptId) {
      if (prepStep < PREP_STEPS.length - 1) prepStep += 1;
      applyProvision(await client.pollProvision(attemptId));
      return;
    }
    if (selectedId) await openDetail(selectedId);
  }

  async function saveName() {
    renameMessage = renameError(renameName);
    if (renameMessage || !selectedId) return;
    const result = await client.rename(selectedId, renameName);
    if (!result.ok) {
      renameMessage = result.message;
      return;
    }
    notice = result.message;
    renaming = false;
    await refresh();
    if (detail && detail.id === selectedId) detail = { ...detail, name: renameName.trim() };
  }

  async function confirmRemove() {
    if (!selected || removeTyped.trim() !== selected.name || busy) return;
    busy = true;
    try {
      const result = await client.remove(selected.id);
      notice = result.message;
      if (!result.ok) return;
      selectedId = "";
      detail = null;
      screen = "list";
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function signInAgain() {
    if (!selectedId || !manage) return;
    const result = await client.signInAgain(selectedId);
    notice = result.message;
  }

  function openJob(job: CompanyOutpostJob) {
    selectedJob = job;
    screen = "job";
    if (selectedId) onOpenJob?.({ route: OUTPOST_JOBS_ROUTE, companyUid, outpostId: selectedId, jobId: job.id });
  }

  onMount(() => {
    if (role === "guest") {
      ready = true;
      return;
    }
    let live = true;
    void (async () => {
      const ok = await refresh();
      if (!live) return;
      if (ok && initialOutpostId) {
        const result = await client.detail(initialOutpostId);
        if (live && result.ok) {
          detail = result.outpost;
          selectedJob = result.outpost.jobs.find((job) => job.id === initialJobId) ?? result.outpost.jobs[0] ?? null;
        }
      }
      if (live && (screen === "add" || screen === "confirm")) {
        previewName = client.previewAdd(items.map((item) => item.name)).name;
      }
      if (live) ready = true;
    })();
    return () => {
      live = false;
    };
  });

  $effect(() => {
    if (pollMs == null || screen !== "preparing" || !attemptId) return;
    const timer = setInterval(() => {
      void checkNow();
    }, pollMs);
    return () => clearInterval(timer);
  });
</script>

<section
  class="co"
  data-testid="company-outpost"
  data-ready={ready ? "true" : "false"}
  data-screen={screen}
  data-role={role}
  data-manage={manage ? "true" : "false"}
>
  {#if role === "guest"}
    <header class="co-head"><h1>You do not have access</h1><p>Only company members can view Outposts.</p></header>
    <div class="co-card"><p>Ask a company owner to update your access.</p></div>
  {:else if !ready}
    <ReadLoader testid="company-outpost-loading" onretry={() => { void refresh().then(() => { ready = true; }); }} />
  {:else if loadMessage && screen === "list"}
    <header class="co-head"><h1>Outposts</h1></header>
    <div class="co-note" role="alert" data-testid="company-outpost-error">{loadMessage}</div>
    <RailButton icon="refresh" data-testid="company-outpost-retry" onclick={() => { loadMessage = ""; ready = false; void refresh().then(() => { ready = true; }); }}>Retry</RailButton>
  {:else if screen === "list"}
    <header class="co-head">
      <div>
        <h1>Outposts</h1>
        <p>{manage
          ? "Always-on machines that run your company's scheduled jobs. Open an Outpost to sign in again, or to see its jobs and recent runs."
          : "Always-on machines that run your company's scheduled jobs."}</p>
      </div>
      {#if manage && items.length > 0 && !atCap}
        <RailButton icon="plus" variant="primary" data-testid="add-outpost" onclick={beginAdd}>Add an Outpost</RailButton>
      {/if}
    </header>
    {#if manage}
      <p class="co-hint" data-testid="cap-hint">A company can have up to {cap} Outposts.</p>
    {:else}
      <div class="co-note" data-testid="member-note">You can view Outposts. Only company owners and admins can manage them.</div>
    {/if}
    {#if atCap}
      <div class="co-note" data-testid="cap-note">This company has {cap} Outposts, which is the current limit.</div>
    {/if}
    {#if notice}
      <div class="co-note" role="status">{notice}</div>
    {/if}
    {#if items.length === 0}
      <div class="co-card co-empty" data-testid="empty-outposts">
        <h2>No Outposts yet</h2>
        <h3>What is an Outpost?</h3>
        <p>An Outpost runs your company's scheduled Claude jobs, even when your computer is off.</p>
        {#if manage}
          <RailButton icon="plus" variant="primary" data-testid="add-outpost-empty" onclick={beginAdd}>Add an Outpost</RailButton>
        {:else}
          <p>Ask an owner or admin to add one.</p>
        {/if}
      </div>
    {:else}
      <div class="co-card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Last seen</th>
              <th>Jobs</th>
              <th>Job health</th>
            </tr>
          </thead>
          <tbody>
            {#each items as item (item.id)}
              <tr data-testid="outpost-row-{item.id}" data-state={item.state}>
                <td><button type="button" class="co-link" data-testid="open-{item.id}" onclick={() => void openDetail(item.id)}>{item.name}</button></td>
                <td><span class="co-state" data-state={item.state}>{stateLabel(item.state)}</span></td>
                <td>{lastSeenLabel(item.lastSeenAt, now)}</td>
                <td data-testid="jobs-count-{item.id}">{item.jobsCount}</td>
                <td>{jobHealthSummary(item.jobHealth, item.jobsCount)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else if screen === "add" || screen === "confirm"}
    <button type="button" class="co-link" data-testid="back-list" onclick={() => { screen = "list"; notice = ""; }}>‹ Outposts</button>
    <header class="co-head">
      <div>
        <h1>{screen === "confirm" ? "Confirm your Outpost" : "Add an Outpost"}</h1>
        <p>Company Outposts</p>
      </div>
    </header>
    {#if !manage}
      <div class="co-card">
        <h2>What is an Outpost?</h2>
        <p>An Outpost runs your company's scheduled Claude jobs, even when your computer is off.</p>
        <p>Only company owners and admins can manage Outposts. Ask an owner or admin to add one.</p>
      </div>
    {:else if atCap}
      <div class="co-card" data-testid="at-cap">
        <h2>This company is at its limit.</h2>
        <p>A company can have up to {cap} Outposts. Remove one before adding another.</p>
      </div>
    {:else}
      <div class="co-card">
        <h2>What is an Outpost?</h2>
        <p>An Outpost runs your company's scheduled Claude jobs, even when your computer is off.</p>
        <p class="co-hint">A company can have up to {cap} Outposts.</p>
        {#if screen === "confirm"}
          <div class="co-generated" data-testid="generated-name">
            <span class="co-hint">Generated name</span>
            <h2>{previewName}</h2>
            <p class="co-hint">HQ chose this name. You can rename it later.</p>
          </div>
        {/if}
        <p class="co-hint">Only company owners and admins can add Outposts. You can remove it at any time.</p>
        {#if notice}
          <div class="co-note" role="status" data-testid="provision-notice">{notice}</div>
        {/if}
        {#if screen === "confirm"}
          <div class="co-row">
            <RailButton icon="x" data-testid="confirm-back" onclick={() => { screen = "add"; notice = ""; }}>Back</RailButton>
            <RailButton icon="plus" variant="primary" data-testid="create-outpost" disabled={busy} onclick={() => void createOutpost()}>Add Outpost</RailButton>
          </div>
        {:else}
          <div class="co-row">
            <RailButton icon="x" data-testid="add-cancel" onclick={() => { screen = "list"; }}>Cancel</RailButton>
            <RailButton icon="check" variant="primary" data-testid="add-continue" onclick={continueAdd}>Continue</RailButton>
          </div>
        {/if}
      </div>
    {/if}
  {:else if screen === "unavailable"}
    <button type="button" class="co-link" data-testid="back-list" onclick={() => { screen = "list"; }}>‹ Outposts</button>
    <header class="co-head"><h1>Add an Outpost</h1></header>
    <div class="co-card" data-testid="outposts-unavailable">
      <p>{UNAVAILABLE_COPY}</p>
      <div class="co-row">
        <RailButton icon="refresh" data-testid="unavailable-retry" onclick={() => { screen = "confirm"; }}>Try again</RailButton>
      </div>
    </div>
  {:else if screen === "preparing"}
    <button type="button" class="co-link" data-testid="back-list" onclick={() => { screen = "list"; }}>‹ Outposts</button>
    <header class="co-head"><h1>Preparing this Outpost</h1></header>
    <div class="co-note" data-testid="prep-note">
      <p>Preparing this Outpost. This can take up to about 7 minutes. This page updates on its own. You can leave and come back.</p>
      <p data-testid="prep-step">{PREP_STEPS[prepStep]}</p>
    </div>
    {#if manage}
      <RailButton icon="refresh" data-testid="check-now" onclick={() => void checkNow()}>Check now</RailButton>
    {/if}
  {:else if screen === "remove" && selected}
    <button type="button" class="co-link" data-testid="back-detail" onclick={() => { screen = "detail"; }}>‹ {selected.name}</button>
    <header class="co-head"><h1>Remove this Outpost</h1><p>{selected.name}</p></header>
    <div class="co-card">
      <p>Its jobs stop.</p>
      <label for="remove-name">Type {selected.name} to confirm.</label>
      <input id="remove-name" data-testid="remove-name" autocomplete="off" bind:value={removeTyped} />
      <div class="co-row">
        <RailButton icon="x" data-testid="remove-cancel" onclick={() => { screen = "detail"; }}>Cancel</RailButton>
        <RailButton icon="trash" variant="danger" data-testid="remove-confirm" disabled={removeTyped.trim() !== selected.name || busy} onclick={() => void confirmRemove()}>Remove Outpost</RailButton>
      </div>
    </div>
  {:else if screen === "job" && selectedJob}
    <button type="button" class="co-link" data-testid="back-detail" onclick={() => { screen = "detail"; }}>‹ {detail?.name ?? "Outpost"}</button>
    <header class="co-head"><h1>{selectedJob.name}</h1><p>Job</p></header>
    <div class="co-card" data-testid="outpost-jobs-stub" data-route={OUTPOST_JOBS_ROUTE} data-job-id={selectedJob.id}>
      <p>This job opens on the {OUTPOST_JOBS_ROUTE} screen.</p>
      <p>{selectedJob.summary}</p>
    </div>
  {:else if screen === "detail" && (detail || selected)}
    {@const box = detail}
    {@const name = box?.name ?? selected?.name ?? "Outpost"}
    {@const state = box?.state ?? selected?.state ?? "needs_attention"}
    <button type="button" class="co-link" data-testid="back-list" onclick={() => { screen = "list"; notice = ""; }}>‹ Outposts</button>
    <header class="co-head">
      <div>
        <h1>{name}</h1>
        <p>Company Outpost</p>
      </div>
      <span class="co-state" data-testid="detail-state" data-state={state}>{stateLabel(state)}</span>
    </header>
    {#if !manage}
      <div class="co-note" data-testid="member-detail-note">You can view this Outpost and its jobs. Only owners and admins can change it.</div>
    {/if}
    {#if notice}
      <div class="co-note" role="status" data-testid="detail-notice">{notice}</div>
    {/if}
    {#if state === "preparing"}
      <div class="co-note" data-testid="prep-note">
        <p>Preparing this Outpost. This can take up to about 7 minutes. This page updates on its own. You can leave and come back.</p>
        <p data-testid="prep-step">{PREP_STEPS[Math.min(prepStep, PREP_STEPS.length - 1)]}</p>
        {#if manage}
          <RailButton icon="refresh" data-testid="check-now" onclick={() => void checkNow()}>Check now</RailButton>
        {/if}
      </div>
    {:else if state === "blocked"}
      <div class="co-note" data-testid="blocked-note">{blockedNote(role)}</div>
    {:else if state === "needs_attention"}
      <div class="co-note" data-testid="attention-note">{needsAttentionNote(box?.stopped ?? false)}</div>
    {/if}
    {#if renaming && manage}
      <div class="co-card" data-testid="rename-form">
        <h2>Rename Outpost</h2>
        <label for="rename-name">Outpost name</label>
        <input id="rename-name" data-testid="rename-name" maxlength="40" bind:value={renameName} />
        <p class="co-hint">Use 1 to 40 lowercase letters, numbers, and single dashes between words.</p>
        {#if renameMessage}<p class="co-error" role="alert" data-testid="rename-error">{renameMessage}</p>{/if}
        <div class="co-row">
          <RailButton icon="x" data-testid="rename-cancel" onclick={() => { renaming = false; }}>Cancel</RailButton>
          <RailButton icon="check" variant="primary" data-testid="rename-save" onclick={() => void saveName()}>Save name</RailButton>
        </div>
      </div>
    {/if}
    <h2>Jobs</h2>
    {#if box && box.jobs.length > 0}
      <div class="co-card">
        <table>
          <thead><tr><th>Job name</th><th>Last run</th><th>Result</th></tr></thead>
          <tbody>
            {#each box.jobs as job (job.id)}
              <tr>
                <td>
                  <button type="button" class="co-link" data-testid="job-{job.id}" data-route={OUTPOST_JOBS_ROUTE} onclick={() => openJob(job)}>{job.name}</button>
                </td>
                <td>{whenLabel(job.lastRunAt, now)}</td>
                <td>{healthLabel(job.health)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="co-card" data-testid="no-jobs"><h3>No jobs on this Outpost</h3></div>
    {/if}
    <h2>Recent runs</h2>
    {#if box && box.runs.length > 0}
      <div class="co-card">
        <table>
          <thead><tr><th>Job</th><th>When</th><th>Result</th></tr></thead>
          <tbody>
            {#each box.runs as run (run.id)}
              <tr data-testid="run-{run.id}">
                <td>{run.jobName}</td>
                <td>{whenLabel(run.at, now)}</td>
                <td>{healthLabel(run.health)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="co-card"><p>No recent runs.</p></div>
    {/if}
    {#if manage && box}
      <h2>Machine</h2>
      <dl class="co-card co-machine" data-testid="machine">
        <div><dt>Outpost</dt><dd>{box.id}</dd></div>
        <div><dt>Created</dt><dd>{box.machine.createdAt || "Not reported"}</dd></div>
      </dl>
      <div class="co-row" data-testid="manage-actions">
        <RailButton icon="pencil" data-testid="rename" onclick={() => { renaming = true; renameName = box.name; renameMessage = ""; }}>Rename</RailButton>
        {#if state === "running" || state === "needs_attention"}
          <RailButton icon="key" data-testid="sign-in-again" onclick={() => void signInAgain()}>Sign in again</RailButton>
        {/if}
        <RailButton icon="trash" variant="danger" data-testid="remove" onclick={() => { removeTyped = ""; screen = "remove"; }}>Remove</RailButton>
      </div>
    {:else if box}
      <dl class="co-card" data-testid="member-created">
        <div><dt>Created</dt><dd>{box.machine.createdAt || "Not reported"}</dd></div>
      </dl>
    {/if}
  {/if}
</section>

<style>
  .co {
    box-sizing: border-box;
    min-height: 100%;
    padding: 24px var(--page-edge-inset, 20px) 48px;
    color: var(--c-text, #111);
    background: var(--page-bg, transparent);
    font-size: var(--type-ui, 13px);
    line-height: var(--type-ui-line, 1.45);
  }
  .co-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 12px; }
  h1 { margin: 0; font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); }
  h2, h3 { margin: 16px 0 8px; font-size: var(--type-ui, 13px); font-weight: 500; }
  p { margin: 0 0 8px; }
  .co-hint { color: var(--c-muted, #666); }
  .co-card {
    border: 1px solid var(--c-divider, rgba(0, 0, 0, 0.08));
    background: var(--c-bg, #fff);
    border-radius: 12px;
    padding: 16px;
    margin: 12px 0;
  }
  .co-note {
    border-radius: 10px;
    padding: 12px 14px;
    margin: 12px 0;
    background: var(--c-field-bg, rgba(0, 0, 0, 0.04));
  }
  .co-link {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    text-decoration: underline;
    cursor: pointer;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px 8px 0; vertical-align: top; border-bottom: 1px solid var(--c-divider, rgba(0, 0, 0, 0.08)); }
  th { font-weight: 500; color: var(--c-muted, #666); }
  .co-state[data-state="running"] { color: #1f7a3a; }
  .co-state[data-state="blocked"] { color: #a12622; }
  .co-state[data-state="needs_attention"] { color: #8a5a00; }
  .co-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  label { display: block; margin: 8px 0 4px; }
  input:not([type]) {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--c-field-border, rgba(0, 0, 0, 0.16));
    background: var(--c-field-bg, transparent);
    color: inherit;
    font: inherit;
  }
  .co-error { color: #a12622; }
  .co-machine { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  dt { color: var(--c-muted, #666); }
  dd { margin: 0; }
</style>
