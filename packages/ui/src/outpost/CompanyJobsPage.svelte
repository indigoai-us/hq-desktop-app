<script lang="ts">
  import { untrack } from "svelte";
  import "../home/tokens.css";
  import "../chat/chat-tokens.css";
  import "../common/button/rail-type.css";
  import Dropdown from "../common/Dropdown.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import { agoLabel, untilLabel } from "./outpost-model.js";
  import {
    ALERT_AUDIENCE,
    ALERT_AUDIENCE_LABEL,
    CONTACT_FAILED_COPY,
    CONTACT_SENT_COPY,
    CONTACT_US_LABEL,
    NOT_AVAILABLE_COPY,
    OUTPOST_JOBS_ROUTE,
    SCHEDULE_PRESETS,
    blankJobDraft,
    blockedBoxNote,
    canManageCompanyJobs,
    draftCron,
    isNotAvailableCode,
    isRunnableJob,
    jobFailureCopy,
    jobsFromHealthOnly,
    logSummary,
    mergeJobHealth,
    parseCompanyBoxes,
    revisionDefinition,
    schedulePlainWords,
    validateJobDraft,
    watchdogDraft,
    type CompanyBoxOption,
    type CompanyJobRole,
    type JobDraft,
    type ListedCompanyJob,
  } from "./company-jobs-model.js";
  import {
    companyJobsClientFromApi,
    type CompanyJobsApi,
    type CompanyJobsClient,
    type CompanyJobsContact,
    type JobsListResult,
    type JobsStatusResult,
  } from "./company-jobs-client.js";

  interface Props {
    companyUid?: string | null;
    outpostId?: string | null;
    role?: CompanyJobRole;
    /** Omit to load boxes from the company Outpost list. An empty array stays empty. */
    boxes?: CompanyBoxOption[];
    /** Test and preview seam. Wins over `api`. */
    client?: CompanyJobsClient | null;
    api?: CompanyJobsApi | null;
    /** Contact us on the not-available-yet state. Hidden when absent. */
    contact?: CompanyJobsContact | null;
    /** Fixed clock for tests. Live pages tick on their own. */
    now?: number;
  }

  let {
    companyUid = null,
    outpostId = null,
    role = "unknown",
    boxes = undefined,
    client = null,
    api = null,
    contact = null,
    now: nowProp,
  }: Props = $props();

  const manage = $derived(canManageCompanyJobs(role));
  const resolvedClient = $derived(
    client ?? companyJobsClientFromApi(api ?? null, { writesAllowed: manage }),
  );

  let jobs = $state<ListedCompanyJob[]>([]);
  let loading = $state(false);
  let ready = $state(false);
  let loadError = $state("");
  let readDenied = $state(false);
  let saveError = $state("");
  let saving = $state(false);
  let reloadToken = $state(0);
  let filter = $state("all");
  let routedOutpost = "";
  let formMode = $state<"add" | "edit" | null>(null);
  let editing = $state<ListedCompanyJob | null>(null);
  let draft = $state<JobDraft>(blankJobDraft());
  let fieldErrors = $state<Record<string, string>>({});
  let logId = $state<string | null>(null);
  let confirmRemoveId = $state<string | null>(null);
  let clock = $state(Date.now());
  let loadedBoxes = $state<CompanyBoxOption[] | null>(null);
  let burstUntil = $state(0);
  let burstJobId = $state("");
  let burstAfter = $state("");
  /** A read or write came back with a not-available-yet code. */
  let refusedNotAvailable = $state(false);
  /** A write was refused this way. Kept so a later successful read does not hide the state. */
  let writeRefusedNotAvailable = $state(false);
  let contactState = $state<"idle" | "sending" | "sent" | "error">("idle");

  const nowMs = $derived(nowProp ?? clock);
  const knownBoxes = $derived(boxes ?? loadedBoxes ?? []);
  const plainSchedule = $derived(schedulePlainWords(draftCron(draft)));
  const scheduleOptions = $derived([
    ...SCHEDULE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
    { value: "custom", label: "Custom schedule" },
  ]);
  const alertOptions = [{ value: ALERT_AUDIENCE, label: ALERT_AUDIENCE_LABEL }];
  const openLog = $derived(jobs.find((job) => job.jobId === logId) ?? null);
  const boxChoices = $derived.by(() => {
    const map = new Map<string, CompanyBoxOption>();
    for (const box of knownBoxes) map.set(box.id, box);
    if (outpostId && !map.has(outpostId)) map.set(outpostId, { id: outpostId, name: outpostId });
    for (const job of jobs) {
      if (job.outpostId && !map.has(job.outpostId)) map.set(job.outpostId, { id: job.outpostId, name: job.outpostId });
    }
    if (draft.boxId && !map.has(draft.boxId)) map.set(draft.boxId, { id: draft.boxId, name: draft.boxId });
    return [...map.values()];
  });
  const filterOptions = $derived([
    { value: "all", label: "All boxes" },
    ...boxChoices.map((box) => ({ value: box.id, label: box.name })),
  ]);
  const boxFieldOptions = $derived([
    { value: "", label: "Choose an Outpost" },
    ...boxChoices.map((box) => ({ value: box.id, label: box.name })),
  ]);
  const notAvailable = $derived.by(() => {
    if (!companyUid) return false;
    if (refusedNotAvailable || writeRefusedNotAvailable) return true;
    if (filter !== "all") return knownBoxes.find((item) => item.id === filter)?.unavailable === true;
    return knownBoxes.length > 0 && knownBoxes.every((box) => box.unavailable);
  });
  const blockedNote = $derived.by(() => {
    if (!companyUid || notAvailable) return null;
    if (filter !== "all") {
      const box = knownBoxes.find((item) => item.id === filter) ?? null;
      return box ? blockedBoxNote(box, manage) : null;
    }
    if (knownBoxes.length === 0 || !knownBoxes.every((box) => box.blocked || box.stopped)) return null;
    const stopped = knownBoxes.every((box) => box.stopped);
    return blockedBoxNote({ id: "all", name: "all", stopped, blocked: !stopped }, manage);
  });

  $effect(() => {
    const next = outpostId?.trim() || "";
    if (next === routedOutpost) return;
    routedOutpost = next;
    if (next) filter = next;
  });

  $effect(() => {
    const company = companyUid;
    const loader = api?.listCompanyOutposts;
    if (boxes || !company || !loader) return;
    let cancelled = false;
    void loader(company).then((result) => {
      if (cancelled || !result.ok) return;
      loadedBoxes = parseCompanyBoxes(result.value);
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (nowProp != null) return;
    const id = setInterval(() => {
      clock = Date.now();
    }, 30_000);
    return () => clearInterval(id);
  });

  $effect(() => {
    const until = burstUntil;
    const wait = until > Date.now() ? 10_000 : 60_000;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (burstUntil !== 0 && Date.now() >= burstUntil) {
        burstUntil = 0;
        burstJobId = "";
        burstAfter = "";
      }
      reloadToken += 1;
    }, wait);
    return () => clearInterval(id);
  });

  let generation = 0;
  $effect(() => {
    const current = resolvedClient;
    const company = companyUid;
    const box = filter;
    const token = reloadToken;
    if (!company) {
      generation += 1;
      loading = false;
      ready = true;
      jobs = [];
      loadError = "";
      readDenied = false;
      return;
    }
    const gen = ++generation;
    untrack(() => {
      if (jobs.length === 0) loading = true;
    });
    void Promise.all([
      current.list(company, box === "all" ? null : box),
      current.status(company, box === "all" ? null : box),
    ]).then(([listRes, statusRes]) => {
      if (gen !== generation) return;
      loading = false;
      ready = true;
      applyRead(listRes, statusRes);
    });
    void token;
  });

  function applyRead(listRes: JobsListResult, statusRes: JobsStatusResult): void {
    refusedNotAvailable =
      (!listRes.ok && isNotAvailableCode(listRes.code)) || (!statusRes.ok && isNotAvailableCode(statusRes.code));
    if (refusedNotAvailable) {
      jobs = [];
      loadError = "";
      readDenied = false;
      return;
    }
    if (!listRes.ok && !statusRes.ok) {
      jobs = [];
      if (canManageCompanyJobs(role)) {
        loadError = jobFailureCopy(listRes.code);
        readDenied = false;
      } else {
        loadError = "";
        readDenied = true;
      }
      return;
    }
    loadError = "";
    readDenied = false;
    if (listRes.ok && statusRes.ok) jobs = mergeJobHealth(listRes.jobs, statusRes.jobs);
    else if (listRes.ok) jobs = mergeJobHealth(listRes.jobs, []);
    else if (statusRes.ok) jobs = jobsFromHealthOnly(statusRes.jobs);
    if (!burstJobId || !burstAfter) return;
    const row = jobs.find((item) => item.jobId === burstJobId);
    const last = row?.lastRunAt ? Date.parse(row.lastRunAt) : Number.NaN;
    const after = Date.parse(burstAfter);
    if (Number.isFinite(last) && Number.isFinite(after) && last > after) {
      burstUntil = 0;
      burstJobId = "";
      burstAfter = "";
    }
  }

  function defaultBox(): string {
    if (filter !== "all") return filter;
    return knownBoxes.length === 1 ? knownBoxes[0].id : "";
  }

  function openAdd(): void {
    if (!manage) return;
    editing = null;
    formMode = "add";
    draft = blankJobDraft(defaultBox());
    fieldErrors = {};
    saveError = "";
  }

  function openWatchdog(): void {
    if (!manage) return;
    editing = null;
    formMode = "add";
    draft = watchdogDraft(defaultBox());
    fieldErrors = {};
    saveError = "";
  }

  function openEdit(job: ListedCompanyJob): void {
    if (!manage || !job.revision) return;
    const preset = SCHEDULE_PRESETS.find((item) => item.cron === job.cron);
    editing = job;
    formMode = "edit";
    draft = {
      name: job.name,
      mode: job.skill ? "skill" : "prompt",
      prompt: job.skill ? "" : job.prompt,
      skill: job.skill ?? "",
      preset: preset ? preset.id : "custom",
      customCron: job.cron,
      timezone: job.timezone || "UTC",
      boxId: job.outpostId,
      alertAudience: ALERT_AUDIENCE,
    };
    fieldErrors = {};
    saveError = "";
  }

  function closeForm(): void {
    formMode = null;
    editing = null;
    fieldErrors = {};
    saveError = "";
  }

  function takenNames(): string[] {
    return jobs.filter((job) => job.outpostId === draft.boxId).map((job) => job.name);
  }

  async function submitForm(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!manage || !companyUid) return;
    const errors = validateJobDraft(draft, takenNames(), editing?.name);
    fieldErrors = errors;
    if (Object.keys(errors).length > 0) return;
    saving = true;
    saveError = "";
    const result = await resolvedClient.submit({
      companyUid,
      action: formMode === "edit" ? "update" : "create",
      outpostId: draft.boxId,
      jobId: editing?.jobId,
      revision: editing?.revision,
      definition: revisionDefinition(draft),
    });
    saving = false;
    if (!result.ok) {
      if (isNotAvailableCode(result.code)) {
        closeForm();
        writeRefusedNotAvailable = true;
        return;
      }
      saveError = jobFailureCopy(result.code);
      return;
    }
    closeForm();
    reloadToken += 1;
  }

  async function mutate(action: "enable" | "disable" | "delete" | "run-now", job: ListedCompanyJob): Promise<void> {
    if (!manage || !companyUid || !job.revision) return;
    saveError = "";
    const result = await resolvedClient.submit({
      companyUid,
      action,
      outpostId: job.outpostId,
      jobId: job.jobId,
      revision: job.revision,
    });
    if (!result.ok) {
      if (isNotAvailableCode(result.code)) {
        writeRefusedNotAvailable = true;
        return;
      }
      saveError = jobFailureCopy(result.code);
      return;
    }
    if (action === "run-now") {
      burstJobId = job.jobId;
      burstAfter = result.requestedAt ?? new Date(nowMs).toISOString();
      burstUntil = Date.now() + 5 * 60 * 1000;
    }
    confirmRemoveId = null;
    reloadToken += 1;
  }

  async function contactUs(): Promise<void> {
    if (!contact || !companyUid || contactState === "sending") return;
    contactState = "sending";
    const result = await contact(companyUid);
    contactState = result.ok ? "sent" : "error";
  }

  function lastRunCopy(iso: string | null): string {
    if (!iso) return "Never";
    return agoLabel(iso, nowMs) || "Never";
  }

  function nextRunCopy(job: ListedCompanyJob): string {
    if (job.paused || job.display === "paused") return "Paused";
    if (!job.nextRunAt) return "Not scheduled";
    return untilLabel(job.nextRunAt, nowMs) || "Not scheduled";
  }

  function dotClass(job: ListedCompanyJob): string {
    if (job.display === "ok") return "ok";
    if (job.display === "missed" || job.display === "blocked") return "err";
    if (job.display === "stale") return "warn";
    return "";
  }
