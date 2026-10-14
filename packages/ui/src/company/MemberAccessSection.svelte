<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  /**
   * OWNER-R9: Joined, Role, Groups and what a teammate can reach, in the Team
   * member pane. Loads on its own with its own loader and failed state; the
   * roster never waits for it. Read only.
   *
   * Access is a summary, not a grant list: one line of truth when the role
   * reaches everything (with a "Why"), otherwise grants rolled up by source
   * and top-level folder, each collapsed, with a search inside long groups.
   * Files and secrets are summarized separately.
   */
  import type { CompanyApi } from "@hq/platform";
  import {
    memberAccessView,
    pathWithBotNames,
    prefixCount,
    summarizeAccess,
    type AccessSide,
    type GrantGroup,
    type MemberAccessView,
  } from "./member-access.js";

  interface Props {
    company: Pick<CompanyApi, "getMemberAccess"> | null;
    companyUid: string | null;
    personUid: string;
    joined?: string;
    role?: string;
    badge?: string;
    /** Company name for the one line of truth ("…in Indigo"). */
    companyLabel?: string;
    botName: (id: string) => string | null;
  }

  let {
    company,
    companyUid,
    personUid,
    joined = "",
    role = "",
    badge = "",
    companyLabel = "",
    botName,
  }: Props = $props();

  /** Groups longer than this get a search box. */
  const SEARCH_AT = 8;

  let phase = $state<"loading" | "ready" | "failed" | "unavailable">("loading");
  let access = $state<MemberAccessView | null>(null);
  let attempt = $state(0);
  let queries = $state<Record<string, string>>({});

  const summary = $derived(access ? summarizeAccess(access, { role, companyLabel }) : null);

  $effect(() => {
    void attempt;
    const uid = companyUid;
    const person = personUid;
    access = null;
    queries = {};
    if (!uid || !company?.getMemberAccess) {
      phase = "unavailable";
      return;
    }
    phase = "loading";
    let live = true;
    Promise.resolve(company.getMemberAccess(uid, person))
      .then((res) => {
        if (!live) return;
        if (!res.ok) {
          console.warn("[team] member access read failed", res.message ?? res.reason);
          phase = "failed";
          return;
        }
        access = memberAccessView(res.value);
        phase = "ready";
      })
      .catch((err: unknown) => {
        if (!live) return;
        console.warn("[team] member access read rejected", err);
        phase = "failed";
      });
    return () => {
      live = false;
    };
  });

  function shown(group: GrantGroup): GrantGroup["rows"] {
    const q = (queries[group.key] ?? "").trim().toLowerCase();
    if (!q) return group.rows;
    return group.rows.filter((row) => pathWithBotNames(row.path, botName).toLowerCase().includes(q));
  }

  function roleWord(): string {
    return role.trim() || "their role";
  }
</script>

