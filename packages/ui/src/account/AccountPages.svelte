<script lang="ts">
  /**
   * Profile, Billing (invoice pane), and Settings (US-035).
   * First frame is the account cache. Stripe opens only through approved URLs.
   * The update card reads update-store. Section ids are SettingsPage's.
   */
  import "../home/tokens.css";
  import "../chat/chat-tokens.css";
  import { restartToUpdate, updateStore } from "../settings/update-store.svelte.js";
  import type { AccountPageId, AccountRoleRow } from "../shell/account-menu.js";
  import {
    ACCOUNT_SETTINGS_SECTIONS,
    deleteConfirmed,
    invoicePdfUrl,
    invoiceStripeUrl,
    managePaymentUrl,
    paintAccount,
    readAccountCache,
    recordShortcut,
    updateReady,
    writeAccountCache,
    type AccountCache,
    type AccountCompany,
  } from "./account-pages.js";

  interface Props {
    page: AccountPageId;
    name: string;
    email?: string;
    initials?: string;
    live?: boolean;
    roles: readonly AccountRoleRow[];
    openExternal?: (url: string) => void;
    onsignout?: () => void;
    oncompany?: (uid: string) => void;
    onsettingssection?: (section: string) => void;
  }

  let {
    page,
    name,
    email = "",
    initials = "",
    live = false,
    roles,
    openExternal,
    onsignout,
    oncompany,
    onsettingssection,
  }: Props = $props();

  let view = $state<AccountPageId>(page);
  let data = $state<AccountCache>(paintAccount(null, { name, email, companies: [] }));
  let invoiceId = $state<string | null>(null);
  let confirmDelete = $state(false);
  let deleteTyped = $state("");
  let shortcutsOpen = $state(false);
  let recordingId = $state<string | null>(null);
  let conflict = $state<string | null>(null);
  let draftKeys = $state("");
  let savedLabel = $state("Saved");

  $effect(() => {
    view = page;
  });

  const companies = $derived<AccountCompany[]>(
    roles.map((row) => ({
      uid: row.uid,
      label: row.label,
      role: row.role,
      plan: "HQ Workforce",
      since: "",
    })),
  );

  $effect(() => {
    data = paintAccount(readAccountCache(), { name, email, companies });
  });

  const invoice = $derived(data.invoices.find((row) => row.id === invoiceId) ?? null);
  const ready = $derived(updateReady(updateStore.installPhase, updateStore.appStatus));
  const mark = $derived(
    initials.trim().slice(0, 2).toUpperCase() ||
      name.trim().slice(0, 2).toUpperCase() ||
      "?",
  );

  function save(next: AccountCache): void {
    data = next;
    writeAccountCache(next);
    savedLabel = "Saved";
  }

  function openUrl(url: string): void {
    openExternal?.(url);
  }

  function onRecordKey(event: KeyboardEvent): void {
    if (!recordingId) return;
    if (event.key === "Escape") {
      recordingId = null;
      draftKeys = "";
      return;
    }
    if (["Shift", "Meta", "Control", "Alt"].includes(event.key)) return;
    event.preventDefault();
    const parts: string[] = [];
    if (event.metaKey || event.ctrlKey) parts.push("⌘");
    if (event.shiftKey) parts.push("⇧");
    if (event.altKey) parts.push("⌥");
    parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
    draftKeys = parts.join("");
    const next = recordShortcut(data.shortcuts, recordingId, draftKeys);
    conflict = next.conflict;
  }

  function commitRecording(): void {
    if (!recordingId || !draftKeys) {
      recordingId = null;
      return;
    }
    const next = recordShortcut(data.shortcuts, recordingId, draftKeys);
    if (next.conflict) {
      conflict = next.conflict;
      return;
    }
    save({ ...data, shortcuts: next.rows });
    recordingId = null;
    draftKeys = "";
    conflict = null;
  }

  function confirmDeleteAccount(): void {
    if (!deleteConfirmed(deleteTyped)) return;
    confirmDelete = false;
    deleteTyped = "";
    onsignout?.();
  }
</script>

<svelte:window onkeydown={onRecordKey} />