</script>

<div
  class="page"
  data-testid="company-jobs-page"
  data-route={OUTPOST_JOBS_ROUTE}
  data-ready={ready ? "true" : "false"}
>
  <header class="toolbar">
    <h1>Jobs</h1>
    <p class="sub grow" data-testid="company-jobs-route" data-route={OUTPOST_JOBS_ROUTE}>Scheduled jobs for this company.</p>
    {#if companyUid}
      <Dropdown
        value={filter}
        options={filterOptions}
        label="Box"
        testid="company-jobs-box-filter"
        onchange={(value) => (filter = value)}
      />
      {#if manage && !notAvailable}
        <button type="button" data-testid="company-jobs-watchdog" onclick={openWatchdog}>Watchdog template</button>
        <button type="button" class="primary" data-testid="company-jobs-add" onclick={openAdd}>Add a job</button>
      {/if}
    {/if}
  </header>

  {#if !companyUid}
    <p class="empty" data-testid="company-jobs-empty">Choose a company to see its jobs.</p>
  {:else if notAvailable}
    <div class="note unavailable" data-testid="company-jobs-not-available">
      <span data-testid="company-jobs-not-available-copy">{NOT_AVAILABLE_COPY}</span>
      {#if contactState === "sent"}
        <span class="sub" data-testid="company-jobs-contact-sent">{CONTACT_SENT_COPY}</span>
      {:else if contact}
        <button type="button" data-testid="company-jobs-contact-us" disabled={contactState === "sending"} onclick={() => void contactUs()}>{CONTACT_US_LABEL}</button>
      {/if}
    </div>
    {#if contactState === "error"}
      <p class="note error" role="alert" data-testid="company-jobs-contact-error">{CONTACT_FAILED_COPY}</p>
    {/if}
  {:else}
    {#if readDenied}
      <p class="note" data-testid="company-jobs-read-denied">You do not have access to this company's Outposts.</p>
    {:else if !manage}
      <p class="sub note" data-testid="company-jobs-member-note">You can view this Outpost and its jobs. Only owners and admins can change it.</p>
    {/if}
    {#if blockedNote}
      <p class="note" data-testid="company-jobs-blocked-note">{blockedNote}</p>
    {/if}
    {#if loadError}
      <div class="note error" role="alert" data-testid="company-jobs-load-error">
        <span>{loadError}</span>
        <button type="button" data-testid="company-jobs-try-again" onclick={() => (reloadToken += 1)}>Try again</button>
      </div>
    {/if}
    {#if saveError && !formMode}
      <p class="note error" role="alert" data-testid="company-jobs-error">{saveError}</p>
    {/if}

    {#if formMode}
      <form class="form" data-testid="company-jobs-form" onsubmit={(event) => void submitForm(event)}>
        <h2>{formMode === "edit" ? "Edit job" : "Add a job"}</h2>
        <label for="company-jobs-name">Job name</label>
        <input
          id="company-jobs-name"
          data-testid="company-jobs-name"
          value={draft.name}
          maxlength="60"
          aria-invalid={fieldErrors.name ? "true" : "false"}
          oninput={(event) => (draft.name = event.currentTarget.value)}
        />
        {#if fieldErrors.name}<p class="error" data-testid="company-jobs-name-error">{fieldErrors.name}</p>{/if}

        <div class="modes">
          <button type="button" data-testid="company-jobs-mode-prompt" class:on={draft.mode === "prompt"} onclick={() => (draft.mode = "prompt")}>Prompt</button>
          <button type="button" data-testid="company-jobs-mode-skill" class:on={draft.mode === "skill"} onclick={() => (draft.mode = "skill")}>Skill reference</button>
        </div>
        {#if draft.mode === "skill"}
          <label for="company-jobs-run">Skill reference</label>
          <input
            id="company-jobs-run"
            data-testid="company-jobs-run"
            value={draft.skill}
            aria-invalid={fieldErrors.run ? "true" : "false"}
            oninput={(event) => (draft.skill = event.currentTarget.value)}
          />
        {:else}
          <label for="company-jobs-run">What to run</label>
          <textarea
            id="company-jobs-run"
            data-testid="company-jobs-run"
            rows="4"
            value={draft.prompt}
            aria-invalid={fieldErrors.run ? "true" : "false"}
            oninput={(event) => (draft.prompt = event.currentTarget.value)}
          ></textarea>
        {/if}
        {#if fieldErrors.run}<p class="error" data-testid="company-jobs-run-error">{fieldErrors.run}</p>{/if}

        <Dropdown
          value={draft.preset}
          options={scheduleOptions}
          label="Schedule"
          testid="company-jobs-schedule"
          block
          onchange={(value) => {
            draft.preset = value === "custom" || SCHEDULE_PRESETS.some((item) => item.id === value) ? (value as JobDraft["preset"]) : "custom";
            if (draft.preset !== "custom") draft.customCron = draftCron(draft);
          }}
        />
        {#if draft.preset === "custom"}
          <label for="company-jobs-custom">EventBridge schedule</label>
          <input
            id="company-jobs-custom"
            class="mono"
            data-testid="company-jobs-custom"
            value={draft.customCron}
            oninput={(event) => (draft.customCron = event.currentTarget.value)}
          />
        {/if}
        <p class="sub" data-testid="company-jobs-schedule-plain">{plainSchedule}</p>
        <label for="company-jobs-timezone">Timezone</label>
        <input
          id="company-jobs-timezone"
          data-testid="company-jobs-timezone"
          value={draft.timezone}
          oninput={(event) => (draft.timezone = event.currentTarget.value)}
        />
        {#if fieldErrors.schedule}<p class="error" data-testid="company-jobs-schedule-error">{fieldErrors.schedule}</p>{/if}

        <Dropdown
          value={draft.boxId}
          options={boxFieldOptions}
          label="Outpost"
          testid="company-jobs-box"
          block
          onchange={(value) => (draft.boxId = value)}
        />
        {#if fieldErrors.box}<p class="error" data-testid="company-jobs-box-error">{fieldErrors.box}</p>{/if}

        <Dropdown
          value={draft.alertAudience}
          options={alertOptions}
          label="Who gets alerted"
          testid="company-jobs-alert"
          block
          onchange={(value) => (draft.alertAudience = value)}
        />
        {#if fieldErrors.alert}<p class="error" data-testid="company-jobs-alert-error">{fieldErrors.alert}</p>{/if}

        {#if saveError}<p class="error" role="alert" data-testid="company-jobs-error">{saveError}</p>{/if}
        <div class="actions">
          <button type="button" onclick={closeForm}>Cancel</button>
          <button type="submit" class="primary" data-testid="company-jobs-submit" disabled={saving}>
            {formMode === "edit" ? "Save job" : "Add job"}
          </button>
        </div>
      </form>
    {:else if loading && jobs.length === 0 && !loadError && !readDenied}
      <div class="empty" data-testid="company-jobs-loading" aria-busy="true"><ReadLoader testid="company-jobs-loader" /></div>
    {:else if !loadError && !readDenied && jobs.length === 0}
      <p class="empty" data-testid="company-jobs-empty">
        {manage ? "No scheduled jobs yet." : "An owner or admin can add scheduled jobs here."}
      </p>
    {:else if jobs.length > 0}
      <div class="list" data-testid="company-jobs-list">
        <div class="row head"><span>Job</span><span>Schedule</span><span>Last run</span><span>Next run</span><span>Result</span><span></span></div>
        {#each jobs as job (job.jobId)}
          <div class="row" data-testid="company-jobs-row" data-job-id={job.jobId} data-acceptance={job.accepted ? "accepted" : "pending"} data-health={job.display}>
            <span class="name">{job.name}</span>
            <span>{job.scheduleLabel}</span>
            <span data-testid="company-jobs-last">{lastRunCopy(job.lastRunAt)}</span>
            <span data-testid="company-jobs-next">{nextRunCopy(job)}</span>
            <span class="status" data-testid="company-jobs-health">
              <i class="dot {dotClass(job)}"></i>
              <span data-testid={job.display === "missed" ? "company-jobs-missed" : job.display === "stale" ? "company-jobs-stale" : undefined}>{job.displayLabel}</span>
            </span>
            <span class="actions">
              <button type="button" data-testid="company-jobs-log" onclick={() => (logId = job.jobId)}>Log</button>
              {#if manage && job.accepted && job.revision}
                {#if job.paused}
                  <button type="button" data-testid="company-jobs-resume" onclick={() => void mutate("enable", job)}>Resume</button>
                {:else}
                  <button type="button" data-testid="company-jobs-pause" onclick={() => void mutate("disable", job)}>Pause</button>
                  {#if isRunnableJob(job)}
                    <button type="button" data-testid="company-jobs-run-now" onclick={() => void mutate("run-now", job)}>Run now</button>
                  {/if}
                {/if}
                <button type="button" data-testid="company-jobs-edit" onclick={() => openEdit(job)}>Edit</button>
                {#if confirmRemoveId === job.jobId}
                  <span>Remove this job?</span>
                  <button type="button" data-testid="company-jobs-remove-confirm" onclick={() => void mutate("delete", job)}>Remove job</button>
                  <button type="button" onclick={() => (confirmRemoveId = null)}>Cancel</button>
                {:else}
                  <button type="button" data-testid="company-jobs-remove" onclick={() => (confirmRemoveId = job.jobId)}>Remove</button>
                {/if}
              {:else if !job.accepted}
                <span data-testid="company-jobs-waiting">Waiting for an admin</span>
              {/if}
            </span>
          </div>
        {/each}
      </div>
      {#if openLog}
        <section class="log" data-testid="company-jobs-log-panel">
          <h2>{openLog.name}</h2>
          <p>{logSummary(openLog)}</p>
          <button type="button" data-testid="company-jobs-log-close" onclick={() => (logId = null)}>Close</button>
        </section>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .page {
    height: 100%;
    min-height: 0;
    overflow: auto;
    color: var(--t1, var(--v4-text-1));
    background: var(--v4-ground);
    font: 400 13px/1.45 var(--font-ui, "Geist", -apple-system, sans-serif);
    padding: 0 20px 28px;
    box-sizing: border-box;
  }
  h1 { font-size: 20px; font-weight: 500; line-height: 1.25; margin: 0; }
  h2 { font-size: 13px; font-weight: 500; margin: 0 0 8px; }
  button, input, textarea { font: inherit; font-size: 13px; }
  button { cursor: pointer; background: transparent; color: var(--t1, var(--v4-text-1)); border: 1px solid var(--line, var(--v4-hairline)); border-radius: var(--hq-btn-radius, 6px); height: var(--hq-btn-h, auto); padding: 0 var(--hq-btn-pad-inline, 10px); }
  button.primary, button.on { background: var(--sel, var(--v4-active-row)); }
  button:disabled { opacity: 0.45; cursor: default; }
  .toolbar { display: flex; align-items: center; gap: 8px; min-height: 52px; margin: 0 -20px 12px; padding: 0 20px; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  .grow { flex: 1; margin: 0; }
  .sub { color: var(--t3, var(--v4-text-3)); }
  .note { margin: 0 0 12px; }
  .unavailable { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 12px; }
  .error { color: var(--red, var(--v4-error)); }
  .empty { padding: 24px 0; }
  .form { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; max-width: 460px; }
  .form input, .form textarea { width: 100%; box-sizing: border-box; }
  .modes, .actions, .status { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .list { display: flex; flex-direction: column; }
  .row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1.2fr) 90px 110px minmax(120px, 0.8fr) minmax(180px, 1.4fr); gap: 8px; align-items: center; min-height: 31px; padding: 4px 0; }
  .row > * { min-width: 0; }
  .row.head { color: var(--t3, var(--v4-text-3)); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--t3, var(--v4-text-3)); display: inline-block; }
  .dot.ok { background: var(--ok, var(--v4-ok)); }
  .dot.err { background: var(--red, var(--v4-error)); }
  .dot.warn { background: var(--t2, var(--v4-text-2)); }
  .mono { font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .log { margin-top: 12px; padding: 12px; border: 1px solid var(--line, var(--v4-hairline)); border-radius: 8px; max-width: 520px; }
</style>
