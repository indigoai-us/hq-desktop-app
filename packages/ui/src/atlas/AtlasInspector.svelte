<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import type { RailIconName } from "../common/button/rail-icons.js";
  import { PersonName, identityFromTelemetry } from "../common/people/index.js";
  import { compactNumber } from "../common/compact-number.js";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import AtlasFace from "./AtlasFace.svelte";
  import AtlasCard from "./AtlasCard.svelte";
  /**
   * Atlas inspector (340 px). With a selection: kind, title, vault path,
   * chips, Here now, PRD goal, stories, related, actions, Born/Touched/Inside.
   * Without: the company roll-up (objects, projects in progress, Working now).
   */
  import {
    atlasFooterLine,
    districtLabel,
    type AtlasDetail,
    type AtlasNode,
    type AtlasPresence,
  } from "./atlas-model.js";
  import { ATLAS_PEOPLE_DAYS, type AtlasPeopleState } from "./atlas-people.js";
  import { ATLAS_TODAY_GROUPS, ATLAS_TODAY_ROWS, atlasAgo, type AtlasTodayGroup, type AtlasTodayKind } from "./atlas-today.js";

  interface Props {
    node: AtlasNode | null;
    detail: AtlasDetail | undefined;
    detailLoading: boolean;
    related: AtlasNode[];
    presence: AtlasPresence[];
    /** Online with no session in progress; summarised under Working now. */
    online?: AtlasPresence[];
    company: string;
    /** Null hides the objects chip (the US-009 landing has no map yet). */
    objectCount: number | null;
    /** Null hides the projects chip (BLANK-2: no count from a failed read). */
    projectsInProgress: number | null;
    /** BLANK-2: the map read failed; no "Nobody is working" beside the error. */
    mapFailed?: boolean;
    nowMs: number;
    onselect: (id: string) => void;
    onopenfiles?: (node: AtlasNode) => void;
    onopenboard?: (node: AtlasNode) => void;
    onmessage?: (who: AtlasPresence) => void;
    /** OWNER-R4: People & agents over the last 30 days (company roll-up only). */
    people?: AtlasPeopleState;
    selectedPersonId?: string | null;
    onperson?: (id: string) => void;
    onpeopleretry?: () => void;
    /** Map objects lit for the picked person; 0 means none of their skills are on the map. */
    personMatches?: number;
    /** Today panel: today's changes grouped by parent, projects first; null hides the panel (no map). */
    today?: AtlasTodayGroup[] | null;
  }

  let {
    node,
    detail,
    detailLoading,
    related,
    presence,
    online = [],
    company,
    objectCount,
    projectsInProgress,
    mapFailed = false,
    nowMs,
    onselect,
    onopenfiles,
    onopenboard,
    onmessage,
    people = { status: "idle" },
    selectedPersonId = null,
    onperson,
    onpeopleretry,
    personMatches = 0,
    today = null,
  }: Props = $props();

  // Progressive: a few groups at a time, a few rows per group; each "more"
  // expands in place where it was clicked.
  let todayGroupLimit = $state(ATLAS_TODAY_GROUPS);
  let todayOpenGroups = $state<Record<string, boolean>>({});
  const todayShown = $derived(today ? today.slice(0, todayGroupLimit) : []);
  const todayHidden = $derived(today ? today.slice(todayGroupLimit) : []);
  const todayHiddenRows = $derived(todayHidden.reduce((sum, g) => sum + Math.max(1, g.rows.length), 0));
  const todayCount = $derived(today ? today.reduce((sum, g) => sum + g.rows.length + (g.changed ? 1 : 0), 0) : 0);
  function groupRows(g: AtlasTodayGroup) {
    return todayOpenGroups[g.key] ? g.rows : g.rows.slice(0, ATLAS_TODAY_ROWS);
  }
  /** Phosphor Regular icon per Today row kind. */
  const KIND_ICON: Record<AtlasTodayKind, RailIconName> = {
    project: "circle",
    prd: "file-text",
    brainstorm: "brain",
    policy: "shield-check",
    meeting: "chat-circle",
    source: "code",
    repo: "code",
    worker: "robot",
    skill: "star",
    knowledge: "file",
  };

  const KIND_LABEL: Record<AtlasTodayKind, string> = {
    prd: "PRD",
    brainstorm: "Brainstorm",
    policy: "Policy",
    knowledge: "Doc",
    meeting: "Meeting note",
    source: "Source file",
    project: "Project",
    repo: "Repo",
    worker: "Worker",
    skill: "Skill",
  };

  function sparkPath(values: number[]): string {
    if (values.length < 2) return "";
    const max = Math.max(...values, 1);
    return values.map((v, i) => `${i === 0 ? "M" : "L"}${((i / (values.length - 1)) * 48).toFixed(1)},${(12 - (v / max) * 12).toFixed(1)}`).join(" ");
  }

  const here = $derived(node ? presence.filter((p) => p.nodeId === node.id) : presence);
  const isLive = $derived(node ? here.length > 0 : false);
  const firstPerson = $derived(here.find((p) => !p.bot) ?? here[0]);
