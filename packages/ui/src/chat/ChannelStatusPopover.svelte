<script lang="ts">
  /**
   * ChannelStatusPopover (US-005) — opened from the channel-header member pill.
   *
   * Renders the pure ChannelStatusModel (channel-status-model.ts): live agent
   * rows with a progress bar, the story rollup, PROJECT metadata (branch / repo
   * / preview), and the MEMBERS + AGENTS rosters as avatar rows. Fixture-driven
   * and zero-network — the model is injected by the shell.
   *
   * Design source: hq-desktop-preview-v2 ?view=v2 members popover.
   */
  import type {
    ChannelStatusModel,
    StatusPersonRow,
  } from "./channel-status-model.js";
  import { projectReposForDisplay } from "./channel-status-model.js";
  import { isSelf, type SelfIdentity } from "../identity/self.js";
  import "./tokens.css";
  import "./chat-tokens.css";

  interface Props {
    model: ChannelStatusModel;
    /** Verified signed-in principal — tags the matching member roster row "you". */
    self?: SelfIdentity | null;
    onclose?: () => void;
    /** Open the preview URL externally (host seam). */
    onopenurl?: (url: string) => void;
    /** Open a member's profile panel (name click). */
    onopenprofile?: (row: StatusPersonRow) => void;
    /**
     * Remove a member from the channel. Only surfaced when the caller may act:
     * self-leave is always allowed; removing others requires channel ownership.
     */
    onremovemember?: (row: StatusPersonRow) => void;
    /** personUid currently mid-removal — disables its button + shows "…". */
    removingUid?: string | null;
    /**
     * Delete the whole channel (owner only). The popover only raises the
     * intent — the shell owns the confirm dialog + the call, because this
     * popover closes on any outside mousedown and would eat the dialog.
     */
    ondeletechannel?: () => void;
    /** Delete in flight — disables the trash control + shows "…". */
    deleting?: boolean;
    /**
     * Move a live session to another company (company owner/admin). Shell owns
     * the destination picker + confirm; popover only raises sessionId.
     */
    onmigratesession?: (sessionId: string) => void;
    /** Migrate in flight for a session id — disables that row's control. */
    migratingSessionId?: string | null;
  }

  let {
    model,
    self = null,
    onclose,
    onopenurl,
    onopenprofile,
    onremovemember,
    removingUid = null,
    ondeletechannel,
    deleting = false,
    onmigratesession,
    migratingSessionId = null,
  }: Props = $props();

  /** The signed-in member's role in this channel — gates removing others. */
  const selfIsOwner = $derived(
    model.members.some(
      (m) =>
        isSelf(m.personUid, self) && (m.role ?? "").toLowerCase() === "owner",
    ),
  );

  function canRemove(row: StatusPersonRow): boolean {
    if (!onremovemember) return false;
    // Server contract: self-leave always allowed; owner may remove others.
    return isSelf(row.personUid, self) || selfIsOwner;
  }

  let container: HTMLDivElement | null = $state(null);
  let repoIndex = $state(0);
  let selectedBranch = $state("");

  const repoGroups = $derived(projectReposForDisplay(model.project));
  const currentRepo = $derived(
    repoGroups.length === 0
      ? null
      : (repoGroups[Math.min(repoIndex, repoGroups.length - 1)] ?? null),
  );
  const currentBranches = $derived(currentRepo?.branches ?? []);
  const shownBranch = $derived(
    selectedBranch || currentBranches[0] || model.project.branch || null,
  );

  $effect(() => {
    const groups = projectReposForDisplay(model.project);
    if (repoIndex >= groups.length) repoIndex = 0;
    const branches = groups[repoIndex]?.branches ?? [];
    if (!selectedBranch || !branches.includes(selectedBranch)) {
      selectedBranch = branches[0] ?? "";
    }
  });

  function initialOf(name: string): string {
    const trimmed = (name ?? "").trim();
    return trimmed ? trimmed[0].toUpperCase() : "?";
  }

  function shortPreview(url: string): string {
    try {
      const u = new URL(url);
      return u.host.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  function shortRepo(path: string): string {
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || path;
  }

  function stepRepo(delta: number): void {
    if (repoGroups.length < 2) return;
    const next = (repoIndex + delta + repoGroups.length) % repoGroups.length;
    repoIndex = next;
    selectedBranch = repoGroups[next]?.branches[0] ?? "";
  }

  function onRepoClick(event: MouseEvent): void {
    if (repoGroups.length < 2) return;
    if (event.button === 2) {
      event.preventDefault();
      stepRepo(-1);
      return;
    }
    if (event.button === 0) stepRepo(1);
  }

  function onRepoContextMenu(event: MouseEvent): void {
    if (repoGroups.length < 2) return;
    event.preventDefault();
    stepRepo(-1);
  }

  const leadAgent = $derived(model.liveAgents[0] ?? null);
  const agentTitle = $derived(
    leadAgent
      ? leadAgent.status === "running" || leadAgent.status === "awaiting_input"
        ? "Agent running"
        : "Agent"
      : null,
  );
  const agentMeta = $derived.by(() => {
    if (!leadAgent) return "";
    const parts: string[] = [];
    if (leadAgent.storyId) parts.push(leadAgent.storyId);
    if (Number.isFinite(leadAgent.progressPercent)) {
      parts.push(`${leadAgent.progressPercent}%`);
    }
    return parts.join(" · ");
  });
  const storyMeta = $derived(
    `${model.stories.complete}/${model.stories.total} STORIES`,
  );
  /** The bar sits next to the story rollup — it is board completion, not the
   *  lead agent's in-story percent (that stays on the "Agent running" line). */
  const barPercent = $derived(model.stories.percent);
  const owners = $derived(
    model.members.filter((m) => (m.role ?? "").toLowerCase() === "owner"),
  );
  const otherMembers = $derived(
    model.members.filter((m) => (m.role ?? "").toLowerCase() !== "owner"),
  );
  const memberRows = $derived([...owners, ...otherMembers]);

  $effect(() => {
    function onMouseDown(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      if (container && !container.contains(event.target)) onclose?.();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onclose?.();
    }
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  });
</script>

<div
  class="status-popover"
  role="dialog"
  aria-label="Members and status"
  data-testid="channel-status-popover"
  bind:this={container}
>
  <section
    class="p-card"
    aria-label="Live agents"
    data-testid="status-live-agent"
  >
    {#if agentTitle}
      <div class="p-line head">
        <span
          class="dot"
          class:idle={!leadAgent || leadAgent.status === "idle"}
          aria-hidden="true"
        ></span>
        <span class="agent-title">{agentTitle}</span>
        {#if agentMeta}
          <span class="p-meta">{agentMeta}</span>
        {/if}
      </div>
    {/if}
    <div class="p-line">
      <span
        class="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={barPercent}
      >
        <span class="progress-fill" style={`width: ${barPercent}%`}></span>
      </span>
      <span class="p-meta" data-testid="status-story-rollup">{storyMeta}</span>
    </div>
  </section>

  <section aria-label="Project">
    <div class="p-sec">PROJECT</div>
    <div class="p-item kv static">
      <span class="k">Branch</span>
      {#if currentBranches.length > 1}
        <select
          class="status-branch-select"
          data-testid="status-branch-select"
          aria-label="Project branches"
          bind:value={selectedBranch}
        >
          {#each currentBranches as branch (branch)}
            <option value={branch}>{branch}</option>
          {/each}
        </select>
      {:else}
        <span class="val" data-testid="status-branch">{shownBranch ?? "—"}</span
        >
      {/if}
    </div>
    <div class="p-item kv static">
      <span class="k">Repo</span>
      <div
        class="status-repo"
        data-testid="status-repo-control"
        role="group"
        aria-label="Project repos"
      >
        {#if repoGroups.length > 1}
          <button
            type="button"
            class="status-repo-nav"
            data-testid="status-repo-prev"
            aria-label="Previous repo"
            onclick={() => stepRepo(-1)}
          >
            ‹
          </button>
        {/if}
        <button
          type="button"
          class="status-repo-name"
          class:cycle={repoGroups.length > 1}
          data-testid="status-repo-path"
          title={currentRepo?.path ?? ""}
          disabled={repoGroups.length <= 1}
          onclick={onRepoClick}
          oncontextmenu={onRepoContextMenu}
        >
          {currentRepo ? shortRepo(currentRepo.path) : "—"}
        </button>
        {#if repoGroups.length > 1}
          <button
            type="button"
            class="status-repo-nav"
            data-testid="status-repo-next"
            aria-label="Next repo"
            onclick={() => stepRepo(1)}
          >
            ›
          </button>
          <span class="status-repo-index" data-testid="status-repo-index"
            >{Math.min(repoIndex, repoGroups.length - 1) +
              1}/{repoGroups.length}</span
          >
        {/if}
      </div>
    </div>
    {#if model.project.previewUrl}
      <button
        type="button"
        class="p-item kv"
        data-testid="status-preview-link"
        onclick={() => onopenurl?.(model.project.previewUrl!)}
      >
        <span class="k">Preview</span>
        <span class="preview-link">
          {shortPreview(model.project.previewUrl)}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="11"
            height="11"
            fill="currentColor"
            viewBox="0 0 256 256"
            aria-hidden="true"
          >
            <path
              d="M204,64V168a12,12,0,0,1-24,0V93L72.49,200.49a12,12,0,0,1-17-17L163,76H88a12,12,0,0,1,0-24H192A12,12,0,0,1,204,64Z"
            ></path>
          </svg>
        </span>
      </button>
    {:else}
      <div class="p-item kv static">
        <span class="k">Preview</span>
        <span class="val">—</span>
      </div>
    {/if}
  </section>

  {#if model.activeSessions.length > 0}
    <section aria-label="Active sessions">
      <div class="p-sec">SESSIONS</div>
      {#each model.activeSessions as s (s.id)}
        <div
          class="p-item static session-row"
          data-testid="status-active-session"
          data-session-id={s.id}
        >
          <span
            class="m-ava"
            class:ai={s.principalKind === "agent"}
            aria-hidden="true"
          >
            {initialOf(s.principal)}
            {#if s.online}
              <span
                class="presence-dot"
                data-testid="status-presence-dot"
                aria-label="Online"
              ></span>
            {/if}
          </span>
          <span class="m-id">
            <span class="m-name">{s.principal}</span>
            {#if s.taskId || s.context || s.harness || s.turnCount != null}
              <span class="m-email">
                {[
                  s.taskId ?? s.context,
                  s.harness,
                  s.turnCount != null ? `${s.turnCount} turns` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            {/if}
            <span class="m-email">{s.lastActivityLabel}</span>
          </span>
          {#if onmigratesession}
            <button
              type="button"
              class="m-remove session-migrate"
              data-testid="status-session-migrate"
              aria-label="Move to another company"
              title="Move to another company"
              disabled={migratingSessionId === s.id}
              onclick={() => onmigratesession?.(s.id)}
            >
              {#if migratingSessionId === s.id}
                …
              {:else}
                Move
              {/if}
            </button>
          {/if}
        </div>
      {/each}
    </section>
  {/if}

  <section aria-label="Members">
    <div class="p-sec">MEMBERS</div>
    {#each memberRows as m (m.personUid)}
      <div class="p-item static member-row" data-testid="status-member">
        <button
          type="button"
          class="member-open"
          data-testid="status-member-open"
          title={`Open ${m.displayName}'s profile`}
          onclick={() => onopenprofile?.(m)}
        >
          <span class="m-ava" aria-hidden="true">
            {#if m.avatarUrl}
              <img
                class="m-ava-img"
                data-testid="status-member-avatar"
                src={m.avatarUrl}
                alt=""
                loading="lazy"
              />
            {:else}
              {initialOf(m.displayName)}
            {/if}
            {#if m.online}
              <span
                class="presence-dot"
                data-testid="status-presence-dot"
                aria-label="Online"
              ></span>
            {/if}
          </span>
          <span class="m-id">
            <span class="m-name">{m.displayName}</span>
            {#if m.email}
              <span class="m-email" data-testid="status-member-email"
                >{m.email}</span
              >
            {/if}
          </span>
        </button>
        {#if isSelf(m.personUid, self)}
          <span class="status-you" data-testid="status-member-you">you</span>
        {/if}
        {#if (m.role ?? "").toLowerCase() === "owner"}
          <span class="m-role" data-testid="status-member-role">owner</span>
        {/if}
        {#if canRemove(m)}
          <button
            type="button"
            class="m-remove"
            data-testid="status-member-remove"
            title={isSelf(m.personUid, self)
              ? "Leave channel"
              : `Remove ${m.displayName}`}
            aria-label={isSelf(m.personUid, self)
              ? "Leave channel"
              : `Remove ${m.displayName}`}
            disabled={removingUid === m.personUid}
            onclick={() => onremovemember?.(m)}
          >
            {removingUid === m.personUid ? "…" : "×"}
          </button>
        {/if}
      </div>
    {/each}
  </section>

  {#if model.agents.length > 0}
    <section aria-label="Agents">
      <div class="p-sec">AGENTS</div>
      {#each model.agents as a (a.personUid)}
        <div class="p-item static member-row" data-testid="status-agent">
          {#if onopenprofile}
            <button
              type="button"
              class="member-open"
              data-testid="status-agent-open"
              title={`View agent ${a.displayName}`}
              onclick={() => onopenprofile?.(a)}
            >
              <span class="m-ava ai" aria-hidden="true">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="11"
                  height="11"
                  fill="currentColor"
                  viewBox="0 0 256 256"
                >
                  <path
                    d="M230.92,212c-15.23-26.33-38.7-45.21-66.09-54.16a72,72,0,1,0-73.66,0C63.78,166.78,40.31,185.66,25.08,212a8,8,0,1,0,13.85,8c18.84-32.56,52.14-52,89.07-52s70.23,19.44,89.07,52a8,8,0,1,0,13.85-8ZM72,96a56,56,0,1,1,56,56A56.06,56.06,0,0,1,72,96Z"
                  ></path>
                </svg>
                {#if a.online}
                  <span
                    class="presence-dot"
                    data-testid="status-presence-dot"
                    aria-label="Online"
                  ></span>
                {/if}
              </span>
              <span class="m-id">
                <span class="m-name">{a.displayName}</span>
                <span class="m-email">View agent</span>
              </span>
            </button>
          {:else}
            <span class="m-ava ai" aria-hidden="true">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="11"
                height="11"
                fill="currentColor"
                viewBox="0 0 256 256"
              >
                <path
                  d="M230.92,212c-15.23-26.33-38.7-45.21-66.09-54.16a72,72,0,1,0-73.66,0C63.78,166.78,40.31,185.66,25.08,212a8,8,0,1,0,13.85,8c18.84-32.56,52.14-52,89.07-52s70.23,19.44,89.07,52a8,8,0,1,0,13.85-8ZM72,96a56,56,0,1,1,56,56A56.06,56.06,0,0,1,72,96Z"
                ></path>
              </svg>
              {#if a.online}
                <span
                  class="presence-dot"
                  data-testid="status-presence-dot"
                  aria-label="Online"
                ></span>
              {/if}
            </span>
            <span class="m-name">{a.displayName}</span>
          {/if}
        </div>
      {/each}
    </section>
  {/if}

  {#if ondeletechannel && selfIsOwner}
    <div class="p-footer" data-testid="status-channel-actions">
      <button
        type="button"
        class="m-remove p-delete"
        data-testid="status-channel-delete"
        aria-label="Delete channel"
        title="Delete channel"
        disabled={deleting}
        onclick={() => ondeletechannel?.()}
      >
        {#if deleting}
          …
        {:else}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="13"
            height="13"
            fill="currentColor"
            viewBox="0 0 256 256"
            aria-hidden="true"
          >
            <path
              d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"
            ></path>
          </svg>
        {/if}
      </button>
    </div>
  {/if}
</div>

<style>
  .status-popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: min(300px, calc(100vw - 24px));
    max-width: min(300px, calc(100vw - 24px));
    max-height: min(72vh, 540px);
    overflow-x: hidden;
    overflow-y: auto;
    padding: 6px;
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    background: var(--panel-bg);
    box-shadow: var(--panel-shadow);
    color: var(--t1);
    font: 400 13px/1.4 var(--font-ui);
    backdrop-filter: blur(40px) saturate(1.5);
    -webkit-backdrop-filter: blur(40px) saturate(1.5);
  }

  .status-popover > section {
    min-width: 0;
  }

  .status-popover::-webkit-scrollbar:horizontal {
    display: none;
  }

  .p-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    margin: 0 0 6px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--raised);
  }

  .p-line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--t2);
    font-size: 11px;
  }

  .p-line.head {
    margin-bottom: 4px;
    color: var(--t1);
    font-size: 13px;
    font-weight: 500;
  }

  .agent-title {
    min-width: 0;
  }

  .dot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ok, #34c759);
  }

  .dot.idle {
    background: var(--t3);
  }

  .p-meta {
    margin-left: auto;
    color: var(--t3);
    font: 500 10px/1.4 var(--font-mono);
    white-space: nowrap;
  }

  .progress {
    display: flex;
    flex: 1;
    min-width: 0;
    height: 4px;
    overflow: hidden;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.11);
  }

  :global([data-force-theme="light"]) .progress {
    background: rgba(0, 0, 0, 0.1);
  }

  .progress-fill {
    display: block;
    height: 100%;
    background: var(--ice-ink);
  }

  .p-sec {
    padding: 5px 8px 3px;
    color: var(--t3);
    font: 600 9px/1.4 var(--font-mono);
    letter-spacing: 0.9px;
  }

  .p-item {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 12px;
    text-align: left;
  }

  .p-item.kv {
    padding: 5px 10px;
    font-size: 11px;
  }

  button.p-item {
    cursor: pointer;
  }

  button.p-item:hover {
    background: var(--raised);
  }

  .k {
    flex: 0 0 52px;
    color: var(--t2);
    font-size: 11px;
  }

  .val {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--t1);
    font: 400 11px/1.4 var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--ice-ink);
    font-size: 11px;
    font-weight: 500;
  }

  .status-repo {
    display: inline-flex;
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
    align-items: center;
    gap: 4px;
  }

  .status-repo-name,
  .status-repo-nav {
    appearance: none;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--t1);
    font: 400 11px/1.4 var(--font-mono);
  }

  .status-repo-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-repo-name.cycle {
    cursor: pointer;
  }

  .status-repo-name:disabled {
    cursor: default;
  }

  .status-repo-nav {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    color: var(--t3);
    cursor: pointer;
  }

  .status-repo-nav:hover,
  .status-repo-name.cycle:hover {
    color: var(--t1);
    background: var(--raised);
  }

  .status-repo-index {
    flex: 0 0 auto;
    color: var(--t3);
    font: 500 10px/1 var(--font-mono);
  }

  .status-branch-select {
    max-width: calc(100% - 60px);
    min-width: 0;
    padding: 1px 4px;
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    background: var(--raised);
    color: var(--t1);
    font: 400 11px/1.4 var(--font-mono);
  }

  .m-ava {
    position: relative;
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.11);
    color: var(--t1);
    font-size: 9px;
    font-weight: 600;
  }

  /* Real profile photo fills the same 20px well the initial uses. */
  .m-ava-img {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }

  .presence-dot {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 6px;
    height: 6px;
    border: 1.5px solid var(--panel-bg, var(--v4-ground, #151515));
    border-radius: 50%;
    background: var(--v4-ok, #42d77d);
  }

  .session-row {
    align-items: flex-start;
  }

  :global([data-force-theme="light"]) .m-ava {
    background: rgba(0, 0, 0, 0.08);
  }

  .m-ava.ai {
    background: color-mix(in srgb, var(--ice-ink) 22%, #2c3d52);
    color: var(--ice-ink);
  }

  .member-row {
    gap: 6px;
  }

  .member-open {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
  }

  .member-open:hover .m-name {
    color: var(--ice-ink, #c9d6e4);
  }

  .m-id {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.2;
  }

  .m-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .m-email {
    min-width: 0;
    overflow: hidden;
    color: var(--t3);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .m-remove {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--t3);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .m-remove:hover {
    color: var(--warn-ink, #d9584a);
    background: color-mix(in srgb, var(--warn-ink, #d9584a) 14%, transparent);
  }

  .m-remove:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* Owner-only channel actions: one right-justified trash control. */
  .p-footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    margin-top: 4px;
    padding: 6px 8px 2px;
    border-top: 1px solid var(--panel-border);
  }

  .p-delete {
    font-size: 12px;
  }

  .p-delete svg {
    display: block;
  }

  .session-migrate {
    flex: 0 0 auto;
    margin-left: auto;
    padding: 2px 6px;
    font-size: 11px;
  }

  .member-open:focus-visible,
  .m-remove:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
  }

  .status-you {
    flex: 0 0 auto;
    color: var(--t3);
    font: 500 10px/1 var(--font-mono);
  }

  .m-role {
    margin-left: auto;
    flex: 0 0 auto;
    color: var(--t3);
    font: 500 10px/1 var(--font-mono);
  }

  .p-item:not(:has(.m-role)) .status-you {
    margin-left: auto;
  }

  .p-item:focus-visible,
  .status-repo-nav:focus-visible,
  .status-repo-name:focus-visible,
  .status-branch-select:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
  }

  @media (prefers-reduced-transparency: reduce) {
    .status-popover {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }
</style>
