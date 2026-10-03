<script lang="ts">
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import RailButton from "../common/button/RailButton.svelte";
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
    aboutUpdateLine,
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
    /** RELEASE-001 gate: the Edit shortcuts sheet does not persist yet. */
    shortcutEditing?: boolean;
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
    shortcutEditing = true,
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
  // Restart card only once a package is staged; otherwise the About line
  // reads the same store as the Home banner (QA-051).
  const ready = $derived(updateStore.installPhase === "ready");
  const aboutLine = $derived(
    aboutUpdateLine({
      installPhase: updateStore.installPhase,
      appStatus: updateStore.appStatus,
      availableVersion: updateStore.availableVersion,
      backgroundUpdatesOff: updateStore.backgroundUpdatesOff,
    }),
  );
  // "Later" hides the restart card for this visit; the toolbar status stays.
  let updateDeferred = $state(false);
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
    <div class="foot">
      <button type="button" class="row quiet" data-testid="account-pane-sign-out" onclick={() => onsignout?.()}>Sign out</button>
    </div>
  </aside>

  <main class="content">
    {#if view === "profile"}
      <div class="toolbar">
        <h1>Profile</h1>
        <span class="sub">Your identity across HQ</span>
        <span class="grow"></span>
        <span class="sub">{savedLabel}</span>
        <RailButton icon="check" variant="primary" type="button" data-testid="profile-save" onclick={() => save(data)}>Save</RailButton>
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
                <td><CompanyLabel name={company.label} companyUid={company.uid} /></td>
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
        <h1>Billing</h1>
        {#if invoice}<span class="sub">› Invoice</span>{/if}
        <span class="grow"></span>
        <RailButton icon="external" type="button" data-testid="manage-payment" onclick={() => openUrl(managePaymentUrl())}>Manage payment</RailButton>
      </div>
      <div class="split" class:open={invoice != null} data-testid="billing-split">
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
                  <td>{row.date}</td>
                  <td class="mono">{row.id}</td>
                  <td>{row.summary}</td>
                  <td><span class="status"><span class="dot" class:live={row.status.toLowerCase() === "paid"} class:err={/fail|due|unpaid/i.test(row.status)}></span>{row.status}</span></td>
                  <td>{row.amount}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if invoice}
          <aside class="invoice" data-testid="invoice-pane" aria-label="Invoice">
            <header class="ph"><h2 class="mono">{invoice.id}</h2><button type="button" class="x" aria-label="Close invoice" onclick={() => (invoiceId = null)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button></header>
            <div class="pb">
            <p class="amt">{invoice.amount}</p>
            <p class="sub">{invoice.summary}</p>
            <p class="status"><span class="dot" class:live={invoice.status.toLowerCase() === "paid"}></span>{invoice.status}</p>
            <div class="acts">
              <RailButton icon="download" variant="primary" type="button" data-testid="invoice-pdf" onclick={() => openUrl(invoicePdfUrl(invoice.id))}>Download PDF</RailButton>
              <RailButton icon="external" type="button" data-testid="invoice-stripe" onclick={() => openUrl(invoiceStripeUrl(invoice.id))}>Open in Stripe</RailButton>
            </div>
            </div>
          </aside>
        {/if}
      </div>
    {:else}
      <div class="toolbar">
        <h1>Settings</h1>
        {#if ready}<span class="status" data-testid="update-ready-chip"><span class="dot"></span>Update ready</span>{/if}
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
          {#if shortcutEditing}
            <button type="button" class="link" data-testid="edit-shortcuts" onclick={() => (shortcutsOpen = true)}>Edit shortcuts</button>
          {/if}
          <div class="sech">HQ settings</div>
          {#each ACCOUNT_SETTINGS_SECTIONS as section (section.id)}
            <button type="button" class="srow" data-testid="settings-section" data-section={section.id} onclick={() => onsettingssection?.(section.id)}>
              <span class="t">{section.label}</span>
              <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
            </button>
          {/each}
        </div>
        <div>
          <div class="sech">About</div>
          {#if ready && !updateDeferred}
            <div class="card" data-testid="update-card">
              <p class="nm">Update downloaded</p>
              <p>{updateStore.availableVersion ?? "A new version"} is ready. Restart to finish installing.</p>
              <div class="bar" style="width: {updateStore.downloadPercent ?? 100}%"></div>
              <div class="acts">
                <RailButton icon="x" type="button" data-testid="update-later" onclick={() => (updateDeferred = true)}>Later</RailButton>
                <RailButton icon="refresh" variant="primary"
                  type="button"
                  data-testid="restart-to-update"
                  onclick={() => void restartToUpdate({ installDownloadedUpdate: async () => ({ ok: true, value: null }) })}
                >Restart to update</RailButton>
              </div>
            </div>
          {:else if ready}
            <p class="sub">An update is ready. It installs the next time HQ restarts.</p>
          {:else}
            <p class="sub" data-testid="about-update-line">{aboutLine}</p>
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
          <RailButton icon="x" type="button" onclick={() => (confirmDelete = false)}>Cancel</RailButton>
          <RailButton icon="trash" variant="danger" type="button" data-testid="delete-confirm" disabled={!deleteConfirmed(deleteTyped)} onclick={confirmDeleteAccount}>Delete account</RailButton>
        </div>
      </div>
    </div>
  {/if}

  {#if shortcutsOpen && shortcutEditing}
    <div class="scrim" data-testid="shortcuts-editor">
      <div class="sheet" role="dialog" aria-label="Keyboard shortcuts">
        <h2>Keyboard shortcuts</h2>
        {#each data.shortcuts as row (row.id)}
          <div class="frow" data-recording={recordingId === row.id}>
            <span>{row.label}</span>
            {#if recordingId === row.id}
              <span class="fld" data-testid="shortcut-recording">Press keys… {draftKeys}</span>
              <RailButton icon="x" type="button" onclick={() => (recordingId = null)}>Cancel</RailButton>
            {:else}
              <kbd>{row.keys}</kbd>
              <button type="button" class="link" data-testid="shortcut-edit" onclick={() => { recordingId = row.id; draftKeys = ""; conflict = null; }}>Edit</button>
            {/if}
          </div>
        {/each}
        {#if conflict}<p class="hint" data-testid="shortcut-conflict">{conflict}</p>{/if}
        <div class="acts">
          <RailButton icon="x" type="button" onclick={() => (shortcutsOpen = false)}>Cancel</RailButton>
          <RailButton icon="check" variant="primary" type="button" data-testid="shortcut-save" onclick={() => { commitRecording(); shortcutsOpen = false; }}>Save</RailButton>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  /* Console-rail chrome measured from Messages (docs/design-standard-console-rail.md):
     one 20px/500 title, 13px Geist everywhere else, 31px nav rows, sentence-case
     section labels, status as dot plus text, mono only for ids and shortcuts. */
  .account {
    position: relative;
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--v4-bg, transparent);
    color: var(--t1, var(--v4-text-1));
    font: 400 13px/1.45 var(--font-ui, "Geist", -apple-system, sans-serif);
  }
  button { font: inherit; font-size: 13px; }
  .pane {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-height: 0;
    background: var(--side-bg);
    border-right: 1px solid var(--line, var(--v4-rowline));
    overflow: auto;
    padding: 12px 14px;
  }
  .who { display: flex; gap: 10px; align-items: center; padding: 4px 8px 8px; }
  .av {
    position: relative;
    width: 32px; height: 32px; border-radius: 50%;
    display: grid; place-items: center;
    background: var(--btn-bg, var(--v4-control-bg));
    font-size: 13px; font-weight: 500;
  }
  .ld {
    position: absolute; right: -1px; bottom: -1px;
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--ok, var(--v4-ok)); border: 2px solid var(--v4-sidebar, var(--side-bg));
  }
  .nm { display: block; font-weight: 500; color: var(--t1, var(--v4-text-1)); margin: 0; }
  .em, .sub { display: block; color: var(--t3, var(--v4-text-3)); }
  .sec { font-weight: 500; color: var(--t2, var(--v4-text-2)); padding: 12px 8px 4px; }
  .row {
    display: flex; align-items: center; gap: 8px;
    width: 100%; height: 31px; box-sizing: border-box; text-align: left;
    border: 0; background: transparent;
    color: var(--t2, var(--v4-text-2));
    border-radius: 8px;
    padding: 7px 8px;
    cursor: pointer;
  }
  .row.on, .row[aria-current="true"] { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); box-shadow: none; }
  .row:hover { background: var(--hover, var(--v4-hover)); }
  .count { margin-left: auto; color: var(--t3, var(--v4-text-3)); font-variant-numeric: tabular-nums; }
  .foot { margin-top: auto; }
  .quiet { color: var(--t3, var(--v4-text-3)); }
  .content { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .toolbar {
    display: flex; align-items: center; gap: 8px;
    height: 52px; flex: none; box-sizing: border-box; padding: 0 20px;
    border-bottom: 1px solid var(--line, var(--v4-rowline));
  }
  h1 { margin: 0 4px 0 0; font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); }
  .toolbar .sub { display: inline; }
  .grow { flex: 1; }
  .canvas { overflow: auto; padding: 8px 20px 32px; }
  /* QA-049: the invoice inspector takes width only while an invoice is open. */
  .split { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; flex: 1; }
  .split.open { grid-template-columns: minmax(0, 1fr) 340px; }
  .split.open .canvas { border-right: 1px solid var(--line, var(--v4-rowline)); }
  .split td:nth-child(1), .split td:nth-child(2) { white-space: nowrap; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
  .sech { font-weight: 500; color: var(--t2, var(--v4-text-2)); margin: 0; padding: 16px 0 6px; }
  .frow {
    display: grid; grid-template-columns: 168px minmax(0, 1fr);
    gap: 12px; align-items: center;
    min-height: 40px; padding: 6px 0;
    color: var(--t2, var(--v4-text-2));
  }
  .fld, .frow input, .frow textarea {
    max-width: 360px;
    box-sizing: border-box;
    min-height: 28px;
    border-radius: var(--v4-radius-field, 6px);
    background: var(--btn-bg, var(--v4-control-faint));
    border: 1px solid var(--line2, var(--v4-control-border));
    color: var(--t1, var(--v4-text-1));
    font: inherit;
    font-size: 13px;
    padding: 4px 8px;
  }
  .ta { min-height: 56px; }
  .pre { color: var(--t3, var(--v4-text-3)); }
  .ok { color: var(--t2, var(--v4-text-2)); margin-left: 8px; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th { font-weight: 400; color: var(--t3, var(--v4-text-3)); text-align: left; }
  .tbl td, .tbl th { height: 31px; padding: 0 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tbl tbody tr { cursor: pointer; }
  .tbl tbody tr:hover td { background: var(--hover, var(--v4-hover)); }
  .tbl tr[aria-current="true"] td { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); }
  .tbl td:first-child { border-radius: 8px 0 0 8px; }
  .tbl td:last-child { border-radius: 0 8px 8px 0; }
  .mono { font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .status { display: inline-flex; align-items: center; gap: 6px; color: var(--t2, var(--v4-text-2)); margin: 0; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--t3, var(--v4-text-3)); flex: none; display: inline-block; }
  .dot.live { background: var(--ok, var(--v4-ok)); }
  .dot.err { background: var(--red, var(--v4-error)); }
  .srow {
    display: flex; align-items: center; gap: 8px;
    width: 100%; height: 31px; box-sizing: border-box; padding: 7px 8px;
    border: 0; border-radius: 8px;
    background: transparent; color: var(--t1, var(--v4-text-1));
    text-align: left;
    cursor: pointer;
  }
  .srow:hover, .srow:focus-visible { background: var(--hover, var(--v4-hover)); outline: none; }
  .srow .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev {
    flex: 0 0 auto; width: 14px; height: 14px;
    fill: none; stroke: var(--t3, var(--v4-text-3)); stroke-width: 1.3;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .link {
    height: 26px; padding: 0 8px; border: 0; border-radius: 6px;
    background: transparent; color: var(--t2, var(--v4-text-2));
    cursor: pointer;
  }
  .link:hover { background: var(--hover, var(--v4-hover)); color: var(--t1, var(--v4-text-1)); }
  .danger {
    margin-top: 24px; padding-top: 14px;
    border-top: 1px solid var(--line, var(--v4-rowline));
    display: flex; gap: 16px; align-items: center;
    color: var(--t3, var(--v4-text-3));
  }
  .del { height: 28px; padding: 0 10px; border-radius: 6px; color: var(--red, var(--v4-error)); background: none; border: 0; font-weight: 500; cursor: pointer; white-space: nowrap; }
  .invoice { min-width: 0; overflow: auto; }
  .ph { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  .ph h2 { flex: 1; margin: 0; font-size: 13px; font-weight: 500; color: var(--t1, var(--v4-text-1)); }
  .x { width: 24px; height: 24px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--t2, var(--v4-text-2)); cursor: pointer; padding: 0; }
  .x:hover { background: var(--hover, var(--v4-hover)); color: var(--t1, var(--v4-text-1)); }
  .x svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; }
  .pb { padding: 24px 20px; display: flex; flex-direction: column; gap: 6px; }
  .pb p { margin: 0; }
  .amt { font-weight: 500; color: var(--t1, var(--v4-text-1)); }
  .acts { display: flex; gap: 8px; margin-top: 12px; }
  .card {
    border-radius: 10px;
    padding: 14px 16px;
    background: var(--raised, var(--v4-control-faint));
  }
  .card p { margin: 4px 0 8px; color: var(--t2, var(--v4-text-2)); }
  .bar { height: 3px; background: var(--t2, var(--v4-text-2)); border-radius: 2px; }
  kbd {
    justify-self: start;
    font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace); font-size: 12px;
    border: 1px solid var(--line2, var(--v4-control-border));
    background: var(--btn-bg, var(--v4-control-faint));
    border-radius: 4px; padding: 1px 6px;
  }
  .scrim {
    position: absolute; inset: 0;
    background: rgba(0, 0, 0, 0.34);
    display: grid; place-items: center;
  }
  .sheet {
    width: 480px; max-width: calc(100% - 32px);
    background: var(--panel-bg, var(--v4-popover));
    border: 1px solid var(--panel-border, var(--v4-hairline));
    border-radius: 8px;
    box-shadow: var(--panel-shadow, var(--v4-shadow-popover));
    padding: 20px;
    color: var(--t2, var(--v4-text-2));
  }
  .sheet h2 { margin: 0 0 8px; color: var(--t1, var(--v4-text-1)); font-size: 13px; font-weight: 500; }
  .hint { color: var(--t3, var(--v4-text-3)); }
</style>
