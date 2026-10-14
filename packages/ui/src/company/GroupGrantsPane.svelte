<script lang="ts">
  /**
   * Company Grants pane: the web console's Grants page in the desktop app.
   * Grant one of this company's groups Read or Write on other companies,
   * revoke an active grant, and see which other companies' groups have
   * access here. Data and actions: group-grants.ts.
   */
  import { untrack } from "svelte";
  import type { FilesApi } from "@hq/platform";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import CompanyLabel from "./CompanyLabel.svelte";
  import LazyDropdown from "../common/LazyDropdown.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import { cacheGroups, cachedGroups, groupsFromBody } from "./company-access.js";
  import type { CompanyGroup } from "./company-settings.js";
  import {
    GRANT_ROLE_OPTIONS,
    companyName,
    grantErrorCopy,
    grantFormProblem,
    grantKey,
    grantOutcomeSummary,
    grantRoleLabel,
    groupName,
    readGroupGrants,
    splitByStatus,
    submitGrants,
    type GrantTarget,
    type GroupGrant,
    type GroupGrantsRead,
  } from "./group-grants.js";

  interface Props {
    companyUid: string | null;
    companyLabel: string;
    /** The caller's companies; the current one is left out of the picker. */
    targets?: GrantTarget[];
    files: FilesApi | null;
  }

  let { companyUid, companyLabel, targets = [], files }: Props = $props();

  type PaneState = "unavailable" | "loading" | "ready" | "failed";
  let paneState = $state<PaneState>("loading");
  let groups = $state<CompanyGroup[]>([]);
  let read = $state<GroupGrantsRead | null>(null);
  let nonce = $state(0);

  let view = $state<"groups" | "grants">("groups");
  let groupId = $state("");
  let picked = $state<string[]>([]);
  let role = $state<string>("member");
  let granting = $state(false);
  let notice = $state<string | null>(null);
  let error = $state<string | null>(null);
  let revoking = $state<string | null>(null);
  let confirmRevoke = $state<GroupGrant | null>(null);

  const others = $derived(targets.filter((t) => t.uid !== companyUid));
  const canUse = $derived(
    Boolean(
      companyUid &&
        files?.listAccessGroups &&
        files.listOutboundGroupGrants &&
        files.listInboundGroupGrants &&
        files.createGroupGrant &&
        files.revokeGroupGrant,
    ),
  );

  $effect(() => {
    void nonce;
    const uid = companyUid;
    const api = files;
    if (!uid || !api || !canUse) {
      paneState = "unavailable";
      return;
    }
    let cancelled = false;
    const hit = cachedGroups(uid);
    if (hit) groups = hit;
    // Untracked: this effect writes `read`, so tracking it would re-run the load forever.
    if (!untrack(() => read)) paneState = "loading";
    void (async () => {
      let list = hit ?? [];
      try {
        const res = await api.listAccessGroups!(uid);
        if (cancelled) return;
        if (!res.ok) throw new Error(res.code ?? "groups read failed");
        list = groupsFromBody(res.value);
        cacheGroups(uid, list);
        groups = list;
      } catch (err) {
        if (cancelled) return;
        console.warn("[grants] groups read failed", err);
        if (!hit) {
          paneState = "failed";
          return;
        }
      }
      const next = await readGroupGrants({ api, companyUid: uid, groups: list });
      if (cancelled) return;
      read = next;
      paneState = next.outboundState === "failed" && next.inboundState === "failed" ? "failed" : "ready";
    })();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (!groups.some((g) => g.id === groupId)) groupId = groups[0]?.id ?? "";
  });

  const outbound = $derived(splitByStatus(read?.outbound ?? []));
  const inbound = $derived(splitByStatus(read?.inbound ?? []));
  const problem = $derived(grantFormProblem({ groupId, targetUids: picked, role }, { currentUid: companyUid ?? "", groups, targets: others }));
  const blocked = $derived(groups.length === 0 || others.length === 0 || !others.some((t) => t.eligible));
  const groupOptions = $derived(groups.map((g) => ({ value: g.id, label: g.name })));
  const roleOptions = GRANT_ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
  const display = $derived(companyLabel.startsWith("cmp_") ? "this company" : companyLabel);

  function toggle(uid: string): void {
    picked = picked.includes(uid) ? picked.filter((u) => u !== uid) : [...picked, uid];
  }

  async function grant(): Promise<void> {
    if (granting || problem || !companyUid || !files) return;
    granting = true;
    error = null;
    notice = null;
    const targetUids = picked.filter((uid) => others.some((t) => t.uid === uid && t.eligible));
    try {
      const outcomes = await submitGrants({ api: files, sourceCompanyUid: companyUid, groupId, targetUids, role });
      const failed = new Set(outcomes.filter((o) => !o.ok).map((o) => o.uid));
      picked = picked.filter((uid) => failed.has(uid));
      error = grantOutcomeSummary(outcomes, others);
      const okCount = outcomes.length - failed.size;
      if (okCount > 0) {
        notice = okCount > 1 ? `Access granted to ${okCount} companies.` : "Access granted.";
        nonce += 1;
      }
    } finally {
      granting = false;
    }
  }

  async function revoke(g: GroupGrant): Promise<void> {
    if (revoking || !files?.revokeGroupGrant) return;
    revoking = grantKey(g);
    error = null;
    notice = null;
    try {
      const res = await files.revokeGroupGrant({ sourceCompanyUid: g.sourceCompanyUid, groupId: g.groupId, targetCompanyUid: g.targetCompanyUid });
      if (!res.ok) {
        console.warn("[grants] revoke failed", res.code ?? res.message);
        error = grantErrorCopy(res, "revoke");
      } else {
        notice = "Grant revoked.";
      }
      nonce += 1;
    } catch (err) {
      console.warn("[grants] revoke threw", err);
      error = grantErrorCopy({ code: "network" }, "revoke");
    } finally {
      revoking = null;
    }
  }

  const fmtDate = (iso: string | null): string => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };
