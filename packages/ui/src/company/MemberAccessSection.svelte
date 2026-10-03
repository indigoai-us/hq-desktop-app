<script lang="ts">
  /**
   * OWNER-R9: Joined, Role, Groups and the files and secrets a teammate can
   * reach, in the Team member pane. Loads on its own with its own loader and
   * failed state; the roster never waits for it.
   */
  import type { CompanyApi } from "@hq/platform";
  import { memberAccessView, pathWithBotNames, type MemberAccessView } from "./member-access.js";

  interface Props {
    company: Pick<CompanyApi, "getMemberAccess"> | null;
    companyUid: string | null;
    personUid: string;
    joined?: string;
    role?: string;
    badge?: string;
    botName: (id: string) => string | null;
  }

  let { company, companyUid, personUid, joined = "", role = "", badge = "", botName }: Props = $props();

  let phase = $state<"loading" | "ready" | "failed" | "unavailable">("loading");
  let access = $state<MemberAccessView | null>(null);
  let attempt = $state(0);

  $effect(() => {
    void attempt;
    const uid = companyUid;
    const person = personUid;
    access = null;
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
</script>

<section class="ma" data-testid="member-access">
  <dl class="facts">
    <dt>Joined</dt><dd data-testid="member-joined">{joined}</dd>
    <dt>Role</dt><dd data-testid="member-role">{role}{#if badge} <span class="badge">{badge}</span>{/if}</dd>
    {#if access}
      <dt>Groups</dt>
      <dd data-testid="member-groups">
        {#each access.groups as g (g)}<span class="chip">{g}</span>{:else}<span class="muted">None</span>{/each}
      </dd>
    {/if}
  </dl>
  <div class="sech">Files and secrets this teammate can access</div>
  {#if phase === "loading"}
    <p class="muted" data-testid="member-access-loading" aria-busy="true">Loading access…</p>
  {:else if phase === "failed"}
    <p class="muted" data-testid="member-access-failed">Couldn't load access. <button type="button" class="retry" onclick={() => (attempt += 1)}>Try again</button></p>
  {:else if phase === "unavailable"}
    <p class="muted" data-testid="member-access-unavailable">Access shows once this company is connected to HQ cloud.</p>
  {:else if access}
    {#if access.filesBypass}
      <p class="muted">Every file, as an owner or admin.</p>
    {/if}
    <ul class="grants" data-testid="member-access-files">
      {#each access.files as row (row.path)}
        <li><span class="path">{pathWithBotNames(row.path, botName)}</span><span class="lvl">{row.level}</span><span class="why">{row.reason}</span></li>
      {:else}
        {#if !access.filesBypass}<li class="muted">No file grants.</li>{/if}
      {/each}
    </ul>
    {#if access.secretsBypass}
      <p class="muted">Every secret, as the owner.</p>
    {:else if access.secrets.length > 0}
      <ul class="grants" data-testid="member-access-secrets">
        {#each access.secrets as row (row.path)}
          <li><span class="path">{pathWithBotNames(row.path, botName)}</span><span class="lvl">{row.level}</span><span class="why">{row.reason}</span></li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .ma { padding: 12px 16px; font-size: 13px; line-height: 17px; color: var(--t1); border-top: 1px solid var(--line); }
  .facts { display: grid; grid-template-columns: 72px 1fr; gap: 6px 8px; margin: 0 0 12px; }
  dt { color: var(--t3); }
  dd { margin: 0; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .chip, .badge { padding: 0 6px; border-radius: 999px; background: var(--hover); color: var(--t2); }
  .sech { color: var(--t2); font-weight: 500; margin: 8px 0 4px; }
  .muted { color: var(--t3); margin: 0; }
  .grants { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .grants li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 8px; }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lvl { color: var(--t2); }
  .why { grid-column: 1 / -1; color: var(--t3); }
  .retry { border: 0; background: none; padding: 0; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }
</style>
