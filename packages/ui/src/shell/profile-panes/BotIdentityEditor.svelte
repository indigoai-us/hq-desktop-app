<script lang="ts">
  import { untrack } from 'svelte';
  import type { AgentsApi, AgentProfilePatch } from '@hq/platform';
  import RailIcon from '../../common/button/RailIcon.svelte';
  import { profileFromPayload, headerFromStatusPayload } from '../../chat/agent-detail-model.js';

  let { uid, name, handle = '', runtimeKind = null, agents = null, onupdated }: {
    uid: string | null;
    name: string;
    handle?: string;
    runtimeKind?: "local" | "cloud" | null;
    agents?: AgentsApi | null;
    onupdated?: (patch: AgentProfilePatch) => void;
  } = $props();
  const id = $props.id();
  let baseline = $state({ displayName: '', title: '', description: '' });
  let values = $state({ displayName: '', title: '', description: '' });
  let loading = $state(true);
  let busy = $state(false);
  let editable = $state(false);
  let titleEditable = $state(false);
  let descriptionEditable = $state(false);
  let error = $state('');
  let saved = $state(false);
  let retry = $state(0);
  let generation = 0;
  const dirty = $derived(JSON.stringify(values) !== JSON.stringify(baseline));
  const valid = $derived(values.displayName.trim().length > 0);

  const stableUid = $derived(uid);
  const stableAgents = $derived(agents);
  const stableRuntimeKind = $derived(runtimeKind);
  $effect(() => {
    const agent = stableUid;
    const api = stableAgents;
    void retry;
    const initialName = untrack(() => name);
    const current = ++generation;
    loading = true;
    busy = false;
    editable = false;
    titleEditable = false;
    descriptionEditable = false;
    error = '';
    saved = false;
    const initial = { displayName: initialName, title: '', description: '' };
    baseline = initial;
    values = { ...initial };
    void (async () => {
      try {
        if (stableRuntimeKind === 'local') { error = 'Local bot profile editing is not supported by this desktop API. Model settings are available in Brain.'; return; }
        if (!agent || !api) { error = 'Profile editing is not available for this bot in this view.'; return; }
        const seed = { uid: agent, displayName: initialName };
        const response = api.getProfile ? await api.getProfile(agent) : null;
        if (current !== generation) return;
        const profile = response?.ok ? profileFromPayload(response.value, seed) : null;
        let header = profile?.header;
        if (!header) {
          const status = await api.getStatus(agent);
          if (current !== generation) return;
          if (!status.ok) { error = 'Could not load editable details. You may need owner or admin access.'; return; }
          header = headerFromStatusPayload(status.value, seed);
        }
        baseline = { displayName: header.displayName, title: header.title, description: header.description };
        values = { ...baseline };
        editable = header.canManage && typeof api.updateProfile === 'function';
        // Older status responses cannot establish whether the title is editable.
        titleEditable = editable && !!profile?.editable.title;
        descriptionEditable = editable && (profile?.editable.description ?? true);
        if (!editable) error = 'Editing is not available for this profile.';
      } catch { if (current === generation) error = 'Could not load bot details. Try again.'; }
      finally { if (current === generation) loading = false; }
    })();
    return () => { generation++; };
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!uid || !agents || !editable || busy || !dirty || !valid) return;
    const patch: AgentProfilePatch = {};
    if (values.displayName.trim() !== baseline.displayName) patch.displayName = values.displayName.trim();
    if (titleEditable && values.title.trim() !== baseline.title) patch.title = values.title.trim();
    if (descriptionEditable && values.description.trim() !== baseline.description) patch.description = values.description.trim();
    if (!Object.keys(patch).length) { values = { ...baseline }; return; }
    const current = generation;
    busy = true; error = ''; saved = false;
    try {
      const result = await agents.updateProfile(uid, patch);
      if (current !== generation) return;
      if (!result.ok) { error = 'Could not save changes. Check your connection and editing permissions, then try again.'; return; }
      baseline = { ...baseline, ...patch };
      values = { ...baseline };
      saved = true;
      onupdated?.(patch);
    } catch { if (current === generation) error = 'Could not save changes. Your edits are still here; try again.'; }
    finally { if (current === generation) busy = false; }
  }
</script>

