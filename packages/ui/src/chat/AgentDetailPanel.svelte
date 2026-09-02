<script lang="ts">
  /**
   * Slack-style right-hand agent detail pane: identity, scheduled jobs,
   * 30-day usage, and owner/admin settings. Data comes from adapter.agents
   * (hq-pro). Missing/forbidden endpoints render an honest empty state.
   */
  import type { AgentsApi, PlatformAdapter } from "@hq/platform";
  import IdentityMark from "./messaging/IdentityMark.svelte";
  import AvatarPickerSlot from "./AvatarPickerSlot.svelte";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import type { SelfIdentity } from "../identity/self.js";
  import {
    defaultTelemetryRange,
    formatTokenCount,
    headerFromMobileRoster,
    headerFromStatusPayload,
    jobsFromPayload,
    ownerLabelFromPayload,
    ownersIncludePerson,
    seedHeader,
    unavailableMessage,
    usageFromCompanyTelemetry,
    type AgentDetailHeader,
    type AgentJobRow,
    type AgentUsageView,
    type LoadState,
  } from "./agent-detail-model.js";
  import "./tokens.css";
  import "./chat-tokens.css";

  interface Props {
    agentUid: string;
    displayName: string;
    avatarUrl?: string | null;
    description?: string | null;
    companyUid?: string | null;
    companyNames?: Map<string, string> | Record<string, string>;
    self?: SelfIdentity | null;
    isAdmin?: boolean | null;
    adapter: Pick<PlatformAdapter, "agents"> | { agents: AgentsApi };
    onclose?: () => void;
  }

  let {
    agentUid,
    displayName,
    avatarUrl = null,
    description = null,
    companyUid = null,
    companyNames,
    self = null,
    isAdmin = null,
    adapter,
    onclose,
  }: Props = $props();

  let header = $state<AgentDetailHeader>(
    seedHeader({ uid: "", displayName: "" }),
  );
  let jobsState = $state<LoadState<AgentJobRow[]>>({ status: "loading" });
  let usageState = $state<LoadState<AgentUsageView>>({ status: "loading" });
  let expandedJobId = $state<string | null>(null);
  let nameDraft = $state("");
  let descriptionDraft = $state("");
  let saveBusy = $state(false);
  let saveError = $state<string | null>(null);
  let confirm = $state<"pause-agent" | "remove-agent" | "pause-job" | null>(
    null,
  );
  let pendingJobId = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let copied = $state(false);
  let panelEl = $state<HTMLElement | null>(null);

  const canManage = $derived(
    header.canManage || isAdmin === true,
  );

  $effect(() => {
    const uid = agentUid;
    const company = companyUid ?? null;
    const currentSeed = {
      uid,
      displayName,
      description,
      avatarUrl,
      companyUid: company,
      companyNames,
    };
    header = seedHeader(currentSeed);
    nameDraft = displayName;
    descriptionDraft = description ?? "";
    jobsState = { status: "loading" };
    usageState = { status: "loading" };
    expandedJobId = null;
    saveError = null;
    actionError = null;
    const agents = adapter.agents;
    let cancelled = false;
    if (!agents) {
      jobsState = {
        status: "unavailable",
        message: "Not available yet.",
      };
      usageState = {
        status: "unavailable",
        message: "Not available yet.",
      };
      return;
    }

    async function load(): Promise<void> {
      const range = defaultTelemetryRange(30);
      const [statusRes, rosterRes, jobsRes, usageRes, ownersRes] =
        await Promise.all([
          agents.getStatus(uid),
          agents.listMobileRoster(company),
          agents.listJobs(uid),
          company
            ? agents.getCompanyTelemetry(company, range.from, range.to)
            : Promise.resolve({
                ok: false as const,
                reason: "unavailable" as const,
                message: "No company is bound to this conversation.",
              }),
          company
            ? agents.listOwners(company, uid)
            : Promise.resolve({
                ok: false as const,
                reason: "unavailable" as const,
              }),
        ]);
      if (cancelled) return;

      if (statusRes.ok) {
        header = headerFromStatusPayload(statusRes.value, currentSeed);
      } else {
        const fromRoster = headerFromMobileRoster(
          rosterRes.ok ? rosterRes.value : null,
          currentSeed,
        );
        header = fromRoster ?? { ...seedHeader(currentSeed), canManage: false };
      }

      if (ownersRes.ok) {
        const ownerLabel = ownerLabelFromPayload(ownersRes.value);
        const manage =
          header.canManage ||
          isAdmin === true ||
          ownersIncludePerson(ownersRes.value, self?.uid);
        header = {
          ...header,
          ownerLabel: ownerLabel ?? header.ownerLabel,
          canManage: manage,
        };
      }

      nameDraft = header.displayName;
      descriptionDraft = header.description;

      if (jobsRes.ok) {
        jobsState = { status: "ready", value: jobsFromPayload(jobsRes.value) };
      } else {
        jobsState = {
          status: "unavailable",
          message: unavailableMessage(jobsRes, "jobs"),
        };
      }

      if (usageRes.ok) {
        const usage = usageFromCompanyTelemetry(usageRes.value, uid);
        usageState = {
          status: "ready",
          value:
            usage ?? {
              tokens: 0,
              sessions: 0,
              stories: 0,
              deploys: 0,
              outcomesPerMillion: null,
              dailyTokens: [],
              tokensByModel: [],
              topSkills: [],
              projects: [],
            },
        };
      } else {
        usageState = {
          status: "unavailable",
          message: unavailableMessage(usageRes, "usage"),
        };
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    panelEl?.focus();
  });

  $effect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Escape") return;
      if (confirm) {
        e.preventDefault();
        confirm = null;
        pendingJobId = null;
        return;
      }
      e.preventDefault();
      onclose?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function copyUid(): Promise<void> {
    try {
      await navigator.clipboard.writeText(header.uid);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      copied = false;
    }
  }

  async function saveProfile(): Promise<void> {
    if (!canManage || saveBusy) return;
    saveBusy = true;
    saveError = null;
    const patch: { displayName?: string; description?: string } = {};
    if (nameDraft.trim() !== header.displayName) {
      patch.displayName = nameDraft.trim();
    }
    if (descriptionDraft.trim() !== header.description) {
      patch.description = descriptionDraft.trim();
    }
    if (!patch.displayName && patch.description === undefined) {
      saveBusy = false;
      return;
    }
    const res = await adapter.agents.updateProfile(agentUid, patch);
    saveBusy = false;
    if (!res.ok) {
      saveError = res.message ?? "Could not save profile.";
      return;
    }
    header = {
      ...header,
      displayName: patch.displayName ?? header.displayName,
      description:
        patch.description !== undefined ? patch.description : header.description,
    };
  }

  async function pauseJob(jobId: string): Promise<void> {
    const res = await adapter.agents.pauseJob(agentUid, jobId);
    if (!res.ok) {
      actionError = res.message ?? "Could not pause the job.";
      return;
    }
    if (jobsState.status === "ready") {
      jobsState = {
        status: "ready",
        value: jobsState.value.map((job) =>
          job.jobId === jobId
            ? { ...job, active: false, canPause: false }
            : job,
        ),
      };
    }
  }

  async function pauseAgent(): Promise<void> {
    const res = await adapter.agents.stop(agentUid);
    if (!res.ok) {
      actionError = res.message ?? "Could not pause the agent.";
      return;
    }
    header = { ...header, status: "IDLE", runtimeStatus: "stopped" };
  }

  async function removeAgent(): Promise<void> {
    const res = await adapter.agents.deprovision(agentUid);
    if (!res.ok) {
      actionError = res.message ?? "Could not remove the agent.";
      return;
    }
    onclose?.();
  }

  function sparkHeight(value: number, max: number): number {
    if (max <= 0) return 8;
    return Math.max(8, Math.round((value / max) * 100));
  }

  const dailyMax = $derived(
    usageState.status === "ready"
      ? Math.max(0, ...usageState.value.dailyTokens)
      : 0,
  );
</script>

<aside
  bind:this={panelEl}
  class="agent-panel"
  aria-label={`${header.displayName} agent`}
  data-testid="agent-detail-panel"
  tabindex="-1"
>
  <header class="ad-head">
    <span class="ad-title">Agent</span>
    <button
      type="button"
      class="ad-close"
      data-testid="agent-detail-close"
      aria-label="Close agent"
      onclick={() => onclose?.()}
    >
      ×
    </button>
  </header>

  <div class="ad-body">
    <div class="ad-identity">
      <IdentityMark
        kind="agent"
        label={header.displayName}
        agentUid={header.uid}
        avatarUrl={header.avatarUrl}
        size="regular"
      />
      <div class="ad-identity-copy">
        <h2 class="ad-name" data-testid="agent-detail-name">{header.displayName}</h2>
        <p class="ad-status" data-testid="agent-detail-status">
          AGENT · {header.status}
        </p>
      </div>
    </div>

    {#if header.description}
      <p class="ad-desc" data-testid="agent-detail-description">
        {header.description}
      </p>
    {/if}

    <dl class="ad-meta">
      {#if header.ownerLabel}
        <div>
          <dt>Owner</dt>
          <dd data-testid="agent-detail-owner">{header.ownerLabel}</dd>
        </div>
      {/if}
      {#if header.companies.length > 0}
        <div>
          <dt>Company</dt>
          <dd data-testid="agent-detail-companies">
            {header.companies.join(", ")}
          </dd>
        </div>
      {/if}
      <div>
        <dt>UID</dt>
        <dd>
          <button
            type="button"
            class="ad-uid"
            data-testid="agent-detail-uid"
            title="Copy uid"
            onclick={() => void copyUid()}
          >
            {header.uid}
            <span class="ad-uid-hint">{copied ? "copied" : "copy"}</span>
          </button>
        </dd>
      </div>
    </dl>

    <section class="ad-section" data-testid="agent-detail-jobs">
      <h3 class="ad-kicker">
        Scheduled jobs{jobsState.status === "ready"
          ? ` (${jobsState.value.length})`
          : ""}
      </h3>
      {#if jobsState.status === "loading"}
        <p class="ad-muted">Loading jobs…</p>
      {:else if jobsState.status === "unavailable"}
        <p class="ad-muted" data-testid="agent-detail-jobs-unavailable">
          {jobsState.message}
        </p>
      {:else if jobsState.value.length === 0}
        <p class="ad-muted" data-testid="agent-detail-jobs-empty">
          No scheduled jobs.
        </p>
      {:else}
        <ul class="ad-jobs">
          {#each jobsState.value as job (job.jobId)}
            <li class="ad-job" data-testid="agent-detail-job-row">
              <button
                type="button"
                class="ad-job-toggle"
                aria-expanded={expandedJobId === job.jobId}
                onclick={() =>
                  (expandedJobId =
                    expandedJobId === job.jobId ? null : job.jobId)}
              >
                <span class="ad-job-title">{job.title}</span>
                <span class="ad-job-cadence">{job.cadence}</span>
                {#if job.runningFor}
                  <span class="ad-job-meta">{job.runningFor}</span>
                {/if}
                <span class="ad-job-meta">
                  {#if job.lastRan}
                    Last ran {job.lastRan}{#if job.lastOutcome}
                      · {job.lastOutcome}{/if}
                  {:else}
                    Never ran
                  {/if}
                </span>
              </button>
              <span
                class="ad-badge"
                data-active={job.active ? "true" : "false"}
                data-testid="agent-detail-job-badge"
              >
                {job.active ? "ACTIVE" : "PAUSED"}
              </span>
              {#if job.canPause && canManage}
                <button
                  type="button"
                  class="ad-text-btn"
                  data-testid="agent-detail-job-pause"
                  onclick={() => {
                    pendingJobId = job.jobId;
                    confirm = "pause-job";
                  }}
                >
                  Pause
                </button>
              {/if}
              {#if expandedJobId === job.jobId}
                <pre class="ad-prompt" data-testid="agent-detail-job-prompt"
                  >{job.prompt || "No prompt."}</pre
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="ad-section" data-testid="agent-detail-usage">
      <h3 class="ad-kicker">Agent · 30d usage</h3>
      {#if usageState.status === "loading"}
        <p class="ad-muted">Loading usage…</p>
      {:else if usageState.status === "unavailable"}
        <p class="ad-muted" data-testid="agent-detail-usage-unavailable">
          {usageState.message}
        </p>
      {:else}
        {@const usage = usageState.value}
        <dl class="ad-stats">
          <div>
            <dt>Tokens</dt>
            <dd data-testid="agent-detail-usage-tokens">
              {formatTokenCount(usage.tokens)}
            </dd>
          </div>
          <div>
            <dt>Sessions</dt>
            <dd>{usage.sessions ?? "—"}</dd>
          </div>
          <div>
            <dt>Stories</dt>
            <dd>{usage.stories ?? "—"}</dd>
          </div>
          <div>
            <dt>Deploys</dt>
            <dd>{usage.deploys ?? "—"}</dd>
          </div>
          <div class="ad-stat-wide">
            <dt>Outcomes / 1M tokens</dt>
            <dd>
              {usage.outcomesPerMillion == null
                ? "—"
                : usage.outcomesPerMillion.toFixed(1)}
            </dd>
          </div>
        </dl>
        {#if usage.dailyTokens.length > 0}
          <div
            class="ad-spark"
            data-testid="agent-detail-usage-spark"
            aria-hidden="true"
          >
            {#each usage.dailyTokens as value, i (i)}
              <span style={`height:${sparkHeight(value, dailyMax)}%`}></span>
            {/each}
          </div>
        {/if}
        {#if usage.tokensByModel.length > 0}
          <h4 class="ad-sub">Tokens by model</h4>
          <ul class="ad-models">
            {#each usage.tokensByModel as model (model.model)}
              <li>
                <span class="ad-model-name">{model.model}</span>
                <span class="ad-bar" aria-hidden="true"
                  ><i style={`width:${model.pct}%`}></i></span
                >
                <span class="ad-model-n">{formatTokenCount(model.tokens)}</span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if usage.topSkills.length > 0}
          <h4 class="ad-sub">Top skills</h4>
          <div class="ad-chips">
            {#each usage.topSkills as skill (skill.skill)}
              <span>{skill.skill} {skill.count}</span>
            {/each}
          </div>
        {/if}
        {#if usage.projects.length > 0}
          <h4 class="ad-sub">Projects</h4>
          <div class="ad-chips">
            {#each usage.projects as project (project)}
              <span>{project}</span>
            {/each}
          </div>
        {/if}
      {/if}
    </section>

    {#if canManage}
      <section class="ad-section" data-testid="agent-detail-settings">
        <h3 class="ad-kicker">Settings</h3>
        <label class="ad-field">
          <span>Display name</span>
          <input
            data-testid="agent-detail-name-input"
            bind:value={nameDraft}
            maxlength="35"
          />
        </label>
        <label class="ad-field">
          <span>Description</span>
          <textarea
            data-testid="agent-detail-description-input"
            bind:value={descriptionDraft}
            maxlength="140"
            rows="3"
          ></textarea>
        </label>
        <AvatarPickerSlot
          agentUid={header.uid}
          displayName={header.displayName}
          avatarUrl={header.avatarUrl}
        />
        {#if header.modelLabel || header.provider}
          <p class="ad-muted" data-testid="agent-detail-model">
            {#if header.provider}{header.provider}{/if}
            {#if header.modelLabel}· {header.modelLabel}{/if}
            <span class="ad-note">read-only</span>
          </p>
        {/if}
        {#if saveError}
          <p class="ad-error">{saveError}</p>
        {/if}
        <button
          type="button"
          class="ad-btn"
          data-testid="agent-detail-save"
          disabled={saveBusy}
          onclick={() => void saveProfile()}
        >
          {saveBusy ? "Saving…" : "Save"}
        </button>
        <div class="ad-danger-row">
          <button
            type="button"
            class="ad-text-btn"
            data-testid="agent-detail-pause-agent"
            onclick={() => (confirm = "pause-agent")}
          >
            Pause agent
          </button>
          <button
            type="button"
            class="ad-text-btn danger"
            data-testid="agent-detail-remove"
            onclick={() => (confirm = "remove-agent")}
          >
            Remove from company
          </button>
        </div>
      </section>
    {/if}

    {#if actionError}
      <p class="ad-error" data-testid="agent-detail-action-error">{actionError}</p>
    {/if}
  </div>
</aside>

<ConfirmDialog
  open={confirm === "pause-job"}
  title="Pause this job?"
  message="The schedule stays on the agent but will not fire until it is resumed from the box."
  confirmLabel="Pause job"
  onconfirm={() => {
    const id = pendingJobId;
    confirm = null;
    pendingJobId = null;
    if (id) void pauseJob(id);
  }}
  oncancel={() => {
    confirm = null;
    pendingJobId = null;
  }}
/>

<ConfirmDialog
  open={confirm === "pause-agent"}
  title="Pause this agent?"
  message="Stops the agent's box. Scheduled jobs will not run while it is stopped."
  confirmLabel="Pause agent"
  onconfirm={() => {
    confirm = null;
    void pauseAgent();
  }}
  oncancel={() => (confirm = null)}
/>

<ConfirmDialog
  open={confirm === "remove-agent"}
  title="Remove this agent?"
  message="This deprovisions the agent from the company. This cannot be undone from the desktop."
  confirmLabel="Remove"
  danger
  onconfirm={() => {
    confirm = null;
    void removeAgent();
  }}
  oncancel={() => (confirm = null)}
/>

<style>
  .agent-panel {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    background: var(--v4-ground, #161618);
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui);
    outline: none;
  }

  .ad-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 0 auto;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line);
  }

  .ad-title {
    color: var(--t1);
    font-size: 13px;
    font-weight: 600;
  }

  .ad-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .ad-close:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .ad-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px 16px 28px;
  }

  .ad-identity {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .ad-identity-copy {
    min-width: 0;
  }

  .ad-name {
    margin: 0;
    color: var(--t1);
    font-size: 16px;
    font-weight: 650;
    line-height: 1.3;
  }

  .ad-status {
    margin: 2px 0 0;
    color: var(--t3);
    font: 500 10px/1.3 var(--font-mono, ui-monospace, Menlo, monospace);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .ad-desc {
    margin: 0;
    color: var(--t2);
    font-size: 13px;
    line-height: 1.45;
  }

  .ad-meta,
  .ad-stats {
    display: grid;
    gap: 8px;
    margin: 0;
  }

  .ad-meta div,
  .ad-stats div {
    min-width: 0;
  }

  .ad-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ad-stat-wide {
    grid-column: 1 / -1;
  }

  .ad-meta dt,
  .ad-stats dt,
  .ad-kicker,
  .ad-sub,
  .ad-field span {
    color: var(--t3);
    font: 500 10px/1.2 var(--font-mono, ui-monospace, Menlo, monospace);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .ad-meta dd,
  .ad-stats dd {
    margin: 2px 0 0;
    color: var(--t1);
    font-size: 13px;
  }

  .ad-uid {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: 500 11px/1.3 var(--font-mono, ui-monospace, Menlo, monospace);
    cursor: pointer;
  }

  .ad-uid-hint {
    color: var(--t3);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .ad-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }

  .ad-kicker {
    margin: 0;
  }

  .ad-sub {
    margin: 6px 0 0;
  }

  .ad-muted,
  .ad-note {
    margin: 0;
    color: var(--t3);
    font-size: 12px;
  }

  .ad-jobs {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ad-job {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 8px;
    align-items: start;
  }

  .ad-job-toggle {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .ad-job-title {
    color: var(--t1);
    font-size: 13px;
    font-weight: 550;
  }

  .ad-job-cadence,
  .ad-job-meta {
    color: var(--t3);
    font-size: 12px;
  }

  .ad-badge {
    justify-self: end;
    color: var(--t3);
    font: 500 9px/1 var(--font-mono, ui-monospace, Menlo, monospace);
    letter-spacing: 0.08em;
  }

  .ad-prompt {
    grid-column: 1 / -1;
    margin: 4px 0 0;
    padding: 8px 0 0;
    border-top: 1px solid var(--line);
    color: var(--t2);
    font: 400 12px/1.45 var(--font-mono, ui-monospace, Menlo, monospace);
    white-space: pre-wrap;
  }

  .ad-spark {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 28px;
  }

  .ad-spark span {
    flex: 1 1 0;
    min-width: 2px;
    background: color-mix(in srgb, var(--t1) 35%, transparent);
  }

  .ad-models {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ad-models li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 72px 40px;
    gap: 8px;
    align-items: center;
  }

  .ad-model-name {
    overflow: hidden;
    color: var(--t2);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ad-bar {
    display: block;
    height: 4px;
    overflow: hidden;
    background: color-mix(in srgb, var(--t1) 10%, transparent);
  }

  .ad-bar i {
    display: block;
    height: 100%;
    background: color-mix(in srgb, var(--t1) 45%, transparent);
  }

  .ad-model-n {
    color: var(--t3);
    font-size: 11px;
    text-align: right;
  }

  .ad-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .ad-chips span {
    color: var(--t2);
    font-size: 12px;
  }

  .ad-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ad-field input,
  .ad-field textarea {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
  }

  .ad-btn,
  .ad-text-btn {
    appearance: none;
    -webkit-appearance: none;
    padding: 6px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .ad-btn {
    align-self: flex-start;
    border-color: var(--line);
  }

  .ad-text-btn {
    padding: 4px 0;
    color: var(--t2);
  }

  .ad-text-btn.danger {
    color: var(--t2);
  }

  .ad-danger-row {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .ad-error {
    margin: 0;
    color: var(--t2);
    font-size: 12px;
  }

  .ad-close:focus-visible,
  .ad-uid:focus-visible,
  .ad-job-toggle:focus-visible,
  .ad-btn:focus-visible,
  .ad-text-btn:focus-visible,
  .ad-field input:focus-visible,
  .ad-field textarea:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
  }
</style>