</script>

<div class="page-head">
  <div>
    <h2>Grants</h2>
    <p class="sub" data-testid="grants-sub">Grant {display}'s groups access to other companies, and see which external groups have access here.</p>
  </div>
  <span class="grow"></span>
  <div class="seg" role="tablist" data-testid="grants-view">
    <button type="button" class="tab" role="tab" aria-selected={view === "groups"} data-testid="grants-view-groups" onclick={() => (view = "groups")}>Groups</button>
    <button type="button" class="tab" role="tab" aria-selected={view === "grants"} data-testid="grants-view-grants" onclick={() => (view = "grants")}>Grants</button>
  </div>
</div>

{#if paneState === "unavailable"}
  <p class="note" data-testid="grants-unavailable">Grants are managed in HQ cloud. This company is not in the cloud on this device.</p>
{:else if paneState === "loading"}
  <ReadLoader testid="grants-loading" onretry={() => (nonce += 1)} />
{:else if paneState === "failed"}
  <p class="note" data-testid="grants-failed">Could not read this company's grants.</p>
  <RailButton icon="refresh" type="button" data-testid="grants-retry" onclick={() => (nonce += 1)}>Try again</RailButton>
{:else if view === "groups"}
  <section class="block" data-testid="grant-form">
    <h3>Grant a group access to another company</h3>
    <div class="form">
      <div class="field">
        <span class="lb">Group</span>
        <LazyDropdown bind:value={groupId} options={groupOptions.length ? groupOptions : [{ value: "", label: "No groups" }]} label="Group" testid="grant-group" disabled={granting || groups.length === 0} />
      </div>
      <div class="field">
        <span class="lb">Role</span>
        <LazyDropdown bind:value={role} options={roleOptions} label="Role" testid="grant-role" disabled={granting} />
      </div>
    </div>
    <div class="field">
      <span class="lb" id="grant-targets-label">Target companies</span>
      {#if others.length === 0}
        <p class="note tight">No other companies.</p>
      {:else}
        <div class="chips" role="group" aria-labelledby="grant-targets-label" data-testid="grant-targets">
          {#each others as t (t.uid)}
            <button
              type="button"
              class="chip"
              aria-pressed={picked.includes(t.uid)}
              disabled={!t.eligible || granting}
              title={t.eligible ? undefined : "You are not an owner or admin there"}
              data-testid="grant-target"
              data-uid={t.uid}
              onclick={() => toggle(t.uid)}
            ><CompanyLabel name={companyName(t.label, t.uid)} companyUid={t.uid} /></button>
          {/each}
        </div>
      {/if}
    </div>
    <p class="note tight">A granted group takes one seat in each company it is granted to. Read or Write only; admin cannot be granted across companies.</p>
    <div class="actions">
      <RailButton icon="check" variant="primary" type="button" data-testid="grant-submit" disabled={granting || problem !== null} aria-busy={granting} onclick={() => void grant()}>
        {granting ? "Granting…" : "Grant access"}
      </RailButton>
      {#if blocked && problem}<span class="c" data-testid="grant-disabled-reason">{problem}</span>{/if}
    </div>
    {#if error}<p class="note tight" data-testid="grant-error">{error}</p>{/if}
    {#if notice && !error}<p class="note tight" data-testid="grant-saved">{notice}</p>{/if}
  </section>

  <section class="block" data-testid="outbound-grants">
    <h3>Active grants</h3>
    {#if read?.outboundState === "forbidden"}
      <p class="note tight" data-testid="outbound-forbidden">Only owners and admins can see this.</p>
    {:else if read?.outboundState === "failed"}
      <p class="note tight" data-testid="outbound-failed">Could not read this company's grants.</p>
      <RailButton icon="refresh" type="button" data-testid="outbound-retry" onclick={() => (nonce += 1)}>Try again</RailButton>
    {:else if outbound.active.length === 0}
      <p class="note tight" data-testid="outbound-grants-empty">No active grants yet.</p>
    {:else}
      <div class="gt hd"><span>Group</span><span>Target company</span><span>Role</span><span>Status</span><span></span></div>
      {#each outbound.active as g (grantKey(g))}
        <div class="gt" data-testid="outbound-grant-row">
          <span class="nm">{groupName(g.groupId, groups)}</span>
          <span><CompanyLabel name={companyName(g.targetCompanyName, g.targetCompanyUid, others)} companyUid={g.targetCompanyUid} /></span>
          <span>{grantRoleLabel(g.role)}</span>
          <span>{g.status}</span>
          <span class="end">
            <RailButton icon="ban" variant="ghost" type="button" data-testid="grant-revoke" disabled={revoking !== null} aria-busy={revoking === grantKey(g)} onclick={() => (confirmRevoke = g)}>
              {revoking === grantKey(g) ? "Revoking…" : "Revoke"}
            </RailButton>
          </span>
        </div>
      {/each}
    {/if}
    {#if read && read.outboundMissing > 0}
      <p class="note tight" data-testid="outbound-partial">Grants for {read.outboundMissing} {read.outboundMissing === 1 ? "group" : "groups"} could not be read.</p>
      <RailButton icon="refresh" type="button" data-testid="outbound-partial-retry" onclick={() => (nonce += 1)}>Try again</RailButton>
    {/if}
  </section>

  {#if outbound.revoked.length}
    <section class="block" data-testid="outbound-revoked">
      <h3>Revoked grants</h3>
      {#each outbound.revoked as g (`revoked:${grantKey(g)}`)}
        <div class="gt muted" data-testid="outbound-grant-revoked-row">
          <span>{groupName(g.groupId, groups)}</span>
          <span><CompanyLabel name={companyName(g.targetCompanyName, g.targetCompanyUid, others)} companyUid={g.targetCompanyUid} /></span>
          <span>{grantRoleLabel(g.role)}</span>
          <span>revoked</span>
          <span></span>
        </div>
      {/each}
    </section>
  {/if}
{:else}
  <section class="block" data-testid="inbound-grants">
    <h3>External groups with access</h3>
    <p class="note tight">Groups from other companies that have been granted a role on {display}.</p>
    {#if read?.inboundState === "forbidden"}
      <p class="note tight" data-testid="inbound-forbidden">Only owners and admins can see this.</p>
    {:else if read?.inboundState === "failed"}
      <p class="note tight" data-testid="inbound-failed">Could not read external access.</p>
      <RailButton icon="refresh" type="button" data-testid="inbound-retry" onclick={() => (nonce += 1)}>Try again</RailButton>
    {:else if inbound.active.length === 0}
      <p class="note tight" data-testid="inbound-grants-empty">No external groups currently have access.</p>
    {:else}
      <div class="gt hd"><span>Source company</span><span>Group</span><span>Role</span><span>Granted</span><span></span></div>
      {#each inbound.active as g (grantKey(g))}
        <div class="gt" data-testid="inbound-grant-row">
          <span class="nm"><CompanyLabel name={companyName(g.sourceCompanyName, g.sourceCompanyUid, targets)} companyUid={g.sourceCompanyUid} /></span>
          <span>{g.groupId}</span>
          <span>{grantRoleLabel(g.role)}</span>
          <span>{fmtDate(g.grantedAt)}</span>
          <span></span>
        </div>
      {/each}
    {/if}
    {#if inbound.revoked.length}
      <h3 class="sub-h">Revoked grants</h3>
      {#each inbound.revoked as g (`revoked:${grantKey(g)}`)}
        <div class="gt muted" data-testid="inbound-grant-revoked-row">
          <span><CompanyLabel name={companyName(g.sourceCompanyName, g.sourceCompanyUid, targets)} companyUid={g.sourceCompanyUid} /></span>
          <span>{g.groupId}</span>
          <span>{grantRoleLabel(g.role)}</span>
          <span>revoked</span>
          <span></span>
        </div>
      {/each}
    {/if}
  </section>
{/if}

<ConfirmDialog
  open={confirmRevoke !== null}
  title="Revoke grant?"
  message={confirmRevoke
    ? `${groupName(confirmRevoke.groupId, groups)} will lose access to ${companyName(confirmRevoke.targetCompanyName, confirmRevoke.targetCompanyUid, others)}.`
    : ""}
  confirmLabel="Revoke"
  danger
  oncancel={() => (confirmRevoke = null)}
  onconfirm={() => {
    const g = confirmRevoke;
    confirmRevoke = null;
    if (g) void revoke(g);
  }}
/>

<style>
  .page-head { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .page-head h2 { margin: 0; font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); }
  .grow { flex: 1; }
  .sub, .note { margin: 0; color: var(--t3); font-size: 13px; }
  .note { margin-top: 12px; max-width: 640px; line-height: 1.45; }
  .note.tight { margin-top: 6px; }
  .seg { display: inline-flex; width: max-content; flex: none; gap: 2px; padding: 2px; border: 1px solid var(--panel-border); border-radius: 6px; background: var(--hover); }
  .tab { font: inherit; font-size: 13px; color: var(--t2); background: transparent; border: 0; border-radius: 4px; padding: 4px 8px; cursor: pointer; }
  .tab[aria-selected="true"] { background: var(--sel); color: var(--t1); }
  .block { margin-top: 20px; max-width: 760px; }
  .block:first-of-type { margin-top: 0; }
  h3 { margin: 0 0 8px; font-size: 13px; font-weight: 500; color: var(--t2); }
  .sub-h { margin-top: 16px; }
  .form { display: grid; grid-template-columns: repeat(2, minmax(0, 220px)); gap: 12px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
  .lb { font-size: 13px; color: var(--t3); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    font: inherit;
    font-size: 13px;
    color: var(--t2);
    background: transparent;
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
  }
  .chip:hover:not(:disabled) { background: var(--hover); }
  .chip[aria-pressed="true"] { background: var(--sel); color: var(--t1); }
  .chip:disabled { opacity: 0.45; cursor: default; }
  .actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .c { color: var(--t3); font-size: 13px; }
  .gt {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.2fr) 72px 96px 96px;
    gap: 8px;
    align-items: center;
    min-height: 31px;
    box-sizing: border-box;
    padding: 4px 8px;
    line-height: 17px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
    color: var(--t2);
  }
  .gt.hd { color: var(--t3); }
  .gt.muted { color: var(--t3); }
  .gt > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .end { display: flex; justify-content: flex-end; }
  .nm { color: var(--t1); }
</style>