<form onsubmit={save} class="editor" aria-label="Edit bot details" aria-busy={loading || busy} data-testid="bot-identity-editor">
  <div class="heading"><span class="symbol"><RailIcon name="pencil" /></span><div><h3>Make this bot your own</h3><p>A clear name and purpose help your team know when to bring it in.</p></div></div>
  <fieldset disabled={loading || busy || !editable}>
    <label for="{id}-name">Bot name</label>
    <input id="{id}-name" data-testid="edit-bot-name" bind:value={values.displayName} required aria-invalid={!valid} autocomplete="off" />
    {#if !valid}<p class="error">Give your bot a name.</p>{/if}
    <label for="{id}-title">Role / title {#if !loading && !titleEditable}<span>Read-only</span>{/if}</label>
    <input id="{id}-title" bind:value={values.title} readonly={!titleEditable} placeholder={loading ? 'Loading…' : 'No title set'} />
    <label for="{id}-purpose">Purpose {#if !loading && !descriptionEditable}<span>Read-only</span>{/if}</label>
    <textarea id="{id}-purpose" bind:value={values.description} readonly={!descriptionEditable} rows="4" placeholder="Describe what this bot helps your team do."></textarea>
  </fieldset>
  <div class="handle"><span>Handle</span><code>{handle || 'Not available'}</code><span class="muted">Managed by HQ</span></div>
  {#if loading}<p role="status">Loading current details…</p>{/if}
  {#if error}<p class="error" role="alert">{error} {#if !editable && agents && runtimeKind !== 'local'}<button type="button" class="retry" onclick={() => retry++}>Try again</button>{/if}</p>{/if}
  <footer><span role="status">{busy ? 'Saving changes…' : dirty ? 'Unsaved changes' : saved ? 'Changes saved' : 'Changes apply when you save.'}</span><div>
    <button type="button" class="button" disabled={!dirty || busy} onclick={() => { values = { ...baseline }; error = ''; saved = false; }}>Reset</button>
    <button type="submit" class="button primary" data-testid="edit-bot-save" disabled={loading || busy || !editable || !dirty || !valid}><RailIcon name="save" />{busy ? 'Saving…' : 'Save changes'}</button>
  </div></footer>
</form>

<style>
  .editor { border: 1px solid var(--v4-rowline, var(--line)); border-radius: 18px; background: color-mix(in srgb, var(--v4-text-1) 2%, transparent); padding: 20px; color: var(--v4-text-1); }
  .heading { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 24px; }
  .symbol { display: grid; place-items: center; width: 34px; height: 34px; flex: none; background: var(--v4-control-bg); border-radius: 11px; }
  h3 { margin: 0; font: 500 13px/1.5 var(--font-ui); }
  p { margin: 4px 0 0; color: var(--v4-text-3); font-size: 13px; line-height: 1.5; }
  fieldset { padding: 0; border: 0; margin: 0; min-width: 0; display: grid; gap: 8px; }
  label { display: flex; justify-content: space-between; font-size: 13px; font-weight: 500; }
  label:not(:first-child) { margin-top: 12px; }
  label span { font-weight: 400; color: var(--v4-text-3); }
  input, textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--v4-control-border, var(--line)); border-radius: 10px; padding: 10px 12px; background: var(--v4-control-faint, transparent); color: var(--v4-text-1); font: inherit; }
  textarea { resize: vertical; min-height: 96px; }
  input:read-only, textarea:read-only, fieldset:disabled { opacity: .65; }
  input:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--v4-text-2); outline-offset: 2px; }
  .handle { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; font-size: 13px; }
  code { overflow-wrap: anywhere; }.muted { margin-left: auto; color: var(--v4-text-3); }
  footer { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--v4-rowline, var(--line)); display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
  footer > span { color: var(--v4-text-3); font-size: 12px; flex: 1; } footer > div { display: flex; gap: 8px; }
  .button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: var(--hq-btn-h); border: 1px solid var(--v4-control-border, var(--line)); border-radius: 999px; background: transparent; padding: 0 14px; color: var(--v4-text-1); font: inherit; cursor: pointer; }
  .primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); border-color: transparent; }.button:disabled { opacity: .4; cursor: default; }
  .error { color: var(--v4-text-1); }.retry { color: inherit; background: none; border: 0; text-decoration: underline; font: inherit; cursor: pointer; }
</style>