</script>

{#snippet kindIcon(kind: AtlasTodayKind)}
  <RailIcon name={KIND_ICON[kind] ?? "file"} size={14} />
{/snippet}

<aside class="inspector" data-testid="atlas-inspector" aria-label="Atlas inspector">
  {#if node}
    <div class="kind" data-testid="atlas-inspector-kind">
      {districtLabel(node.type).replace(/s$/, "").toLowerCase()}{isLive ? " · live" : ""}
    </div>
    <h2>{node.label}</h2>
    <div class="path" data-testid="atlas-inspector-path">{node.path}</div>
    <div class="chips">
      {#if isLive}<span class="chip live"><i class="ldot"></i>live · {here.length}</span>{/if}
      {#if node.stories}
        <span class="chip">{node.stories.done} of {node.stories.total} stories</span>
      {/if}
      {#if detail?.branch}<span class="chip mono">{detail.branch}</span>{/if}
    </div>

    {#if here.length}
      <div class="hr"></div>
      <div class="kind">Here now</div>
      <div class="list">
        {#each here as who (who.actorUid ?? who.name)}
          <div class="li">
            <span class="mini" class:sq={who.bot}><AtlasFace name={who.name} bot={who.bot} avatarUrl={who.avatarUrl} size={22} fallback={who.bot ? "⌁" : who.name.slice(0, 2).toUpperCase()} /><span class="ld"></span></span>
            <div>
              <div class="tt">{who.name}</div>
              {#if who.signal}<div class="mm">{who.signal}</div>{/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if detail?.goal || detail?.summary}
      <div class="hr"></div>
      <div class="kind">Goal</div>
      <p class="goal" data-testid="atlas-inspector-goal">{detail.goal ?? detail.summary}</p>
    {/if}
    {#if detail?.stories?.length}
      <div class="kind spaced">Stories</div>
      <div class="stories" data-testid="atlas-inspector-stories">
        {#each detail.stories as story (story.id || story.title)}
          <div class="st"><i class:done={story.passes}></i>{story.title}</div>
        {/each}
      </div>
    {:else if detailLoading}
      <div class="kind spaced">Stories</div>
      <div class="stories" aria-busy="true">
        <ReadLoader testid="atlas-stories-loading" surface="atlas" />
      </div>
    {/if}

    {#if related.length}
      <div class="hr"></div>
      <div class="kind">Related</div>
      <div class="list" data-testid="atlas-inspector-related">
        {#each related as rel (rel.id)}
          <AtlasCard node={rel} meta={rel.path} onclick={() => onselect(rel.id)} />
        {/each}
      </div>
    {/if}

    <div class="hr"></div>
    <div class="actions">
      <RailButton icon="folder" variant="primary" onclick={() => onopenfiles?.(node)}>Open files</RailButton>
      {#if node.type === "project"}
        <RailButton icon="external" onclick={() => onopenboard?.(node)}>Open board</RailButton>
      {/if}
      {#if firstPerson}
        <RailButton icon="send" onclick={() => onmessage?.(firstPerson)}>Message {firstPerson.name}</RailButton>
      {/if}
    </div>
    <div class="foot" data-testid="atlas-inspector-footer">{atlasFooterLine(node, nowMs)}</div>
  {:else}
    <div class="kind">Company</div>
    <h2><CompanyLabel name={company} /></h2>
    <div class="chips" data-testid="atlas-inspector-rollup">
      {#if presence.length}<span class="chip live"><i class="ldot"></i>{presence.length} live</span>{/if}
      {#if objectCount !== null}<span class="chip">{objectCount} objects</span>{/if}
      {#if projectsInProgress !== null}<span class="chip">{projectsInProgress} projects in progress</span>{/if}
    </div>
    {#if today && !mapFailed}
      <div class="hr"></div>
      <div class="section" data-testid="atlas-today-title">Today at {company || "this company"}</div>
      {#if today.length}
        <div class="kind sub">Changed today <span class="count-muted" data-testid="atlas-today-count">{todayCount}</span></div>
        <div class="today" data-testid="atlas-today-changed">
          {#each todayShown as group (group.key)}
            {@const shownRows = groupRows(group)}
            <section class="tgroup" data-testid="atlas-today-group" data-kind={group.kind}>
              <svelte:element
                this={group.node ? "button" : "div"}
                type={group.node ? "button" : undefined}
                class="thead"
                class:clickable={group.node !== null}
                data-testid="atlas-today-group-head"
                role={group.node ? undefined : "group"}
                aria-label={group.node ? undefined : group.title}
                onclick={group.node ? () => onselect(group.node!.id) : undefined}
              >
                <!-- A project with stories shows its board state dot in the icon slot. -->
                <span class="ticon">{#if group.column}<i class="column-dot" data-column={group.column} data-testid="atlas-today-state" aria-hidden="true"></i>{:else}{@render kindIcon(group.kind)}{/if}</span>
                <span class="tbody">
                  <span class="ttitle">
                    <span class="tname" data-testid="atlas-today-group-title">{group.title}</span>
                    <span class="tago">{atlasAgo(group.touched || nowMs, nowMs)}</span>
                  </span>
                  {#if group.stories}
                    <span class="tprog" data-testid="atlas-today-stories" data-done={group.stories.fraction.toFixed(3)}>
                      <span class="track"><span class="fill" style:width={`${(group.stories.fraction * 100).toFixed(1)}%`}></span></span>
                      <span class="tcount">{group.stories.text}</span>
                    </span>
                  {/if}
                </span>
              </svelte:element>
              {#if shownRows.length}
                <div class="trows">
                  {#each shownRows as row (row.node.id)}
                    <button type="button" class="trow" data-testid="atlas-today-row" data-kind={row.kind} title={`${KIND_LABEL[row.kind]} · ${row.node.path}`} onclick={() => onselect(row.node.id)}>
                      <span class="ticon" aria-label={KIND_LABEL[row.kind]}>{@render kindIcon(row.kind)}</span>
                      <span class="tbody">
                        <span class="tt">{row.title}</span>
                        <span class="mm">{row.parentPath ? `${row.parentPath} · ` : ""}{atlasAgo(row.node.touched ?? nowMs, nowMs)}</span>
                      </span>
                    </button>
                  {/each}
                  {#if group.rows.length > shownRows.length}
                    <button type="button" class="more" data-testid="atlas-today-group-more" onclick={() => (todayOpenGroups = { ...todayOpenGroups, [group.key]: true })}>{group.rows.length - shownRows.length} more in {group.title}</button>
                  {/if}
                </div>
              {/if}
            </section>
          {/each}
          {#if todayHidden.length}
            <button type="button" class="more" data-testid="atlas-today-more" onclick={() => (todayGroupLimit += ATLAS_TODAY_GROUPS)}>Show {todayHidden.length} more {todayHidden.length === 1 ? "group" : "groups"} <span class="count-muted">· {todayHiddenRows} {todayHiddenRows === 1 ? "change" : "changes"}</span></button>
          {/if}
        </div>
      {:else}
        <p class="goal" data-testid="atlas-today-empty">Nothing on the map changed today.</p>
      {/if}
    {/if}
    {#if !mapFailed || presence.length || online.length}
    <div class="hr"></div>
    <div class="kind">Working now</div>
    {/if}
    {#if mapFailed && !presence.length}
      <!-- BLANK-2: the map's failed line and Retry stand in for the roll-up. -->
    {:else if presence.length}
      <div class="list" data-testid="atlas-inspector-working-now">
        {#each presence as who (`${who.name}:${who.nodeId}`)}
          <button type="button" class="li rowbtn card" onclick={() => onselect(who.nodeId)}>
            <span class="mini" class:sq={who.bot}><AtlasFace name={who.name} bot={who.bot} avatarUrl={who.avatarUrl} size={22} fallback={who.bot ? "⌁" : who.name.slice(0, 2).toUpperCase()} /><span class="ld"></span></span>
            <div>
              <div class="tt">{who.name}</div>
              {#if who.place || who.signal}<div class="mm">{[who.place, who.signal].filter(Boolean).join(" · ")}</div>{/if}
            </div>
          </button>
        {/each}
      </div>
    {:else}
      <p class="goal">Nobody is working in this company right now.</p>
    {/if}
    {#if online.length}
      <details class="online" data-testid="atlas-inspector-online">
        <summary>{online.length} more online, not in a session</summary>
        <div class="online-names">{online.map((who) => who.name).join(", ")}</div>
      </details>
    {/if}
    {#if people.status !== "idle"}
      <div class="hr"></div>
      <div class="kind people-head">People &amp; agents <span class="mm">{ATLAS_PEOPLE_DAYS}d · tokens</span></div>
      {#if people.status === "loading"}
        <p class="goal" data-testid="atlas-people-loading" aria-busy="true">Reading activity…</p>
      {:else if people.status === "failed"}
        <p class="goal" data-testid="atlas-people-failed">
          {people.forbidden ? "Only owners and admins can see team activity." : "Activity could not be read."}
          {#if !people.forbidden}<button type="button" class="link" onclick={() => onpeopleretry?.()}><RailIcon name="refresh" />Try again</button>{/if}
        </p>
      {:else if people.status === "ok" && people.people.length === 0}
        <p class="goal" data-testid="atlas-people-empty">No activity in the last {ATLAS_PEOPLE_DAYS} days.</p>
      {:else if people.status === "ok"}
        <div class="list" data-testid="atlas-people">
          {#each people.people as person (person.id)}
            <button
              type="button"
              class="li rowbtn card person"
              data-testid="atlas-person"
              aria-pressed={selectedPersonId === person.id}
              onclick={() => onperson?.(person.id)}
            >
              <div class="pmain" style:--share={`${Math.round((person.tokens / Math.max(1, people.people[0]?.tokens ?? 1)) * 100)}%`}>
                <div class="tt">{#if person.bot}<i class="boticon" aria-hidden="true"></i>{/if}<PersonName person={identityFromTelemetry(person)} /><span class="grow"></span><span class="mm tok">{person.tokens > 0 ? compactNumber(person.tokens) : "—"}</span></div>
                <div class="mm prow">
                  {#if !person.bot && person.trend.length > 1}<svg class="spark" width="48" height="12" viewBox="0 0 48 12" aria-hidden="true"><path d={sparkPath(person.trend)} /></svg>{/if}
                  <span>{person.sessions} sess · {person.stories} stories</span>
                  {#if !person.bot && person.topSkill}<span class="sk">{person.topSkill}</span>{/if}
                </div>
              </div>
            </button>
          {/each}
        </div>
        {#if selectedPersonId}
          <p class="goal" data-testid="atlas-person-matches">
            {personMatches > 0 ? `${personMatches} of their skills on the map.` : "None of the skills they ran are on this map."}
          </p>
        {/if}
      {/if}
    {/if}
  {/if}
</aside>

<style>
  .people-head { display: flex; gap: 8px; align-items: baseline; }
  /* Section title: small, uppercase, muted (owner rule for section titles). */
  .section { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; color: var(--v4-text-3); }
  .kind.sub { margin-top: 8px; display: flex; gap: 6px; align-items: baseline; }
  .count-muted { color: var(--v4-text-3); font-variant-numeric: tabular-nums; }
  /* Today: one group per parent object, its changed files indented under it. */
  .today { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
  .tgroup { display: flex; flex-direction: column; }
  .thead, .trow {
    display: grid;
    grid-template-columns: 14px 1fr;
    gap: 10px;
    align-items: start;
    width: calc(100% + 20px);
    margin: 0 -10px;
    padding: 6px 10px;
    background: none;
    border: 0;
    border-radius: var(--v4-radius-button, 6px);
    color: inherit;
    font: inherit;
    text-align: left;
    box-sizing: border-box;
  }
  .thead.clickable, .trow { cursor: pointer; }
  .thead.clickable:hover, .trow:hover { background: var(--v4-hover, var(--v4-control-faint)); }
  .thead:focus-visible, .trow:focus-visible, .more:focus-visible { outline: 2px solid var(--v4-focus-ring, var(--v4-control-border)); outline-offset: -2px; }
  .trows { display: flex; flex-direction: column; padding-left: 24px; }
  .trow { width: calc(100% + 10px); margin: 0 -10px 0 0; padding: 5px 10px 5px 0; }
  .trows .more { margin: 0 -10px 0 0; padding: 5px 10px 5px 24px; }
  .ticon { display: inline-grid; place-items: center; width: 14px; height: 14px; margin-top: 2px; }
  .ticon { color: var(--v4-text-3); }
  .tbody { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ttitle { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .tname { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 500; color: var(--v4-text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tago { flex: none; font-size: 13px; color: var(--v4-text-3); font-variant-numeric: tabular-nums; }
  .trow .tt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trow .mm { margin-top: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; }
  .tprog { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
  /* Same tone as the map's story ring and the Atlas cards. */
  .track { position: relative; flex: 1; height: 2px; border-radius: 1px; background: color-mix(in srgb, var(--v4-text-1) 12%, transparent); overflow: hidden; }
  .fill { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--v4-text-1) 45%, transparent); }
  .thead:hover .fill { background: color-mix(in srgb, var(--v4-text-1) 80%, transparent); }
  .tcount { flex: none; font-size: 13px; color: var(--v4-text-3); font-variant-numeric: tabular-nums; }
  /* State dot: the Projects board column dots. */
  .column-dot { flex: none; width: 8px; height: 8px; border-radius: 999px; background: var(--v4-text-3); }
  .column-dot[data-column="not-started"] { background: transparent; box-shadow: inset 0 0 0 1.5px var(--v4-text-3); }
  .column-dot[data-column="in-progress"] { background: var(--v4-text-2); }
  .column-dot[data-column="active"] { background: var(--v4-ok); }
  .column-dot[data-column="complete"] { background: var(--v4-text-1); }
  .more { margin: 4px -10px 0; padding: 8px 10px; background: none; border: 0; border-radius: 0; color: var(--v4-text-3); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
  .more:hover { background: var(--v4-hover, var(--v4-control-faint)); }
  .online { margin-top: 8px; font-size: 13px; color: var(--v4-text-3); }
  .online summary { cursor: pointer; }
  .online-names { margin-top: 4px; line-height: 1.5; }
  /* Card rows: 10px inner padding, offset by a matching negative margin so text
     stays on the section's column and the hover/selected fill reaches past it. */
  .li.card { padding: 8px 10px; margin: 0 -10px; }
  .li.card + .li.card { margin-top: 3px; }
  .li.person { display: block; width: calc(100% + 20px); text-align: left; }
  .pmain .prow { margin-top: 4px; }
  .li.person[aria-pressed="true"] { background: var(--v4-active-row); }
  .pmain { width: 100%; min-width: 0; }
  .pmain .tt { display: flex; align-items: baseline; gap: 6px; }
  .pmain .grow { flex: 1; }
  .prow { display: flex; align-items: center; gap: 8px; min-width: 0; white-space: nowrap; }
  .prow .spark { flex: none; }
  .prow span { flex: none; }
  .prow .sk { flex: 1 1 0; min-width: 0; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tok { font-variant-numeric: tabular-nums; }
  /* Bots carry the same square mark as on the map. */
  .boticon { width: 8px; height: 8px; flex: none; align-self: center; border: 1.25px solid var(--v4-text-3); border-radius: 2px; box-sizing: border-box; }
  /* Share of the top person's tokens: one quiet rule under the row. */
  .pmain::after { content: ""; display: block; height: 2px; margin-top: 6px; width: var(--share, 0%); min-width: 2px; background: var(--v4-text-3); opacity: 0.35; }
  .spark path { fill: none; stroke: currentColor; stroke-width: 1.2; opacity: 0.7; }
  .link { background: none; border: 0; padding: 0; color: inherit; text-decoration: none; cursor: pointer; font: inherit; min-height: 28px; }
  .link:hover { opacity: 0.7; }
  .inspector {
    width: 340px;
    box-sizing: border-box;
    border-left: 1px solid var(--v4-rowline);
    padding: var(--v4-space-4);
    overflow: auto;
    background: var(--v4-secondary-sidebar);
    color: var(--v4-text-1);
    min-height: 0;
  }
  .kind {
    font-size: 13px;
    font-weight: 500;
    color: var(--t2, var(--v4-text-3));
  }
  .kind.spaced {
    margin-top: 12px;
  }
  h2 {
    font-size: 13px;
    margin: 2px 0 0;
    font-weight: 500;
  }
  .path {
    font-family: var(--font-mono, "Geist Mono", monospace);
    font-size: 13px;
    color: var(--t3, var(--v4-text-3));
    overflow-wrap: anywhere;
    margin-top: 4px;
  }
  .chips {
    display: flex;
    gap: 6px;
    margin: 10px 0 2px;
    flex-wrap: wrap;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--t2, var(--v4-text-2));
    font-size: 13px;
  }
  .chip.mono {
    font-family: var(--font-mono, "Geist Mono", monospace);
  }
  .ldot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-ok);
  }
  .hr {
    height: 1px;
    background: var(--v4-rowline);
    margin: 12px 0;
  }
  .list {
    display: flex;
    flex-direction: column;
  }
  .li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 12px;
    align-items: center;
    padding: 9px 0;
    border-bottom: 1px solid var(--v4-rowline);
    text-align: left;
  }
  .rowbtn {
    background: none;
    border: none;
    border-bottom: 1px solid var(--v4-rowline);
    color: inherit;
    font: inherit;
    cursor: pointer;
    border-radius: 0;
  }
  .rowbtn:hover {
    background: var(--v4-hover, var(--v4-control-faint));
  }
  .tt {
    font-size: 13px;
    color: var(--v4-text-1);
  }
  .mm {
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
    margin-top: var(--v4-row-stack-gap);
    overflow-wrap: anywhere;
  }
  .mini {
    position: relative;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: inline-grid;
    place-items: center;
    font-size: 9px;
    background: var(--v4-control-border);
    color: var(--v4-text-2);
  }
  .mini.sq {
    border-radius: 6px;
  }
  .mini .ld {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--v4-ok);
    border: 1.5px solid var(--v4-secondary-sidebar);
  }
  .goal {
    font-size: 13px;
    color: var(--v4-text-2);
    margin: 4px 0 0;
    line-height: 1.45;
  }
  .stories {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
  }
  .st {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    color: var(--v4-text-2);
  }
  .st i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-idle);
    flex: none;
  }
  .st i.done {
    background: var(--v4-text-3);
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .foot {
    font-size: 13px;
    color: var(--v4-text-3);
    margin-top: 10px;
  }
</style>
