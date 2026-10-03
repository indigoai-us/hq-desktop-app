<script lang="ts">
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  /**
   * Atlas inspector (340 px). With a selection: kind, title, vault path,
   * chips, Here now, PRD goal, stories, related, actions, Born/Touched/Inside.
   * Without: the company roll-up (objects, projects in progress, Working now).
   */
  import {
    ATLAS_KIND_TAG,
    atlasFooterLine,
    districtLabel,
    type AtlasDetail,
    type AtlasNode,
    type AtlasPresence,
  } from "./atlas-model.js";
  import { ATLAS_PEOPLE_DAYS, compactTokens, type AtlasPeopleState } from "./atlas-people.js";

  interface Props {
    node: AtlasNode | null;
    detail: AtlasDetail | undefined;
    detailLoading: boolean;
    related: AtlasNode[];
    presence: AtlasPresence[];
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
  }

  let {
    node,
    detail,
    detailLoading,
    related,
    presence,
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
  }: Props = $props();

  function sparkPath(values: number[]): string {
    if (values.length < 2) return "";
    const max = Math.max(...values, 1);
    return values.map((v, i) => `${i === 0 ? "M" : "L"}${((i / (values.length - 1)) * 48).toFixed(1)},${(12 - (v / max) * 12).toFixed(1)}`).join(" ");
  }

  const here = $derived(node ? presence.filter((p) => p.nodeId === node.id) : presence);
  const isLive = $derived(node ? here.length > 0 : false);
  const firstPerson = $derived(here.find((p) => !p.bot) ?? here[0]);
</script>

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
            <span class="mini" class:sq={who.bot}>{who.bot ? "⌁" : who.name.slice(0, 2).toUpperCase()}<span class="ld"></span></span>
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
        <div class="shimmer"></div>
        <div class="shimmer short"></div>
        <div class="shimmer"></div>
      </div>
    {/if}

    {#if related.length}
      <div class="hr"></div>
      <div class="kind">Related</div>
      <div class="list" data-testid="atlas-inspector-related">
        {#each related as rel (rel.id)}
          <button type="button" class="li rowbtn" onclick={() => onselect(rel.id)}>
            <span class="r">{ATLAS_KIND_TAG[rel.type]}</span>
            <div><div class="tt">{rel.label}</div><div class="mm">{rel.path}</div></div>
          </button>
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
    {#if !mapFailed || presence.length}
    <div class="hr"></div>
    <div class="kind">Working now</div>
    {/if}
    {#if mapFailed && !presence.length}
      <!-- BLANK-2: the map's failed line and Retry stand in for the roll-up. -->
    {:else if presence.length}
      <div class="list" data-testid="atlas-inspector-working-now">
        {#each presence as who (`${who.name}:${who.nodeId}`)}
          <button type="button" class="li rowbtn" onclick={() => onselect(who.nodeId)}>
            <span class="mini" class:sq={who.bot}>{who.bot ? "⌁" : who.name.slice(0, 2).toUpperCase()}<span class="ld"></span></span>
            <div><div class="tt">{who.name}</div>{#if who.signal}<div class="mm">{who.signal}</div>{/if}</div>
          </button>
        {/each}
      </div>
    {:else}
      <p class="goal">Nobody is working in this company right now.</p>
    {/if}
    {#if people.status !== "idle"}
      <div class="hr"></div>
      <div class="kind people-head">People &amp; agents <span class="mm">{ATLAS_PEOPLE_DAYS}d · tokens</span></div>
      {#if people.status === "loading"}
        <p class="goal" data-testid="atlas-people-loading" aria-busy="true">Reading activity…</p>
      {:else if people.status === "failed"}
        <p class="goal" data-testid="atlas-people-failed">
          {people.forbidden ? "Only owners and admins can see team activity." : "Activity could not be read."}
          {#if !people.forbidden}<button type="button" class="link" onclick={() => onpeopleretry?.()}>Try again</button>{/if}
        </p>
      {:else if people.status === "ok" && people.people.length === 0}
        <p class="goal" data-testid="atlas-people-empty">No activity in the last {ATLAS_PEOPLE_DAYS} days.</p>
      {:else if people.status === "ok"}
        <div class="list" data-testid="atlas-people">
          {#each people.people as person (person.id)}
            <button
              type="button"
              class="li rowbtn person"
              data-testid="atlas-person"
              aria-pressed={selectedPersonId === person.id}
              onclick={() => onperson?.(person.id)}
            >
              <div class="pmain">
                <div class="tt">{person.name}{#if person.bot}<span class="tag">agent</span>{/if}<span class="grow"></span><span class="mm tok">{person.tokens > 0 ? compactTokens(person.tokens) : "—"}</span></div>
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
  .li.person { display: block; width: 100%; text-align: left; padding: 6px 0; }
  .li.person[aria-pressed="true"] { background: var(--v4-active-row); }
  .pmain { width: 100%; min-width: 0; }
  .pmain .tt { display: flex; align-items: baseline; gap: 6px; }
  .pmain .grow { flex: 1; }
  .tag { color: var(--v4-text-3); }
  .prow { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .prow .sk { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spark path { fill: none; stroke: currentColor; stroke-width: 1.2; opacity: 0.7; }
  .link { background: none; border: 0; padding: 0; color: inherit; text-decoration: underline; cursor: pointer; font: inherit; min-height: 28px; }
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
  .r {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: var(--v4-text-3);
    min-width: 40px;
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
  .shimmer {
    height: 10px;
    border-radius: 4px;
    background: var(--v4-control-faint);
    animation: atlas-shimmer 1.2s ease-in-out infinite;
  }
  .shimmer.short {
    width: 60%;
  }
  @keyframes atlas-shimmer {
    50% {
      opacity: 0.5;
    }
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
