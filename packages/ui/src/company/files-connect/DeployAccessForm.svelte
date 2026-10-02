<script lang="ts">
  /**
   * Who can open one deployment (QA-059). Reads the app's hq-deploy access
   * policy and allowlist, edits a draft, and applies it after a confirmation
   * that lists every change. A typed password is sent once and never shown.
   * Styling follows the Messages sheet (docs/design-standard-console-rail.md).
   */
  import {
    ACCESS_MODES,
    MIN_PASSWORD,
    MODE_EXPLAINER,
    MODE_LABEL,
    applyAccess,
    deployAccessClient,
    draftFrom,
    isDirty,
    isEmailPattern,
    loadAccess,
    planAccess,
    type AccessDraft,
    type AccessMode,
    type AccessState,
    type AppAccessHint,
    type DeployAccessRequest,
  } from "./deploy-access.js";

  export interface AccessMember {
    id: string;
    email: string;
    label: string;
  }

  interface Props {
    appId: string;
    appName: string;
    scope: string;
    request: DeployAccessRequest | null;
    companyUid?: string | null;
    hint?: AppAccessHint;
    members?: AccessMember[] | null;
    onclose: () => void;
    ondone?: (message: string) => void;
  }

  let { appId, appName, scope, request, companyUid = null, hint = {}, members = null, onclose, ondone }: Props = $props();

  const client = $derived(request ? deployAccessClient(request, scope) : null);

  let current = $state<AccessState | null>(null);
  let draft = $state<AccessDraft | null>(null);
  let loadError = $state<string | null>(null);
  let saveError = $state<string | null>(null);
  let confirming = $state(false);
  let saving = $state(false);
  let entry = $state("");

  $effect(() => {
    const c = client;
    const id = appId;
    current = null;
    draft = null;
    loadError = null;
    confirming = false;
    if (!c) {
      loadError = "Access settings need the desktop app.";
      return;
    }
    let live = true;
    void loadAccess(c, id, hint, companyUid ?? "")
      .then((state) => {
        if (!live) return;
        current = state;
        draft = draftFrom(state);
      })
      .catch((err: unknown) => {
        if (live) loadError = err instanceof Error && err.message ? err.message : "Could not load access.";
      });
    return () => {
      live = false;
    };
  });

  const nameFor = (id: string) => members?.find((m) => m.id === id)?.label ?? id;
  const dirty = $derived(!!current && !!draft && isDirty(current, draft));
  const plan = $derived(current && draft ? planAccess(current, draft, appId, nameFor) : null);
  const canSave = $derived(dirty && !!plan && !plan.blocked && plan.steps.length > 0 && !saving);
  const memberChoices = $derived((members ?? []).filter((m) => m.id && !draft?.users.includes(m.id)));

  function pickMode(mode: AccessMode) {
    if (!draft) return;
    draft.mode = mode;
    if (mode !== "password") draft.password = "";
    entry = "";
    confirming = false;
  }

  function addEmail() {
    if (!draft) return;
    const v = entry.trim().toLowerCase();
    if (!isEmailPattern(v) || draft.emails.some((e) => e.toLowerCase() === v)) return;
    draft.emails = [...draft.emails, v];
    entry = "";
  }

  function addPerson() {
    if (!draft) return;
    const v = entry.trim().toLowerCase();
    const hit = (members ?? []).find((m) => m.id && (m.email.toLowerCase() === v || m.id === entry.trim()));
    if (!hit || draft.users.includes(hit.id)) return;
    draft.users = [...draft.users, hit.id];
    entry = "";
  }

  async function apply() {
    if (!client || !plan || !canSave) return;
    saving = true;
    saveError = null;
    try {
      await applyAccess(client, plan);
      const label = draft ? MODE_LABEL[draft.mode] : "";
      // Drop the typed password before anything else renders.
      if (draft) draft.password = "";
      const fresh = await loadAccess(client, appId, { ...hint, privateMode: draft?.mode === "private" }, companyUid ?? "");
      current = fresh;
      draft = draftFrom(fresh);
      confirming = false;
      ondone?.(`Access for ${appName} saved: ${label}.`);
    } catch (err) {
      saveError = err instanceof Error && err.message ? err.message : "Could not save access.";
    } finally {
      saving = false;
    }
  }
