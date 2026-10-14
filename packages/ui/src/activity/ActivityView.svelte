<script lang="ts">
  import { PersonName, identityFromTelemetry } from "../common/people/index.js";
  import { compactNumber, exactNumber } from "../common/compact-number.js";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  /**
   * Company Activity (US-026): the team's activity, one row per person, for
   * a chosen range, with Export. BLANK-1-31: rows read company telemetry
   * (hq-pro `GET /v1/telemetry/company`, the web Activity read) for the range.
   * The cached snapshot paints first and stays while a refresh runs; with no
   * cache the shared loader shows; a failed read with nothing cached shows a
   * plain line with Try again. Live presence comes from the company's
   * work-mesh live read and photos from the app's avatar map, when known.
   */
  import { onMount } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";
  import ReadLoader from "../common/ReadLoader.svelte";
  import { pushToast } from "../shell/toast-stack.svelte.js";
  import { publishCompanyPageCount } from "../shell/company-page-counts.svelte.js";
  import { liveReadFor } from "../chat/live-read-store.svelte.js";
  import "../home/tokens.css";
  import "../common/button/rail-type.css";
  import "../chat/scroll-perf.css";
  import {
    ACTIVITY_RANGES,
    activityBars,
    activityToCsv,
    EMPTY_ACTIVITY,
    formatEfficiency,
    activityFromCompanyTelemetry,
    activityReadFailure,
    lastActiveDaysAgo,
    lastActiveLabel,
    memberModels,
    modelSummary,
    rangeDays,
    readActivityCache,
    saveCsvViaDialog,
    sortMembers,
    writeActivityCache,
    type ActivityFailure,
    type ActivityMember,
    type ActivityRange,
    type ActivitySnapshot,
    type ActivitySort,
  } from "./activity-model.js";

  interface Props {
    slug: string;
    companyLabel: string;
    adapter?: Pick<PlatformAdapter, "company"> | null;
    /** Company cloud uid; reads who is live from the work-mesh live read. */
    companyUid?: string | null;
    /** personUid → photo URL, from the app's identity cache. */
    avatarByUid?: Readonly<Record<string, string>>;
    /** Starts the app's sign-in flow; offered when the read failed on an expired sign-in. */
    onsignin?: () => void | Promise<void>;
  }

  let {
    slug,
    companyLabel,
    adapter = null,
    companyUid = null,
    avatarByUid = {},
    onsignin,
  }: Props = $props();

  const storage = typeof localStorage === "undefined" ? null : localStorage;

  let range = $state<ActivityRange>("30d");
  let sort = $state<ActivitySort>("recent");
  let snapshot = $state<ActivitySnapshot | null>(null);
  let refreshing = $state(false);
  let readError = $state<ActivityFailure | null>(null);
  let signingIn = $state(false);

  async function signInAgain(): Promise<void> {
    if (!onsignin || signingIn) return;
    signingIn = true;
    try {
      await onsignin();
    } catch (err) {
      console.error("activity sign-in failed:", err);
    } finally {
      signingIn = false;
      readNonce += 1;
    }
  }
  let readNonce = $state(0);
  let selectedId = $state<string | null>(null);
  const selected = $derived(snapshot?.members.find((m) => m.id === selectedId) ?? null);
  const selectedModels = $derived(selected ? memberModels(selected) : []);

  /** Members with an online presence in the company's live read. */
  const liveIds = $derived.by(() => {
    const ids = new Set<string>();
    const live = companyUid ? liveReadFor(companyUid) : undefined;
    for (const p of live?.participants ?? []) {
      if (p.presence === "online") ids.add(p.actorUid);
    }
    return ids;
  });
  const rows = $derived(sortMembers(snapshot?.members ?? [], sort, liveIds));
  const liveCount = $derived(rows.filter((m) => liveIds.has(m.id)).length);
  const days = $derived(rangeDays(range));

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && selectedId) {
      selectedId = null;
      event.stopPropagation();
    }
  }

  // The sidepane Activity row shows the team rows this page lists (QA-014).
  $effect(() => {
    if (snapshot) publishCompanyPageCount(slug, "activity", snapshot.members.length);
  });

  const read = $derived(adapter?.company?.getTeamTelemetry ?? null);
  const cacheKey = (activeSlug: string, activeRange: ActivityRange) => `${activeSlug}:${activeRange}`;

  function paintCache(activeSlug: string, activeRange: ActivityRange): void {
    // With a read to run, no cache means the loader until it answers.
    snapshot = readActivityCache(storage, cacheKey(activeSlug, activeRange)) ?? (read ? null : EMPTY_ACTIVITY);
  }

  function isoDay(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  async function refresh(activeSlug: string, activeRange: ActivityRange): Promise<void> {
    const alive = () => slug === activeSlug && range === activeRange;
    if (!read || !activeSlug) {
      readError = null;
      return;
    }
    refreshing = true;
    try {
      const now = Date.now();
      const res = await read(activeSlug, { from: isoDay(now - (rangeDays(activeRange) - 1) * 86_400_000), to: isoDay(now) });
      if (!res.ok) throw Object.assign(new Error(res.message ?? res.reason), { code: res.code });
      const next = activityFromCompanyTelemetry(res.value);
      if (!alive()) return;
      snapshot = next;
      readError = null;
      writeActivityCache(storage, cacheKey(activeSlug, activeRange), next);
    } catch (err) {
      console.error("activity read failed:", err);
      if (!alive()) return;
      readError = activityReadFailure(err, typeof navigator === "undefined" ? true : navigator.onLine !== false);
    } finally {
      if (alive()) refreshing = false;
    }
  }

  $effect(() => {
    const active = slug;
    const activeRange = range;
    void readNonce;
    readError = null;
    paintCache(active, activeRange);
    void refresh(active, activeRange);
  });

  onMount(() => {
    if (!snapshot) paintCache(slug, range);
  });

  async function exportCsv(): Promise<void> {
    const current = snapshot ?? EMPTY_ACTIVITY;
    const csv = activityToCsv(current, range);
    const result = await saveCsvViaDialog(`activity-${slug || "company"}-${range}.csv`, csv);
    // OWNER-003: a quiet confirmation on the shared toast layer.
    pushToast({
      key: "activity-export",
      testId: "export-note",
      title: result === "saved" ? "Saved CSV" : "Export cancelled",
      detail: "",
      tone: result === "saved" ? "ok" : "neutral",
    });
  }

  function lastActive(member: ActivityMember): string | null {
    return lastActiveLabel(lastActiveDaysAgo(member.trend), liveIds.has(member.id));
  }

  function count(value: number | undefined): string {
    return value === undefined ? "—" : String(value);
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="activity" data-testid="activity-view" data-refreshing={refreshing ? "true" : "false"}>
  <header class="toolbar">
    <h1>Activity</h1>
    <div class="tabs seg" role="tablist" aria-label="Range">
      {#each ACTIVITY_RANGES as id (id)}
        <button class="tab" role="tab" aria-selected={range === id} onclick={() => (range = id)}>{id}</button>
      {/each}
    </div>
    <span class="grow"></span>
    {#if liveCount > 0}<span class="meta-line" data-meta-line data-testid="activity-live-count"><span class="meta-dot ok"></span>{liveCount} live</span>{/if}
    <RailButton icon="download" onclick={() => void exportCsv()}>Export</RailButton>
  </header>

  {#if !snapshot && readError}
    <div class="canvas" role="alert" data-testid="activity-failed" data-reason={readError.kind}>
      <p class="empty">{readError.message}</p>
      {#if readError.kind === "signed-out" && onsignin}
        <RailButton icon="refresh" data-testid="activity-sign-in" disabled={signingIn} onclick={() => void signInAgain()}>Sign in again</RailButton>
      {/if}
      <RailButton icon="refresh" data-testid="activity-retry" onclick={() => (readNonce += 1)}>Try again</RailButton>
    </div>
  {:else if !snapshot}
    <div class="canvas" data-testid="activity-loading" aria-busy="true">
      <ReadLoader testid="activity-loader" onretry={() => (readNonce += 1)} />
    </div>
  {:else}
    <div class="split">
    <div class="canvas">
      <div class="sech">
        Team · last {range}
        <span class="grow"></span>
        <span class="sort" role="group" aria-label="Sort team">
          <button type="button" class="sort-btn" aria-pressed={sort === "recent"} data-testid="activity-sort-recent" onclick={() => (sort = "recent")}>Recent</button>
          <button type="button" class="sort-btn" aria-pressed={sort === "name"} data-testid="activity-sort-name" onclick={() => (sort = "name")}>Name</button>
        </span>
        <span class="plain"><CompanyLabel name={companyLabel} companyUid={slug} /></span>
      </div>
      {#if rows.length === 0}
        <p class="empty" data-testid="activity-empty">No team activity in this range yet.</p>
      {:else}
        <div class="team" data-testid="activity-team">
          <div class="team-head" aria-hidden="true">
            <span>Person</span><span>Last {range}</span><span>Last active</span>
            <span class="r">Sessions</span><span class="r">Stories</span><span class="r">PRs</span><span class="r">Deploys</span>
          </div>
          {#each rows as member (member.id)}
            {@const live = liveIds.has(member.id)}
            {@const photo = avatarByUid[member.id]}
            {@const when = lastActive(member)}
            {@const models = modelSummary(memberModels(member))}
            <div
              class="member hq-contain-row"
              role="button"
              data-testid="activity-member-row"
              data-live={live ? "true" : "false"}
              aria-pressed={selectedId === member.id}
              tabindex="0"
              onclick={() => (selectedId = selectedId === member.id ? null : member.id)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectedId = member.id; } }}
            >
              <span class="who-cell">
                <span class="face-wrap">
                  {#if photo}
                    <img class="face" class:bot={member.bot} src={photo} alt="" data-testid="activity-member-photo" />
                  {:else}
                    <span class="face initials" class:bot={member.bot} aria-hidden="true" data-testid="activity-member-initials">{member.mark}</span>
                  {/if}
                  {#if live}<span class="presence" aria-hidden="true"></span>{/if}
                </span>
                <span class="who-text">
                  <span class="who-name"><PersonName person={identityFromTelemetry(member)} compact /></span>
                  {#if member.role || models}
                    <span class="who-role">
                      {#if member.role}<span data-testid="activity-member-role">{member.role}</span>{/if}{#if member.role && models}{" · "}{/if}{#if models}<span data-testid="activity-member-models">{models}</span>{/if}
                    </span>
                  {/if}
                </span>
              </span>
              <span class="bars" aria-label={`Active ${member.trend?.filter((v) => v > 0).length ?? 0} of ${days} days`} data-testid="activity-member-bars">
                {#each activityBars(member.trend, days) as h, i (i)}<i style={`--h:${h}`} class:idle={h === 0}></i>{/each}
              </span>
              <span class="when" class:is-live={live} data-testid="activity-member-last-active">{when ?? ""}</span>
              <span class="r" data-testid="activity-member-sessions">{member.sessions}</span>
              <span class="r" class:zero={member.stories === 0}>{member.stories}</span>
              <span class="r" class:zero={!member.prs}>{count(member.prs)}</span>
              <span class="r" class:zero={member.deploys === 0}>{member.deploys}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    {#if selected}
      <aside class="pane" data-testid="activity-member-pane" aria-label={selected.name}>
        <div class="ph">
          <div class="pn">
            <b><PersonName person={identityFromTelemetry(selected)} /></b>
            <span class="plain">{selected.role || (selected.bot ? "Agent" : "Member")}{lastActive(selected) ? ` · ${lastActive(selected)}` : ""}</span>
          </div>
          <button class="x" aria-label="Close" data-testid="activity-member-close" onclick={() => (selectedId = null)}>×</button>
        </div>
        <dl class="tot">
          <div><dt>Sessions</dt><dd>{selected.sessions}</dd></div>
          <div><dt>Stories</dt><dd>{selected.stories}</dd></div>
          <div><dt>PRs</dt><dd>{selected.prs ?? "—"}</dd></div>
          <div><dt>Deploys</dt><dd>{selected.deploys}</dd></div>
          <div><dt>Outcomes/1M</dt><dd>{formatEfficiency(selected.outcomesPerMillion)}</dd></div>
          <div><dt>Tokens</dt><dd title={exactNumber(selected.tokens)}>{compactNumber(selected.tokens)}</dd></div>
        </dl>
        <div class="sech">Activity by day</div>
        {#if selected.trend && selected.trend.some((v) => v > 0)}
          <span class="bars big" aria-hidden="true">
            {#each activityBars(selected.trend, days) as h, i (i)}<i style={`--h:${h}`} class:idle={h === 0}></i>{/each}
          </span>
        {:else}
          <p class="empty">No activity by day in this range.</p>
        {/if}
        {#if selectedModels.length > 0}
          <div class="sech">Models</div>
          {#each selectedModels as row (row.label)}
            <div class="who" data-testid="activity-member-model" title={row.id}>
              <span>{row.label}</span>
              <span class="r">{[row.sessions !== null ? `${row.sessions} ${row.sessions === 1 ? "session" : "sessions"}` : "", row.share !== null ? `${row.share}% of tokens` : ""].filter(Boolean).join(" · ")}</span>
            </div>
          {/each}
        {/if}
        <div class="sech">Top skills</div>
        {#each selected.skills ?? [] as row (row.skill)}
          <div class="who"><span class="sk">{row.skill}</span><span class="r">{row.count}</span></div>
        {:else}<p class="empty">None in this range.</p>{/each}
        <div class="sech">Recent tools</div>
        {#each selected.services ?? [] as row (row.service)}
          <div class="who"><span>{row.service}</span><span class="r">{row.count}</span></div>
        {:else}<p class="empty">None in this range.</p>{/each}
        <div class="sech">Projects, repos and key files</div>
        <p class="empty" data-testid="activity-member-work">Shown in the web console. The desktop app does not read the work map yet.</p>
      </aside>
    {/if}
    </div>
  {/if}
</div>

<style>
  /* Segmented controls size to their tabs; nothing stretches or centres them. */
  .tabs, .seg { width: max-content; flex: none; justify-content: flex-start; }
  .activity {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--v4-text-1);
    font-family: var(--font-sans, Geist, sans-serif);
    background: transparent;
  }
  .split { flex: 1; min-height: 0; display: flex; }
  .split > .canvas { flex: 1; min-width: 0; }
  .pane { width: 300px; flex: none; overflow-y: auto; padding: 12px 16px; border-left: 1px solid var(--line); box-sizing: border-box; }
  .ph { display: flex; align-items: flex-start; gap: 8px; }
  .pane .sech { margin-top: 16px; }
  .pn { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .x { background: none; border: 0; color: var(--t2); cursor: pointer; font: inherit; min-width: 28px; min-height: 28px; }
  .tot { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
  .tot dt { color: var(--t2); }
  .tot dd { margin: 0; }
  .toolbar { display: flex; align-items: center; gap: 8px; height: 52px; box-sizing: border-box; padding: 0 20px; flex: none; border-bottom: 1px solid var(--line); }
  .toolbar h1 { margin: 0 8px 0 0; font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); }
  .tabs { display: flex; gap: 2px; background: var(--hover); border: 1px solid var(--panel-border); border-radius: 6px; padding: 2px; }
  .seg { margin-left: 12px; }
  .tab { font: inherit; color: var(--v4-text-2); background: transparent; border: 0; }
  .tab { padding: 4px 8px; font-size: 13px; border-radius: 4px; cursor: pointer; }
  .tab[aria-selected="true"] { background: var(--sel); color: var(--t1); }
  .grow { flex: 1; }
  .meta-line { font-variant-numeric: tabular-nums; }
  .meta-dot.ok { background: var(--ok); }
  .canvas { padding: 16px 20px 24px; overflow: auto; min-height: 0; font-size: 13px; }
  .sech {
    font-size: 13px;
    font-weight: 500;
    color: var(--t2);
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
  }
  .plain { font-weight: 400; color: var(--t3); font-size: 13px; }

  /* Quiet sort switch: plain words, the chosen one in the primary text color. */
  .sort { display: inline-flex; gap: 2px; }
  .sort-btn {
    padding: 2px 6px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--t3);
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    cursor: pointer;
  }
  .sort-btn[aria-pressed="true"] { color: var(--t1); }
  .sort-btn:hover { background: var(--hover); }
  .sort-btn:focus-visible { outline: 2px solid var(--v4-control-border); outline-offset: 1px; }

  /* One row per person. Columns drop from the right as the pane narrows. */
  .team { container: activity-team / inline-size; }
  .team-head,
  .member {
    display: grid;
    grid-template-columns: minmax(180px, 1.6fr) minmax(96px, 1fr) 84px 64px 56px 44px 56px;
    align-items: center;
    gap: 12px;
  }
  .team-head {
    padding: 0 8px 6px;
    border-bottom: 1px solid var(--v4-rowline);
    color: var(--t3);
    font-size: 13px;
  }
  .member {
    min-height: 44px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--line);
    border-radius: 6px;
    color: var(--t2);
    cursor: pointer;
    transition: background 120ms ease;
  }
  .member:hover { background: var(--hover); }
  .member[aria-pressed="true"] { background: var(--sel); }
  .member:focus-visible { outline: 2px solid var(--v4-control-border); outline-offset: -2px; }
  .who-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .who-text { display: flex; flex-direction: column; min-width: 0; }
  .who-name { min-width: 0; overflow: hidden; color: var(--t1); text-overflow: ellipsis; white-space: nowrap; }
  .who-role { min-width: 0; overflow: hidden; color: var(--t3); text-overflow: ellipsis; white-space: nowrap; }

  .face-wrap { position: relative; flex: none; width: 28px; height: 28px; }
  .face {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 999px;
    object-fit: cover;
    background: var(--v4-control-faint);
    box-shadow: inset 0 0 0 1px var(--v4-hairline);
    color: var(--t2);
    font-size: 10px;
    font-weight: 500;
    line-height: 1;
  }
  .face.bot { border-radius: 8px; }
  /* Presence sits outside the circle with a ring in the page color. */
  .presence {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--ok, var(--v4-ok));
    box-shadow: 0 0 0 2px var(--v4-ground, var(--bg));
  }

  .bars { display: flex; align-items: flex-end; gap: 1px; height: 18px; min-width: 0; }
  .bars i {
    flex: 1 1 0;
    min-width: 1px;
    max-width: 6px;
    height: calc(var(--h) * 1%);
    border-radius: 1px;
    background: var(--t2);
    opacity: 0.55;
  }
  .bars i.idle { height: 2px; background: var(--v4-hairline); opacity: 1; }
  .bars.big { height: 40px; margin-bottom: 12px; }
  .bars.big i { max-width: 10px; }
  .member[data-live="true"] .bars i:not(.idle) { opacity: 0.8; }

  .when { color: var(--t3); white-space: nowrap; }
  .when.is-live { color: var(--t1); }
  .r { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; }
  .zero { color: var(--t3); }
  .sk { font-size: 13px; color: var(--t3); }
  .empty { font-size: 13px; color: var(--t3); }
  .who { display: flex; justify-content: space-between; height: 31px; box-sizing: border-box; padding: 7px 0; line-height: 17px; border-bottom: 1px solid var(--line); color: var(--t2); }

  @container activity-team (max-width: 640px) {
    .team-head, .member { grid-template-columns: minmax(150px, 1fr) minmax(72px, 0.8fr) 76px 60px 52px; }
    .team-head > :nth-child(n + 6), .member > :nth-child(n + 6) { display: none; }
  }
  @container activity-team (max-width: 440px) {
    .team-head, .member { grid-template-columns: minmax(140px, 1fr) 76px 60px; }
    .team-head > :nth-child(2), .member > :nth-child(2),
    .team-head > :nth-child(n + 5), .member > :nth-child(n + 5) { display: none; }
  }
</style>