<div class="account" data-testid="account-pages" data-view={view}>
  <aside class="pane" aria-label="Account">
    <div class="who">
      <span class="av">{mark}{#if live}<i class="ld"></i>{/if}</span>
      <span>
        <span class="nm">{data.displayName}</span>
        {#if data.email}<span class="em">{data.email}</span>{/if}
      </span>
    </div>
    <div class="sec">You</div>
    <button type="button" class="row" class:on={view === "profile"} aria-current={view === "profile"} data-testid="nav-profile" onclick={() => (view = "profile")}>Profile</button>
    <button type="button" class="row" class:on={view === "billing"} aria-current={view === "billing"} data-testid="nav-billing" onclick={() => (view = "billing")}>Billing</button>
    <button type="button" class="row" class:on={view === "settings"} aria-current={view === "settings"} data-testid="nav-settings" onclick={() => (view = "settings")}>
      Settings
      {#if ready}<span class="count">1</span>{/if}
    </button>
    {#if companies.length > 0}
      <div class="sec">Companies</div>
      {#each companies as company (company.uid)}
        <button type="button" class="row" data-testid="account-company" onclick={() => oncompany?.(company.uid)}>
          <span class="t">{company.label}</span>
          <span class="role">{company.role}</span>
        </button>
      {/each}
    {/if}
    <div class="foot">
      <button type="button" class="row quiet" data-testid="account-pane-sign-out" onclick={() => onsignout?.()}>Sign out</button>
    </div>
  </aside>

  <main class="content">
    {#if view === "profile"}
      <div class="toolbar">
        <b>Profile</b>
        <span class="sub">Your identity across HQ</span>
        <span class="grow"></span>
        <span class="sub">{savedLabel}</span>
        <button type="button" class="btn primary" data-testid="profile-save" onclick={() => save(data)}>Save</button>
      </div>
      <div class="canvas">
        <div class="sech">Identity</div>
        <label class="frow">Display name <input class="fld" bind:value={data.displayName} /></label>
        <label class="frow">Handle <span class="fld"><span class="pre">@</span><input bind:value={data.handle} /></span></label>
        <div class="frow">Email <span class="fld">{data.email || "—"}{#if data.email}<span class="ok">Verified</span>{/if}</span></div>
        <label class="frow">Timezone <input class="fld" bind:value={data.timezone} /></label>
        <label class="frow">Pronouns <input class="fld" bind:value={data.pronouns} /></label>
        <label class="frow">Bio <textarea class="fld ta" bind:value={data.bio}></textarea></label>
        <label class="frow">How bots address you <textarea class="fld ta" bind:value={data.botAddress}></textarea></label>
        <div class="sech">Companies and roles</div>
        <table class="tbl">
          <thead><tr><th>Company</th><th>Role</th><th>Plan</th><th></th></tr></thead>
          <tbody>
            {#each companies as company (company.uid)}
              <tr>
                <td>{company.label}</td>
                <td>{company.role}</td>
                <td>{company.plan}</td>
                <td><button type="button" class="link" onclick={() => oncompany?.(company.uid)}>Company settings</button></td>
              </tr>
            {:else}
              <tr><td colspan="4">No companies yet.</td></tr>
            {/each}
          </tbody>
        </table>
        <div class="danger">
          <span>Deleting your account removes your personal vault, secrets, and sessions. Companies you own must be transferred first.</span>
          <button type="button" class="del" data-testid="delete-account" onclick={() => (confirmDelete = true)}>Delete account</button>
        </div>
      </div>
    {:else if view === "billing"}
      <div class="toolbar">
        <b>Billing</b>
        {#if invoice}<span class="sub">› Invoice</span>{/if}
        <span class="grow"></span>
        <button type="button" class="btn" data-testid="manage-payment" onclick={() => openUrl(managePaymentUrl())}>Manage payment</button>
      </div>
      <div class="split">
        <div class="canvas">
          <div class="sech">Invoice history</div>
          <table class="tbl">
            <thead><tr><th>Date</th><th>Invoice</th><th>Summary</th><th>Status</th><th>Amount</th></tr></thead>
            <tbody>
              {#each data.invoices as row (row.id)}
                <tr
                  aria-current={invoiceId === row.id}
                  data-testid="invoice-row"
                  onclick={() => (invoiceId = row.id)}
                >
                  <td class="mono">{row.date}</td>
                  <td class="mono">{row.id}</td>
                  <td>{row.summary}</td>
                  <td>{row.status}</td>
                  <td>{row.amount}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if invoice}
          <aside class="invoice" data-testid="invoice-pane" aria-label="Invoice">
            <h2>{invoice.id}</h2>
            <p>{invoice.summary}</p>
            <p class="amt">{invoice.amount} · {invoice.status}</p>
            <div class="acts">
              <button type="button" class="btn primary" data-testid="invoice-pdf" onclick={() => openUrl(invoicePdfUrl(invoice.id))}>Download PDF</button>
              <button type="button" class="btn" data-testid="invoice-stripe" onclick={() => openUrl(invoiceStripeUrl(invoice.id))}>Open in Stripe</button>
            </div>
          </aside>
        {/if}
      </div>
    {:else}
      <div class="toolbar">
        <b>Settings</b>
        {#if ready}<span class="chip" data-testid="update-ready-chip">Update ready</span>{/if}
        <span class="grow"></span>
      </div>
      <div class="canvas cols">
        <div>
          <div class="sech">Keyboard shortcuts</div>
          {#each data.shortcuts as row (row.id)}
            <div class="frow">
              <span>{row.label}</span>
              <kbd>{row.keys}</kbd>
            </div>
          {/each}
          <button type="button" class="link" data-testid="edit-shortcuts" onclick={() => (shortcutsOpen = true)}>Edit shortcuts</button>
          <div class="sech">HQ settings</div>
          {#each ACCOUNT_SETTINGS_SECTIONS as section (section.id)}
            <button type="button" class="frow linkish" data-testid="settings-section" data-section={section.id} onclick={() => onsettingssection?.(section.id)}>
              {section.label}
            </button>
          {/each}
        </div>
        <div>
          <div class="sech">About</div>
          {#if ready}
            <div class="card" data-testid="update-card">
              <div class="sech">Update downloaded</div>
              <p>{updateStore.availableVersion ?? "A new version"} is ready. Restart to finish installing.</p>
              <div class="bar" style="width: {updateStore.downloadPercent ?? 100}%"></div>
              <div class="acts">
                <button type="button" class="btn" data-testid="update-later">Later</button>
                <button
                  type="button"
                  class="btn primary"
                  data-testid="restart-to-update"
                  onclick={() => void restartToUpdate({ installDownloadedUpdate: async () => ({ ok: true, value: null }) })}
                >Restart to update</button>
              </div>
            </div>
          {:else}
            <p class="sub">HQ is up to date.</p>
          {/if}
        </div>
      </div>
    {/if}
  </main>

  {#if confirmDelete}
    <div class="scrim" data-testid="confirm-delete-account">
      <div class="sheet" role="dialog" aria-label="Delete account">
        <h2>Delete account</h2>
        <p>This removes your personal vault, secrets, and sessions. Type delete to confirm. You will land on sign-in.</p>
        <input class="fld" data-testid="delete-phrase" bind:value={deleteTyped} />
        <div class="acts">
          <button type="button" class="btn" onclick={() => (confirmDelete = false)}>Cancel</button>
          <button type="button" class="btn del" data-testid="delete-confirm" disabled={!deleteConfirmed(deleteTyped)} onclick={confirmDeleteAccount}>Delete account</button>
        </div>
      </div>
    </div>
  {/if}

  {#if shortcutsOpen}
    <div class="scrim" data-testid="shortcuts-editor">
      <div class="sheet" role="dialog" aria-label="Keyboard shortcuts">
        <h2>Keyboard shortcuts</h2>
        {#each data.shortcuts as row (row.id)}
          <div class="frow" data-recording={recordingId === row.id}>
            <span>{row.label}</span>
            {#if recordingId === row.id}
              <span class="fld" data-testid="shortcut-recording">Press keys… {draftKeys}</span>
              <button type="button" class="btn" onclick={() => (recordingId = null)}>Cancel</button>
            {:else}
              <kbd>{row.keys}</kbd>
              <button type="button" class="link" data-testid="shortcut-edit" onclick={() => { recordingId = row.id; draftKeys = ""; conflict = null; }}>Edit</button>
            {/if}
          </div>
        {/each}
        {#if conflict}<p class="hint" data-testid="shortcut-conflict">{conflict}</p>{/if}
        <div class="acts">
          <button type="button" class="btn" onclick={() => (shortcutsOpen = false)}>Cancel</button>
          <button type="button" class="btn primary" data-testid="shortcut-save" onclick={() => { commitRecording(); shortcutsOpen = false; }}>Save</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .account {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--v4-bg, transparent);
    color: var(--v4-text-1);
    font-family: var(--font-ui);
  }
  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--side-bg);
    border-right: 1px solid var(--v4-rowline);
    overflow: auto;
    padding: 8px;
  }
  .who { display: flex; gap: 10px; align-items: center; padding: 8px; }
  .av {
    position: relative;
    width: 32px; height: 32px; border-radius: 50%;
    display: grid; place-items: center;
    background: var(--v4-control-bg);
    font-size: 12px; font-weight: 600;
  }
  .ld {
    position: absolute; right: -1px; bottom: -1px;
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--v4-ok); border: 2px solid var(--v4-sidebar, var(--side-bg));
  }
  .nm { display: block; font-size: 13px; font-weight: 600; }
  .em, .sub { display: block; font-size: 12px; color: var(--v4-text-3); }
  .sec {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--v4-text-2);
    padding: 10px 8px 4px;
  }
  .row {
    display: flex; align-items: center; gap: 8px;
    width: 100%; text-align: left;
    border: 0; background: transparent;
    color: var(--v4-text-1);
    border-radius: 8px;
    padding: 6px 8px;
    font-size: 14px;
  }
  .row.on, .row[aria-current="true"] { background: var(--v4-active-row); }
  .row:hover { background: var(--v4-hover); }
  .role, .count { margin-left: auto; font-size: 12px; color: var(--v4-text-3); }
  .foot { margin-top: auto; }
  .quiet { color: var(--v4-text-3); }
  .content { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .toolbar {
    display: flex; align-items: center; gap: 8px;
    min-height: 52px; padding: 0 16px;
    border-bottom: 1px solid var(--v4-rowline);
    font-size: 15px;
  }
  .grow { flex: 1; }
  .canvas { overflow: auto; padding: 16px 20px 32px; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) 380px; min-height: 0; flex: 1; }
  .split .canvas { border-right: 1px solid var(--v4-rowline); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
  .sech {
    font-family: var(--font-mono);
    font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--v4-text-2); margin: 18px 0 6px;
  }
  .frow {
    display: grid; grid-template-columns: 168px minmax(0, 1fr);
    gap: 12px; align-items: center;
    min-height: 40px; padding: 6px 0;
    border-bottom: 1px solid var(--v4-rowline);
    font-size: 13px; color: var(--v4-text-2);
  }
  .fld, .frow input, .frow textarea {
    max-width: 360px;
    border-radius: var(--v4-radius-field, 6px);
    background: var(--v4-control-faint);
    border: 1px solid var(--v4-control-border);
    color: var(--v4-text-1);
    font: inherit;
    padding: 4px 8px;
  }
  .ta { min-height: 56px; }
  .pre { color: var(--v4-text-3); font-family: var(--font-mono); }
  .ok { color: var(--v4-ok); margin-left: 8px; font-size: 12px; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl th {
    font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em;
    text-transform: uppercase; font-weight: 400; color: var(--v4-text-3); text-align: left;
  }
  .tbl td, .tbl th { padding: 8px 8px 8px 0; border-bottom: 1px solid var(--v4-rowline); }
  .tbl tr[aria-current="true"] td { background: var(--v4-active-row); color: var(--v4-text-1); }
  .mono { font-family: var(--font-mono); font-size: 12px; color: var(--v4-text-3); }
  .link, .linkish {
    background: none; border: 0; padding: 0;
    color: var(--v4-text-2); text-decoration: underline; text-underline-offset: 3px;
    font-size: 12px; cursor: pointer;
  }
  .danger {
    margin-top: 22px; padding-top: 14px;
    border-top: 1px solid var(--v4-rowline);
    display: flex; gap: 16px; align-items: center;
    font-size: 12px; color: var(--v4-text-3);
  }
  .del { color: var(--v4-error); background: none; border: 0; font-weight: 500; cursor: pointer; }
  .btn {
    border: 1px solid var(--v4-control-border);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 13px;
  }
  .btn.primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); }
  .invoice { padding: 16px; }
  .amt { font-size: 20px; font-weight: 600; }
  .acts { display: flex; gap: 8px; margin-top: 12px; }
  .card {
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    padding: 12px;
    background: var(--v4-control-faint);
  }
  .bar { height: 3px; background: var(--v4-text-2); border-radius: 2px; }
  .chip { font-size: 12px; color: var(--v4-text-2); }
  kbd {
    font-family: var(--font-mono); font-size: 11px;
    border: 1px solid var(--v4-control-border);
    background: var(--v4-control-faint);
    border-radius: 4px; padding: 1px 6px;
  }
  .scrim {
    position: absolute; inset: 0;
    background: rgba(0, 0, 0, 0.34);
    display: grid; place-items: center;
  }
  .sheet {
    width: 480px; max-width: calc(100% - 32px);
    background: var(--v4-popover);
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    box-shadow: var(--v4-shadow-popover);
    padding: 20px;
    color: var(--v4-text-2);
  }
  .sheet h2 { margin: 0 0 8px; color: var(--v4-text-1); font-size: 15px; }
  .hint { color: var(--v4-text-3); font-size: 12px; }
  .account { position: relative; }
</style>