</script>

<div class="sb" data-testid="deploy-access-form">
  <div class="fr"><span class="lb">Deployment</span><span>{appName}</span></div>
  {#if loadError}
    <p class="hint err" role="alert" data-testid="deploy-access-error">{loadError}</p>
  {:else if !current || !draft}
    <div class="skel" aria-busy="true" data-testid="deploy-access-loading">
      {#each [0, 1, 2] as row (row)}<span class="skel-row"><i class="skel-line" style:width="{70 - row * 12}%"></i></span>{/each}
    </div>
  {:else if confirming && plan}
    <div class="confirm" data-testid="deploy-access-confirm">
      <p class="sec">This will apply:</p>
      <ul>
        {#each plan.summary as line, i (i)}<li>{line}</li>{/each}
      </ul>
    </div>
  {:else}
    <div class="fr top">
      <span class="lb">Who can open</span>
      <div class="modes" role="radiogroup" aria-label="Who can open">
        {#each ACCESS_MODES as mode (mode)}
          <button
            class="mode"
            type="button"
            role="radio"
            aria-checked={draft.mode === mode}
            data-testid={`access-mode-${mode}`}
            onclick={() => pickMode(mode)}
          >
            <span class="mode-name">{MODE_LABEL[mode]}{#if current.mode === mode}<span class="now"> · current</span>{/if}</span>
            <span class="mode-why">{MODE_EXPLAINER[mode]}</span>
          </button>
        {/each}
      </div>
    </div>

    {#if draft.mode === "password"}
      <label class="fr">
        <span class="lb">{current.mode === "password" ? "New password" : "Password"}</span>
        <input
          class="field"
          type="password"
          autocomplete="new-password"
          data-testid="access-password"
          placeholder={current.mode === "password" ? "Leave empty to keep the current one" : `At least ${MIN_PASSWORD} characters`}
          bind:value={draft.password}
        />
      </label>
      {#if current.mode === "password"}<p class="hint">A password is set. It is never shown here.</p>{/if}
    {:else if draft.mode === "selected"}
      <div class="fr top">
        <span class="lb">People</span>
        <div class="grants" data-testid="access-grants">
          {#each draft.users as id (id)}
            <span class="chip">{nameFor(id)}<button class="x" type="button" aria-label={`Remove ${nameFor(id)}`} onclick={() => draft && (draft.users = draft.users.filter((u) => u !== id))}>×</button></span>
          {/each}
          {#each draft.groups as id (id)}
            <span class="chip"><span class="mono">{id}</span><button class="x" type="button" aria-label={`Remove group ${id}`} onclick={() => draft && (draft.groups = draft.groups.filter((g) => g !== id))}>×</button></span>
          {/each}
          {#if draft.users.length + draft.groups.length === 0}<span class="none">No one yet</span>{/if}
          <span class="add">
            <input class="field" list="deploy-access-members" data-testid="access-person" placeholder={members === null ? "Loading people…" : "name@company.com"} autocomplete="off" bind:value={entry} onkeydown={(e) => e.key === "Enter" && addPerson()} />
            <button class="btn" type="button" data-testid="access-person-add" onclick={addPerson}>Add</button>
          </span>
          <datalist id="deploy-access-members">
            {#each memberChoices as m (m.id)}<option value={m.email}>{m.label}</option>{/each}
          </datalist>
        </div>
      </div>
    {:else if draft.mode === "private"}
      <div class="fr top">
        <span class="lb">Allowlist</span>
        <div class="grants" data-testid="access-grants">
          {#each draft.emails as email (email)}
            <span class="chip">{email}<button class="x" type="button" aria-label={`Remove ${email}`} onclick={() => draft && (draft.emails = draft.emails.filter((e) => e !== email))}>×</button></span>
          {/each}
          {#if draft.emails.length === 0}<span class="none">No one yet</span>{/if}
          <span class="add">
            <input class="field" type="text" data-testid="access-email" placeholder="name@company.com or @company.com" autocomplete="off" spellcheck="false" bind:value={entry} onkeydown={(e) => e.key === "Enter" && addEmail()} />
            <button class="btn" type="button" data-testid="access-email-add" disabled={!isEmailPattern(entry)} onclick={addEmail}>Add</button>
          </span>
        </div>
      </div>
    {/if}
    {#if plan?.blocked && dirty}<p class="hint" data-testid="access-blocked">{plan.blocked}</p>{/if}
  {/if}
  {#if saveError}<p class="hint err" role="alert" data-testid="access-save-error">{saveError}</p>{/if}
</div>
<footer class="sf">
  <span class="hint grow">{dirty && !confirming ? "Unsaved changes" : ""}</span>
  {#if confirming}
    <button class="btn" type="button" disabled={saving} onclick={() => (confirming = false)}>Back</button>
    <button class="btn primary" type="button" data-testid="access-apply" disabled={!canSave} aria-busy={saving} onclick={() => void apply()}>{saving ? "Saving…" : "Apply"}</button>
  {:else}
    <button class="btn" type="button" onclick={onclose}>Cancel</button>
    <button class="btn primary" type="button" data-testid="access-save" disabled={!canSave} onclick={() => (confirming = true)}>Save</button>
  {/if}
</footer>

<style>
  /* Messages sheet metrics (chat/NewChannelSheet.svelte); 13px only. */
  .sb { overflow: auto; }
  .fr { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; align-items: center; min-height: 28px; padding: 10px 20px; border-bottom: 1px solid var(--panel-border, var(--v4-rowline)); }
  .fr.top { align-items: start; }
  .lb { color: var(--t3, var(--v4-text-3)); }
  .hint { margin: 0; padding: 10px 20px; color: var(--t3, var(--v4-text-3)); }
  .hint.err { color: var(--red, var(--v4-error)); }
  .sf { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--panel-border, var(--v4-hairline)); }
  .sf .hint { padding: 0; }
  .grow { flex: 1; }
  .modes { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .mode { display: flex; flex-direction: column; align-items: flex-start; gap: 0; border: 0; border-radius: 6px; background: transparent; color: var(--t2, var(--v4-text-2)); padding: 5px 8px; text-align: left; cursor: pointer; }
  .mode:hover { background: var(--hover, var(--v4-hover)); }
  .mode[aria-checked="true"] { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); }
  .mode-name { font-weight: 500; }
  .now { font-weight: 400; color: var(--t3, var(--v4-text-3)); }
  .mode-why { color: var(--t3, var(--v4-text-3)); }
  .grants { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 4px 1px 8px; border-radius: 980px; background: var(--btn-bg, var(--v4-hover)); color: var(--t1, var(--v4-text-1)); max-width: 100%; overflow-wrap: anywhere; }
  .x { width: 18px; height: 18px; border: 0; border-radius: 999px; background: transparent; color: var(--t3, var(--v4-text-3)); padding: 0; cursor: pointer; line-height: 1; }
  .x:hover { background: var(--hover, var(--v4-hover)); color: var(--t1, var(--v4-text-1)); }
  .none { color: var(--t3, var(--v4-text-3)); }
  .add { display: flex; gap: 6px; width: 100%; }
  .add .field { flex: 1; }
  .field { height: 28px; border-radius: 6px; border: 1px solid var(--line2, var(--v4-control-border)); background: transparent; color: inherit; padding: 0 8px; min-width: 0; }
  .btn { height: 26px; border-radius: 6px; border: 1px solid var(--line2, var(--v4-control-border)); background: transparent; color: var(--t1, var(--v4-text-1)); padding: 0 10px; cursor: pointer; white-space: nowrap; }
  .btn:hover:not(:disabled) { background: var(--hover, var(--v4-hover)); }
  .btn.primary { background: var(--t1, var(--v4-text-1)); color: var(--panel-bg, var(--v4-ground)); border-color: transparent; }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); }
  .confirm { padding: 10px 20px; }
  .confirm .sec { margin: 0 0 6px; font-weight: 500; }
  .confirm ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
  .skel { display: flex; flex-direction: column; padding: 6px 20px; }
  .skel-row { display: flex; align-items: center; height: 32px; }
  .skel-line { height: 10px; border-radius: 4px; background: var(--line, var(--v4-control-faint)); }
</style>
