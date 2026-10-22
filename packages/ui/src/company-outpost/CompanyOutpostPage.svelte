<script lang="ts">
  /**
   * Company Outpost list, detail, and add flow.
   * Owners and admins manage. Members see the same list and detail, read only.
   * Jobs open the outpost-jobs route through onOpenJob. When the app cannot
   * open that route yet, the job shows a stub that names it. Claude sign-in
   * for an Outpost renders through the signInCard slot.
   */
  import { onMount, type Snippet } from "svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import {
    OUTPOST_JOBS_ROUTE,
    POLL_ERROR_LIMIT_MS,
    PREP_STEPS,
    blockedNote,
    canManageRole,
    healthLabel,
    jobHealthSummary,
    lastSeenLabel,
    listAfterProvision,
    outpostJobsDestination,
    UNAVAILABLE_COPY,
    needsAttentionNote,
    nextPollDelay,
    prepStepAt,
    stateLabel,
    whenLabel,
    type CompanyOutpostDetail,
    type CompanyOutpostJob,
    type CompanyOutpostListItem,
    type CompanyOutpostRole,
    type ProvisionResult,
  } from "./company-outpost-model.js";
  import type { CompanyOutpostClient } from "./company-outpost-client.js";
  import type { NavigationDestination } from "../shell/navigation-history.js";

  interface Props {
    companyUid: string;
    role: CompanyOutpostRole;
    client: CompanyOutpostClient;
    now?: number;
    pollMs?: number | null;
    initialScreen?: "list" | "add" | "confirm" | "detail" | "remove" | "preparing" | "unavailable" | "add-blocked" | "job";
    initialOutpostId?: string;
    initialJobId?: string;
    initialNotice?: string;
    /** Opens the outpost-jobs route. Returns false when the app cannot open it yet. */
    onOpenJob?: (destination: NavigationDestination) => boolean | Promise<boolean>;
    /** Claude sign-in card for one Outpost, shown to owners and admins. */
    signInCard?: Snippet<[{ companyUid: string; outpostId: string }]>;
    /** Starts the HQ sign-in flow after an expired sign-in. */
    onSignIn?: () => void | Promise<void>;
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
    signInCard,
    onSignIn,
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
  // A failed detail read. The detail screen shows it instead of empty jobs.
  let detailError = $state("");
  // Rows the list read returned but the app could not read.
  let unreadable = $state(0);
  // The add ended blocked: the server reported an outcome other than success.
  let addBlocked = $state<"outcome_unknown" | "failed_cleaned_up" | "not_started" | "">("");
  let removeTyped = $state("");
  let busy = $state(false);
  let attemptId = $state("");
  let prepStep = $state(0);
  // When this screen started waiting for the add. The step text follows the
  // build time, not the number of checks.
  // svelte-ignore state_referenced_locally
  let prepStartedAt = initialScreen === "preparing" ? Date.now() : 0;
  // Back-off after an unexpected status answer. Automatic checks stop after
  // POLL_ERROR_LIMIT_MS of these answers; Check now still works.
  let backoffMs = 0;
  let errorSince = 0;
  let autoCheck = $state(true);
  // Outpost ids listed before the add. An add with no attempt id must not
  // adopt one of these as the new Outpost.
  let knownIds = $state<string[]>([]);
  let signInNeeded = $state(false);
  let polling = false;

  const atCap = $derived(manage && items.length + unreadable >= cap);
  const selected = $derived(items.find((item) => item.id === selectedId) ?? null);

  function applyList(next: CompanyOutpostListItem[], nextCap: number, nextUnreadable = 0) {
    items = next;
    cap = nextCap;
    unreadable = nextUnreadable;
  }

  async function refresh() {
    const result = await client.list();
    if (!result.ok) {
      // The server answers a member with 403 and code "forbidden".
      const code = result.code.toLowerCase();
      loadMessage = role === "member" && (code.includes("403") || code.includes("forbidden"))
        ? "Outposts are not available to members yet."
        : result.message;
      return false;
    }
    loadMessage = "";
    applyList(result.items, result.cap, result.unreadable ?? 0);
    return true;
  }

  async function openDetail(id: string) {
    selectedId = id;
    // Never show the Outpost opened before while this one loads.
    detail = null;
    detailError = "";
    screen = "detail";
    await loadDetail(id);
  }

  // Reads the detail again without changing the screen, so a check never
  // leaves the Remove screen.
  async function loadDetail(id: string) {
    const result = await client.detail(id);
    if (selectedId !== id) return;
    if (result.ok) {
      detail = result.outpost;
      detailError = "";
    } else {
      detailError = result.message;
    }
    syncPrepStep();
  }

  function syncPrepStep() {
    const created = Date.parse(detail?.machine.createdAt ?? "");
    const start = screen !== "preparing" && Number.isFinite(created) ? created : prepStartedAt;
    prepStep = prepStepAt(start, Date.now());
  }

  function noteBackoff() {
    backoffMs = nextPollDelay(pollMs ?? 0, backoffMs);
    if (!errorSince) errorSince = Date.now();
    if (Date.now() - errorSince >= POLL_ERROR_LIMIT_MS) autoCheck = false;
  }

  function clearBackoff() {
    backoffMs = 0;
    errorSince = 0;
    autoCheck = true;
  }

  function applyProvision(result: ProvisionResult) {
    if (result.status === "checking") {
      signInNeeded = result.signIn;
      if (result.backoff) noteBackoff();
      else clearBackoff();
      return;
    }
    signInNeeded = false;
    clearBackoff();
    if (result.status === "success" && screen === "preparing" && !attemptId && knownIds.includes(result.outpost.id)) return;
    items = listAfterProvision(items, result);
    if (result.status === "pending") {
      attemptId = result.attemptId;
      if (screen !== "preparing") {
        prepStartedAt = Date.now();
        prepStep = 0;
      }
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
      void refresh().then(() => {
        const id = result.outpostId || items[0]?.id || "";
        if (id) return openDetail(id);
        screen = "list";
      });
      return;
    }
    if (result.status === "unavailable") {
      notice = "";
      screen = "unavailable";
      return;
    }
    if (result.status === "blocked") {
      notice = "";
      addBlocked = result.reason;
      screen = "add-blocked";
      void refresh();
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
    if (!manage || atCap) return;
    previewName = client.previewAdd(items.map((item) => item.name)).name;
    screen = "confirm";
  }

  async function createOutpost() {
    if (!manage || busy) return;
    busy = true;
    knownIds = items.map((item) => item.id);
    try {
      applyProvision(await client.provision());
    } finally {
      busy = false;
    }
  }

  // Check now and the poll timer both land here. Each call reads again.
  async function checkNow() {
    if (polling) return;
    polling = true;
    try {
      if (screen === "preparing") {
        syncPrepStep();
        if (!attemptId) {
          await refresh();
          const added = items.find((item) => !knownIds.includes(item.id));
          if (added) attemptId = added.id;
        }
        applyProvision(await client.pollProvision(attemptId));
        return;
      }
      if (selectedId) {
        await refresh();
        await loadDetail(selectedId);
      }
    } finally {
      polling = false;
    }
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

  async function openJob(job: CompanyOutpostJob) {
    selectedJob = job;
    if (selectedId && onOpenJob) {
      try {
        if (await onOpenJob(outpostJobsDestination(companyUid, selectedId))) return;
      } catch (err) {
        console.error("company outpost: could not open outpost-jobs", err);
      }
    }
    screen = "job";
  }

  onMount(() => {
    if (role === "guest") {
      ready = true;
      return;
    }
    let live = true;
    void (async () => {
      await refresh();
      if (!live) return;
      // Read the detail even when the list read failed, so a detail open
      // never waits on a list error it cannot show.
      if (initialOutpostId) {
        const result = await client.detail(initialOutpostId);
        if (live && !result.ok) detailError = result.message;
        if (live && result.ok) {
          detail = result.outpost;
          syncPrepStep();
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
    if (pollMs == null || !autoCheck) return;
    const preparingDetail = screen === "detail" && (detail?.state ?? selected?.state) === "preparing";
    if (!(screen === "preparing" && manage) && !preparingDetail) return;
    const base = pollMs;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        void checkNow().then(() => {
          if (live) schedule();
        });
      }, Math.max(base, backoffMs));
    };
    schedule();
    return () => {
      live = false;
      clearTimeout(timer);
    };
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
        <p>Always-on machines that run your company's scheduled jobs.</p>
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
    {#if unreadable > 0}
      <div class="co-note" role="alert" data-testid="unreadable-rows">
        {unreadable === 1 ? "1 Outpost" : `${unreadable} Outposts`} could not be read. Retry, or ask HQ support if this keeps happening.
        <RailButton icon="refresh" data-testid="unreadable-retry" onclick={() => void refresh()}>Retry</RailButton>
      </div>
    {/if}
    {#if items.length === 0 && unreadable > 0}
      <!-- Rows exist but none could be read: no empty state and no Add. -->
    {:else if items.length === 0}
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
            <p class="co-hint">HQ chose this name.</p>
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
  {:else if screen === "add-blocked"}
    <button type="button" class="co-link" data-testid="back-list" onclick={() => { screen = "list"; void refresh(); }}>‹ Outposts</button>
    <header class="co-head"><h1>Add an Outpost</h1></header>
    <div class="co-card" data-testid="add-blocked" data-reason={addBlocked}>
      {#if addBlocked === "failed_cleaned_up"}
        <p>The Outpost was not added. HQ cleaned up the attempt, so it is safe to add a new one.</p>
        <div class="co-row">
          <RailButton icon="plus" variant="primary" data-testid="add-blocked-retry" onclick={continueAdd}>Add a new Outpost</RailButton>
        </div>
      {:else if addBlocked === "not_started"}
        <p>The Outpost was not added. The add did not start.</p>
        <div class="co-row">
          <RailButton icon="refresh" data-testid="add-blocked-retry" onclick={continueAdd}>Try again</RailButton>
        </div>
      {:else}
        <p>HQ could not confirm whether this Outpost was added. HQ has been notified. Check the Outposts list before adding another.</p>
      {/if}
    </div>
  {:else if screen === "preparing"}
    <button type="button" class="co-link" data-testid="back-list" onclick={() => { screen = "list"; void refresh(); }}>‹ Outposts</button>
    <header class="co-head"><h1>Preparing this Outpost</h1></header>
    <div class="co-note" data-testid="prep-note">
      <p>Preparing this Outpost. This can take up to about 7 minutes. This page updates on its own. You can leave and come back.</p>
      <p data-testid="prep-step">{PREP_STEPS[prepStep]}</p>
    </div>
    {#if signInNeeded}
      <div class="co-note" role="alert" data-testid="prep-signin">
        <p>Sign in to HQ again to continue.</p>
        {#if onSignIn}
          <RailButton icon="key" data-testid="prep-signin-action" onclick={() => void onSignIn?.()}>Sign in again</RailButton>
        {/if}
      </div>
    {/if}
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
  {:else if screen === "detail"}
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
    {:else if state === "blocked" && (box?.unavailable ?? selected?.unavailable)}
      <div class="co-card" data-testid="blocked-unavailable">
        <p>{UNAVAILABLE_COPY}</p>
        <div class="co-row">
          <RailButton icon="refresh" data-testid="blocked-unavailable-retry" onclick={() => void checkNow()}>Try again</RailButton>
        </div>
      </div>
    {:else if state === "blocked"}
      <div class="co-note" data-testid="blocked-note">{blockedNote(role)}</div>
    {:else if state === "needs_attention"}
      <div class="co-note" data-testid="attention-note">{needsAttentionNote(box?.stopped ?? false)}</div>
    {/if}
    {#if !box && detailError}
      <div class="co-note" role="alert" data-testid="detail-error">{detailError}</div>
      <RailButton icon="refresh" data-testid="detail-retry" onclick={() => { detailError = ""; void loadDetail(selectedId); }}>Retry</RailButton>
    {:else if !box}
      <div class="co-card" data-testid="detail-loading"><p>Loading this Outpost.</p></div>
    {:else}
    <h2>Jobs</h2>
    {#if box && box.jobs.length > 0}
      <div class="co-card">
        <table>
          <thead><tr><th>Job name</th><th>Last run</th><th>Result</th></tr></thead>
          <tbody>
            {#each box.jobs as job (job.id)}
              <tr>
                <td>
                  <button type="button" class="co-link" data-testid="job-{job.id}" data-route={OUTPOST_JOBS_ROUTE} onclick={() => void openJob(job)}>{job.name}</button>
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
    {/if}
    {#if manage && box}
      <h2>Machine</h2>
      <dl class="co-card co-machine" data-testid="machine">
        <div><dt>Outpost</dt><dd>{box.id}</dd></div>
        <div><dt>Created</dt><dd>{box.machine.createdAt || "Not reported"}</dd></div>
      </dl>
      <div class="co-row" data-testid="manage-actions">
        <RailButton icon="trash" variant="danger" data-testid="remove" onclick={() => { removeTyped = ""; screen = "remove"; }}>Remove</RailButton>
      </div>
      {#if signInCard && (state === "running" || state === "needs_attention")}
        <div data-testid="company-outpost-signin-slot">{@render signInCard({ companyUid, outpostId: box.id })}</div>
      {/if}
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
  .co-machine { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  dt { color: var(--c-muted, #666); }
  dd { margin: 0; }
</style>
