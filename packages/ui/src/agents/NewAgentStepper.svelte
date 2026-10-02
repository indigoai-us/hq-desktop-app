<script lang="ts">
  /**
   * New agent sheet: Runtime, Identity, Membership, Access, Capabilities, Verify.
   * Paints from the draft immediately. Probe lines stream after the host
   * create returns. Enroll tokens are never rendered.
   */
  import type { LocalBotCreateInput } from "@hq/platform";
  import type { CloudBotDraft } from "../chat/lifecycle-entry-points.js";
  import type { CreateBotExtras } from "../chat/create-bot/CreateBotFlow.svelte";
  import FolderPicker from "./FolderPicker.svelte";
  import SkillPicker from "./SkillPicker.svelte";
  import {
    AGENT_STEPS,
    STEP_COPY,
    accessSummary,
    canContinue,
    continueLabel,
    displayHandle,
    emptyDraft,
    enrollPlaceholder,
    identityIssue,
    membershipIssue,
    nextAgentStep,
    prevAgentStep,
    probeScript,
    redactProbeText,
    runtimeSummary,
    setGrant,
    stepIndex,
    stepSubtitle,
    subcopy,
    toCloudDraft,
    toLocalInput,
    type AgentPlace,
    type AgentStep,
    type AgentStepperDraft,
    type BoxSize,
    type ModelChoice,
    type SlackPostMode,
  } from "./agent-stepper-model.js";

  interface CompanySeed {
    id: string;
    label: string;
    detail?: string;
  }

  interface Props {
    companyLabel?: string;
    ownerLabel?: string;
    companies?: readonly CompanySeed[];
    existingNames?: readonly string[];
    draft?: AgentStepperDraft | null;
    /** Sync the probe in tests so the reply line is present after one tick. */
    instantProbe?: boolean;
    oncancel?: () => void;
    oncreate?: ((input: LocalBotCreateInput, extras: CreateBotExtras) => void | Promise<unknown>) | null;
    onCloudCreate?: ((companyId: string, draft: CloudBotDraft) => void | Promise<unknown>) | null;
    ondone?: (draft: AgentStepperDraft) => void;
  }

  let {
    companyLabel = "Company",
    ownerLabel = "You",
    companies = [],
    existingNames = [],
    draft = null,
    instantProbe = false,
    oncancel,
    oncreate = null,
    onCloudCreate = null,
    ondone,
  }: Props = $props();

  const SIZES: BoxSize[] = ["basic", "power", "dev"];
  const REGIONS = ["us-east-1", "eu-west-1"];
  const MODELS: ModelChoice[] = ["haiku", "sonnet", "opus"];

  function seed(): AgentStepperDraft {
    if (draft) return structuredClone(draft);
    const base = emptyDraft({ ownerLabel });
    base.companies = companies.map((company, index) => ({
      id: company.id,
      label: company.label,
      detail: company.detail ?? "",
      joined: index === 0,
      role: "member" as const,
    }));
    if (base.companies.length === 0) {
      base.companies = [{ id: "company", label: companyLabel, detail: "", joined: true, role: "member" }];
    }
    base.skills = [
      { id: "standup-brief", title: "standup-brief", detail: "Build and deploy the standup brief", selected: false },
      { id: "meeting-prep", title: "meeting-prep", detail: "Pre-read for a calendar event", selected: false },
      { id: "signals", title: "signals", detail: "Action items and decisions, read-only", selected: false },
    ];
    base.tools = [
      { id: "claude", title: "Claude Code", detail: "Runs in its own box", selected: true },
      { id: "browser", title: "Browser", detail: "Headless, allowlisted domains only", selected: false },
      { id: "slack", title: "Slack post", detail: "Can write to joined channels", selected: true, slack: true },
    ];
    return base;
  }

  let form: AgentStepperDraft = $state(seed());
  let step = $state("runtime" as AgentStep);
  let savedLabel = $state("draft not saved yet");
  let picker: "skills" | "folders" | null = $state(null);
  let error: string | null = $state(null);
  let busy = $state(false);

  const handle = $derived(displayHandle(form));
  const issue = $derived(
    step === "identity" ? identityIssue(form, existingNames) : step === "membership" ? membershipIssue(form) : null,
  );
  const folderChoices = $derived(form.grants.map((grant) => ({ path: grant.path, note: grant.note })));

  function touch() {
    savedLabel = "draft saved just now";
  }

  function pickPlace(place: AgentPlace) {
    form.place = place;
    form.probe = [];
    form.probeStatus = "idle";
    touch();
  }

  function go(next: AgentStep) {
    step = next;
    error = null;
  }

  async function forward() {
    if (!canContinue(step, form, existingNames)) return;
    if (step === "capabilities") {
      await runProbe();
      return;
    }
    if (step === "verify") {
      ondone?.(form);
      return;
    }
    const next = nextAgentStep(step);
    if (next) go(next);
  }

  function back() {
    const prev = prevAgentStep(step);
    if (prev) go(prev);
  }

  async function runProbe() {
    error = null;
    busy = true;
    form.probeStatus = "running";
    form.probe = [];
    step = "verify";
    try {
      if (form.place === "local") {
        if (oncreate) await oncreate(toLocalInput(form, { canLocal: true, canCloud: false, existingNames, companies: [], runtimeReady: null }), { title: form.description, displayName: form.name });
      } else if (form.place === "hosted") {
        const company = form.companies.find((row) => row.joined);
        if (onCloudCreate && company) await onCloudCreate(company.id, toCloudDraft(form));
      }
      const lines = probeScript(form, new Date()).map((line) => ({
        ...line,
        text: redactProbeText(line.text),
        ...(line.detail ? { detail: redactProbeText(line.detail) } : {}),
      }));
      if (instantProbe) {
        form.probe = lines;
      } else {
        for (const line of lines) {
          form.probe = [...form.probe, line];
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      form.probeStatus = "passed";
      savedLabel = "provisioned";
    } catch (err) {
      form.probeStatus = "failed";
      error = err instanceof Error ? err.message : "The probe did not finish.";
    } finally {
      busy = false;
    }
  }

  function addPath(path: string) {
    const clean = path.trim();
    if (!clean || form.grants.some((grant) => grant.path === clean)) {
      picker = null;
      return;
    }
    form.grants = [...form.grants, { path: clean, note: "Added from the vault", read: true, write: false }];
    picker = null;
    touch();
  }
</script>

<section class="nas" data-testid="new-agent-stepper" aria-label="New agent">
  <div class="nas-bar">
    <div class="nas-crumb">
      <b>New agent</b>
      <span>in {companyLabel} · step {stepIndex(step) + 1} of 6 · {savedLabel}</span>
    </div>
    <button type="button" class="nas-link" onclick={touch}>Save draft</button>
    <button type="button" data-testid="new-agent-cancel" onclick={() => oncancel?.()}>Cancel</button>
  </div>

  <div class="nas-sheet">
    <nav class="nas-steps" aria-label="Steps">
      {#each AGENT_STEPS as id, index (id)}
        {@const done = stepIndex(id) < stepIndex(step)}
        <button
          type="button"
          class="nas-step"
          class:done
          aria-current={id === step ? "step" : undefined}
          onclick={() => {
            if (done || id === step) go(id);
          }}
        >
          <span class="nas-mk">{done ? "✓" : index + 1}</span>
          <span>{STEP_COPY[id].title}<span class="nas-sm">{stepSubtitle(id, form, step)}</span></span>
        </button>
      {/each}
    </nav>

    <div class="nas-form">
      <h2>{STEP_COPY[step].heading}</h2>
      <p class="nas-sub">{subcopy(step, form.name)}</p>
      <div class="nas-body">
        {#if step === "runtime"}
          <div class="nas-sec">Where it runs</div>
          <button type="button" class="nas-choice" aria-pressed={form.place === "local"} data-testid="new-agent-place-local" onclick={() => pickPlace("local")}>
            <span>Local on this Mac</span>
            <small>Uses hq bot with your own model login · runs while HQ Desktop runs · no seat charge</small>
            <em>Free</em>
          </button>
          <button type="button" class="nas-choice" aria-pressed={form.place === "hosted"} data-testid="new-agent-place-hosted" onclick={() => pickPlace("hosted")}>
            <span>Hosted fleet agent</span>
            <small>Always-on HQ Workforce seat · its own identity and box · billed to {companyLabel}</small>
            <em>Seat</em>
          </button>
          {#if form.place === "hosted"}
            <div class="nas-seg-row" data-testid="new-agent-box">
              <span>Box size</span>
              <div class="nas-seg" role="radiogroup" aria-label="Box size">
                {#each SIZES as size (size)}
                  <button type="button" aria-pressed={form.size === size} data-testid={`new-agent-size-${size}`} onclick={() => { form.size = size; touch(); }}>{size[0]!.toUpperCase()}{size.slice(1)}</button>
                {/each}
              </div>
              <span>Region</span>
              <div class="nas-seg" role="radiogroup" aria-label="Region">
                {#each REGIONS as region (region)}
                  <button type="button" aria-pressed={form.region === region} data-testid={`new-agent-region-${region}`} onclick={() => { form.region = region; touch(); }}>{region}</button>
                {/each}
              </div>
            </div>
          {/if}
          <button type="button" class="nas-choice" aria-pressed={form.place === "external"} data-testid="new-agent-place-external" onclick={() => pickPlace("external")}>
            <span>External bot</span>
            <small>An agent you already run elsewhere (OpenClaw, Muse, any MCP agent) · enroll it with a one-time code on its host</small>
            <em data-testid="new-agent-paid-chip">Paid plans</em>
          </button>
          {#if form.place === "external"}
            <p class="nas-hint" data-testid="new-agent-enroll-mask">Enroll code {enrollPlaceholder()}</p>
          {/if}
        {:else if step === "identity"}
          <label class="nas-field">Name
            <input data-testid="new-agent-name" bind:value={form.name} oninput={touch} />
          </label>
          <label class="nas-field">Handle
            <input data-testid="new-agent-handle" value={form.handle ? `@${form.handle.replace(/^@/, "")}` : handle ? `@${handle}` : ""} oninput={(event) => { form.handle = event.currentTarget.value.replace(/^@/, ""); touch(); }} />
          </label>
          <p class="nas-hint">Mail {handle || "name"}@{companyLabel.toLowerCase().replace(/\s+/g, "")}.hq.ai · mentions resolve to @{handle || "handle"}</p>
          <p class="nas-hint">Mark: initials on a rounded square. Bots never use a person circle.</p>
          <p class="nas-hint">Owner {ownerLabel}. The owner approves the seat charge and can pause or remove it.</p>
          <label class="nas-field">Description
            <textarea data-testid="new-agent-description" bind:value={form.description} oninput={touch}></textarea>
          </label>
          <label class="nas-field">How it introduces itself
            <textarea bind:value={form.intro} oninput={touch}></textarea>
          </label>
        {:else if step === "membership"}
          <div class="nas-sec">Companies <span>{form.companies.filter((row) => row.joined).length} of {form.companies.length}</span></div>
          {#each form.companies as company (company.id)}
            <div class="nas-row">
              <button type="button" aria-pressed={company.joined} disabled={company.detail === "locked"} onclick={() => { company.joined = !company.joined; touch(); }}>{company.label}</button>
              {#if company.joined}
                <div class="nas-seg">
                  <button type="button" aria-pressed={company.role === "member"} onclick={() => { company.role = "member"; touch(); }}>Member</button>
                  <button type="button" aria-pressed={company.role === "guest"} onclick={() => { company.role = "guest"; touch(); }}>Guest</button>
                </div>
              {/if}
            </div>
          {/each}
          <div class="nas-sec">Channels to join</div>
          {#each form.channels as channel (channel.id)}
            <button type="button" class="nas-row" aria-pressed={channel.joined} disabled={channel.locked} onclick={() => { channel.joined = !channel.joined; touch(); }}>
              {channel.label}
              {#if channel.locked}<em>locked</em>{/if}
            </button>
          {/each}
          {#if form.channels.length === 0}
            <p class="nas-hint">No channels are cached yet. Join them from the agent profile after Verify.</p>
          {/if}
        {:else if step === "access"}
          <div class="nas-sec">Vault grants <span>{form.grants.length} paths</span></div>
          {#each form.grants as grant (grant.path)}
            <div class="nas-row" data-testid="new-agent-grant">
              <span class="nas-path">{grant.path}</span>
              <button type="button" aria-pressed={grant.read} data-testid="new-agent-grant-read" onclick={() => { const next = setGrant(grant, "read", !grant.read); grant.read = next.read; grant.write = next.write; touch(); }}>read</button>
              <button type="button" aria-pressed={grant.write} data-testid="new-agent-grant-write" onclick={() => { const next = setGrant(grant, "write", !grant.write); grant.read = next.read; grant.write = next.write; touch(); }}>write</button>
            </div>
          {/each}
          <button type="button" data-testid="new-agent-add-path" onclick={() => (picker = "folders")}>Add a path… Browse vault</button>
          <div class="nas-sec">Secrets allowlist <span>{form.secrets.filter((row) => row.granted).length} granted</span></div>
          {#each form.secrets as secret (secret.name)}
            <div class="nas-row">
              <span>{secret.name}</span>
              {#if secret.blocked}
                <em>blocked</em>
              {:else}
                <button type="button" aria-pressed={secret.granted} onclick={() => { secret.granted = !secret.granted; touch(); }}>read</button>
              {/if}
            </div>
          {/each}
          <p class="nas-hint">Secret values are mounted per run with hq secrets exec, never shown in chat.</p>
        {:else if step === "capabilities"}
          <div class="nas-sec">Skills <span>{form.skills.filter((row) => row.selected).length} selected</span></div>
          {#each form.skills as skill (skill.id)}
            <button type="button" class="nas-row" aria-pressed={skill.selected} disabled={skill.blocked} onclick={() => { skill.selected = !skill.selected; touch(); }}>
              {skill.title}
              {#if skill.blocked}<em>blocked by Access</em>{/if}
            </button>
          {/each}
          <button type="button" data-testid="new-agent-open-skills" onclick={() => (picker = "skills")}>Browse skills</button>
          <div class="nas-sec">Tools</div>
          {#each form.tools as tool (tool.id)}
            <div class="nas-row">
              <button type="button" aria-pressed={tool.selected} onclick={() => { tool.selected = !tool.selected; touch(); }}>{tool.title}</button>
              {#if tool.slack}
                <div class="nas-seg" aria-label="Slack post">
                  {#each ["ask", "auto", "off"] as mode (mode)}
                    <button type="button" aria-pressed={form.slackPost === mode} onclick={() => { form.slackPost = mode as SlackPostMode; touch(); }}>{mode === "ask" ? "Ask first" : mode === "auto" ? "Auto" : "Off"}</button>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
          <div class="nas-sec">Model and budget</div>
          <div class="nas-seg" aria-label="Model">
            {#each MODELS as model (model)}
              <button type="button" aria-pressed={form.model === model} onclick={() => { form.model = model; touch(); }}>{model[0]!.toUpperCase()}{model.slice(1)}</button>
            {/each}
          </div>
          <label class="nas-field">Budget per day
            <input bind:value={form.budgetPerDay} oninput={touch} />
          </label>
        {:else}
          <div class="nas-sec">Probe log {#if form.probeStatus === "running"}<span>running</span>{:else if form.probeStatus === "passed"}<span>finished</span>{/if}</div>
          {#if form.probe.length === 0}
            <div class="nas-skel" data-testid="new-agent-probe-skeleton" aria-hidden="true"></div>
          {/if}
          <ol class="nas-log" data-testid="new-agent-probe-log">
            {#each form.probe as line (`${line.at}-${line.text}`)}
              <li>{line.at} {line.ok ? "✓" : "✕"} {line.text}{#if line.detail} {line.detail}{/if}</li>
            {/each}
          </ol>
          {#if form.probe.some((line) => line.text === "reply received")}
            <p data-testid="new-agent-reply-received">reply received</p>
          {/if}
        {/if}
        {#if issue}<p class="nas-error" role="alert">{issue}</p>{/if}
        {#if error}<p class="nas-error" role="alert" data-testid="new-agent-error">{error}</p>{/if}
        {#if picker === "skills"}
          <SkillPicker
            skills={form.skills}
            selected={form.skills.filter((row) => row.selected).map((row) => row.id)}
            ontoggle={(id) => {
              const skill = form.skills.find((row) => row.id === id);
              if (skill && !skill.blocked) skill.selected = !skill.selected;
              touch();
            }}
            onclose={() => (picker = null)}
          />
        {:else if picker === "folders"}
          <FolderPicker
            folders={folderChoices.length > 0 ? folderChoices : [{ path: `companies/${companyLabel.toLowerCase()}/knowledge/`, note: "read" }]}
            onchoose={addPath}
            onclose={() => (picker = null)}
          />
        {/if}
      </div>
      <footer class="nas-foot">
        <span class="nas-hint">
          {#if step === "runtime"}A hosted seat is a recurring charge on the {companyLabel} payer. The exact number comes from the CLI quote at Verify, never from this sheet.{:else if step === "access"}Nothing is granted until Verify passes. Secret values are mounted per run with hq secrets exec, never shown in chat.{:else if step === "verify"}Re-run any time with hq agent probe. The enroll code is never shown.{:else if step === "identity"}The identity is minted at Verify. Until then this is a draft on this Mac.{:else if step === "membership"}Joining a channel posts its introduction there once. It never reads a channel it has not joined.{:else}Tools run inside its box with only the secrets from Access. Slack posts outside joined channels always ask.{/if}
        </span>
        <button type="button" data-testid="new-agent-back" disabled={!prevAgentStep(step) || busy} onclick={back}>Back</button>
        <button type="button" class="nas-primary" data-testid="new-agent-next" disabled={busy || !canContinue(step, form, existingNames)} onclick={() => void forward()}>{continueLabel(step)}</button>
      </footer>
    </div>

    <aside class="nas-sum" aria-label="Summary">
      <strong>{form.name.trim() || "New agent"}</strong>
      <p>@{handle || "handle"} · owned by {ownerLabel}</p>
      {#each AGENT_STEPS as id (id)}
        {@const done = stepIndex(id) < stepIndex(step)}
        {@const current = id === step}
        <div class="nas-sumi" class:todo={!done && !current}>
          <div class="nas-sumk">{STEP_COPY[id].title} {#if done}<span>done</span>{:else if current}<span>editing</span>{/if}</div>
          <p>
            {#if done || current}
              {#if id === "runtime"}{runtimeSummary(form)}
              {:else if id === "identity"}{form.name.trim() || "In progress"}{#if handle} · @{handle}{/if}
              {:else if id === "membership"}{form.companies.find((row) => row.joined)?.label ?? "In progress"}
              {:else if id === "access"}{accessSummary(form)}
              {:else if id === "capabilities"}{form.skills.filter((row) => row.selected).length} skills · {form.model}
              {:else if form.probeStatus === "passed"}Probe passed · reply received
              {:else}In progress
              {/if}
            {:else if id === "verify"}Probe runs after Capabilities
            {:else}Not set
            {/if}
          </p>
        </div>
      {/each}
      {#if form.probeStatus === "passed"}<p data-testid="new-agent-verified">Verified · reply received</p>{/if}
    </aside>
  </div>
</section>

<style>
  .nas {
    /* The stepper sizes to its host: a 480 px sheet or a full page. */
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    color: var(--v4-text-1, inherit);
    font-family: var(--font-ui, inherit);
    background: transparent;
  }
  .nas-bar, .nas-foot { display: flex; align-items: center; gap: 8px; }
  .nas-crumb { flex: 1; min-width: 0; }
  .nas-crumb span, .nas-hint, .nas-sm, .nas-sub { color: var(--v4-text-3, inherit); font-size: var(--type-metadata, 12px); }
  .nas-sub { margin: 0 0 12px; font-size: var(--type-secondary, 14px); }
  .nas button, .nas input, .nas textarea {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid var(--v4-control-border, transparent);
    border-radius: 8px;
  }
  .nas-link { border: 0; color: var(--v4-text-2, inherit); }
  .nas-sheet {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr) 220px;
    background: var(--v4-raised, transparent);
    border: 1px solid var(--v4-hairline, transparent);
    border-radius: var(--v4-radius-popover, 12px);
    overflow: hidden;
  }
  .nas-steps, .nas-sum { padding: 16px 12px; overflow: auto; }
  .nas-steps { border-right: 1px solid var(--v4-rowline, transparent); }
  .nas-sum { border-left: 1px solid var(--v4-rowline, transparent); background: var(--v4-secondary-sidebar, transparent); }
  .nas-sumi { padding: 8px 0; border-bottom: 1px solid var(--v4-rowline, transparent); }
  .nas-sumi p { margin: 2px 0 0; font-size: var(--type-metadata, 12px); }
  .nas-sumk { font-size: 12px; display: flex; gap: 8px; }
  .nas-sumk span { margin-left: auto; color: var(--v4-text-3, inherit); }
  .nas-sumi.todo { color: var(--v4-text-3, inherit); }
  .nas-step {
    display: grid;
    grid-template-columns: 16px 1fr;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: 0;
    padding: 7px 8px;
    color: var(--v4-text-3, inherit);
  }
  .nas-step[aria-current="step"] { background: var(--v4-active-row, transparent); color: var(--v4-text-1, inherit); }
  .nas-sm { display: block; }
  .nas-form { min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; padding: 18px 20px 14px; }
  .nas-form h2 { margin: 0; font-size: var(--type-section, 18px); }
  .nas-body { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
  .nas-choice, .nas-row {
    display: flex;
    gap: 8px;
    align-items: center;
    text-align: left;
    padding: 8px;
    border-bottom: 1px solid var(--v4-rowline, transparent);
  }
  .nas-choice { flex-wrap: wrap; }
  .nas-choice[aria-pressed="true"], .nas-row[aria-pressed="true"], .nas-seg button[aria-pressed="true"] {
    background: var(--v4-active-row, transparent);
  }
  .nas-choice small { flex: 1 0 100%; color: var(--v4-text-3, inherit); }
  .nas-choice em { margin-left: auto; font-style: normal; font-size: 12px; }
  .nas-seg, .nas-seg-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .nas-field { display: flex; flex-direction: column; gap: 4px; font-size: var(--type-secondary, 14px); }
  .nas-field input, .nas-field textarea { padding: 6px 8px; }
  .nas-sec { display: flex; gap: 8px; font-size: 12px; color: var(--v4-text-2, inherit); padding-top: 8px; }
  .nas-sec span { margin-left: auto; }
  .nas-path { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
  .nas-log { margin: 0; padding-left: 18px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
  .nas-skel { height: 72px; border-radius: 8px; background: var(--v4-active-row, transparent); }
  .nas-foot { padding-top: 12px; border-top: 1px solid var(--v4-rowline, transparent); }
  .nas-foot .nas-hint { flex: 1; }
  .nas-primary { background: var(--v4-active-row, transparent); }
  .nas-error { color: var(--v4-error, inherit); margin: 0; }
  /* Narrow host (the 480 px sheet): one column, form first, and the sheet
     scrolls so the summary never covers the footer buttons. */
  @container (max-width: 800px) {
    .nas-sheet { grid-template-columns: minmax(0, 1fr); overflow: auto; }
    .nas-form { order: -1; }
    .nas-steps, .nas-sum { border: 0; }
  }
</style>