<section class="ma" data-testid="member-access">
  <dl class="facts">
    {#if joined}<dt>Joined</dt><dd data-testid="member-joined">{joined}</dd>{/if}
    <dt>Role</dt><dd data-testid="member-role">{role || "—"}{#if badge} <span class="badge">{badge}</span>{/if}</dd>
    {#if access}
      <dt>Groups</dt>
      <dd data-testid="member-groups">
        {#each access.groups as g (g)}<span class="chip">{g}</span>{:else}<span class="muted">None</span>{/each}
      </dd>
    {/if}
  </dl>

  <div class="sech">Access</div>
  {#if phase === "loading"}
    <p class="muted" data-testid="member-access-loading" aria-busy="true">Loading access…</p>
  {:else if phase === "failed"}
    <p class="muted" data-testid="member-access-failed">Couldn't load access. <button type="button" class="retry" onclick={() => (attempt += 1)}><RailIcon name="refresh" />Try again</button></p>
  {:else if phase === "unavailable"}
    <p class="muted" data-testid="member-access-unavailable">Access shows once this company is connected to HQ cloud.</p>
  {:else if summary && access}
    {#if summary.everything}
      <p class="truth" data-testid="member-access-everything">{summary.everything}</p>
      {@render why(access)}
    {:else}
      {@render accessSide("Files", "files", summary.files, access)}
      {@render accessSide("Secrets", "secrets", summary.secrets, access)}
    {/if}
  {/if}
</section>

{#snippet why(view: MemberAccessView)}
  <details class="why" data-testid="member-access-why">
    <summary>Why</summary>
    <p>Their role is {roleWord()}. Owners and admins reach every file{view.secretsBypass ? " and secret" : ""} without separate grants.</p>
    <p>
      Groups:
      {#each view.groups as g (g)}<span class="chip">{g}</span>{:else}<span class="muted">none</span>{/each}
    </p>
  </details>
{/snippet}

{#snippet accessSide(title: string, kind: "files" | "secrets", data: AccessSide, view: MemberAccessView)}
  <div class="side" data-testid={`member-access-${kind}`}>
    <div class="side-head">
      <span class="side-title">{title}</span>
      {#if !data.bypass && data.total > 0}<span class="muted">{prefixCount(data.total)}</span>{/if}
    </div>
    {#if data.bypass}
      <p class="truth">{kind === "files" ? "Every file" : "Every secret"}, as {roleWord()}.</p>
      {@render why(view)}
    {:else if data.groups.length === 0}
      <p class="muted">{kind === "files" ? "No file grants." : "No secret grants."}</p>
    {:else}
      {#each data.groups as group (group.key)}
        <details class="grp" data-testid="member-access-group" data-source={group.source}>
          <summary>
            <span class="pfx">{group.prefix === "Everything" ? "Everything" : `${group.prefix}…`}</span>
            <span class="cnt">{prefixCount(group.rows.length)}</span>
            <span class="gwhy">{group.level} · {group.why}</span>
          </summary>
          {#if group.rows.length > SEARCH_AT}
            <input
              class="find"
              type="search"
              placeholder={`Search ${group.rows.length} prefixes`}
              aria-label={`Search ${group.prefix}`}
              data-testid="member-access-search"
              value={queries[group.key] ?? ""}
              oninput={(e) => (queries = { ...queries, [group.key]: (e.currentTarget as HTMLInputElement).value })}
            />
          {/if}
          <ul class="rows">
            {#each shown(group) as row (row.path)}
              <li>
                <span class="path" title={pathWithBotNames(row.path, botName)}>{pathWithBotNames(row.path, botName)}</span>
                {#if group.level === "mixed levels"}<span class="lvl">{row.level}</span>{/if}
              </li>
            {:else}
              <li class="muted">No match.</li>
            {/each}
          </ul>
        </details>
      {/each}
    {/if}
  </div>
{/snippet}

<style>
  .ma { padding: 16px 20px 20px; font-size: 13px; line-height: 17px; color: var(--t1); border-top: 1px solid var(--line); }
  .facts { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 6px 8px; margin: 0 0 12px; }
  dt { color: var(--t3); }
  dd { margin: 0; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-width: 0; }
  .chip, .badge { padding: 0 6px; border-radius: 999px; background: var(--hover); color: var(--t2); }
  .sech { color: var(--t1); font-weight: 500; margin: 16px 0 8px; padding-top: 12px; border-top: 1px solid var(--line); }
  .muted { color: var(--t3); margin: 0; }
  .truth { margin: 0 0 4px; color: var(--t1); }
  .retry { border: 0; background: none; padding: 0; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }

  .why { margin: 0 0 8px; color: var(--t2); }
  .why > summary { width: max-content; color: var(--t3); cursor: pointer; }
  .why p { margin: 6px 0 0; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }

  .side { margin: 0 0 12px; }
  .side-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 0 4px; }
  .side-title { color: var(--t2); font-weight: 500; }

  .grp { border-bottom: 1px solid var(--line); }
  .grp > summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0 8px;
    padding: 6px 4px;
    border-radius: 6px;
    list-style: none;
    cursor: pointer;
  }
  .grp > summary::-webkit-details-marker { display: none; }
  .grp > summary:hover { background: var(--hover); }
  .grp > summary:focus-visible { outline: 2px solid var(--v4-control-border); outline-offset: -2px; }
  .pfx { min-width: 0; overflow: hidden; color: var(--t1); text-overflow: ellipsis; white-space: nowrap; }
  .cnt { color: var(--t3); font-variant-numeric: tabular-nums; }
  .lvl { color: var(--t2); }
  .gwhy { grid-column: 1 / -1; color: var(--t3); }

  .find {
    box-sizing: border-box;
    width: 100%;
    height: 26px;
    margin: 2px 0 6px;
    padding: 0 8px;
    border: 1px solid var(--line2, var(--line));
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
  }
  .rows { list-style: none; margin: 0 0 8px; padding: 0 4px; display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow-y: auto; }
  .rows li { display: flex; justify-content: space-between; gap: 8px; min-width: 0; padding: 2px 0; line-height: 17px; color: var(--t2); }
  .path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
