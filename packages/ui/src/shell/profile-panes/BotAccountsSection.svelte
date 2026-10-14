<script lang="ts">
  /**
   * Accounts on a hosted bot, under Runtime in the bot profile. The owner adds
   * a second subscription, signs it in, and removes one. Everyone else reads
   * the list. The legacy single sign-in shows as "Default" and has no
   * controls, so a bot from before accounts reads the same as it did.
   *
   * Codex and Grok sign in with a device code on their own page. Claude hands
   * back a code that is pasted here. The section checks the sign-in every few
   * seconds until it settles.
   */
  import { onDestroy } from "svelte";
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { openExternalHref } from "../../common/external-links.js";
  import {
    ACCOUNT_LABEL_MAX,
    ACCOUNT_LIMIT,
    ACCOUNT_PROVIDERS,
    ACCOUNT_SIGN_IN_CHECK_EVERY_MS,
    accountFromPayload,
    accountName,
    accountSignInFromPayload,
    accountsFromWritePayload,
    addFailureMessage,
    codeFailureMessage,
    providerLabel,
    removeFailureMessage,
    signInFailureMessage,
    statusLabel,
    type AccountProvider,
    type AccountsClient,
    type BotAccount,
  } from "./bot-accounts.js";

  interface Props {
    accounts: readonly BotAccount[];
    /** The viewer owns the bot. False hides every add, remove and sign-in control. */
    canManage?: boolean;
    client?: AccountsClient | null;
    /** The server's new list after an add, remove or sign-in. */
    onaccounts?: (accounts: BotAccount[]) => void;
    onopenurl?: (url: string) => void;
    pollMs?: number;
  }

  let {
    accounts,
    canManage = false,
    client = null,
    onaccounts,
    onopenurl,
    pollMs = ACCOUNT_SIGN_IN_CHECK_EVERY_MS,
  }: Props = $props();

  type SignInView =
    | { phase: "starting" }
    | { phase: "pending"; url: string | null; code: string | null }
    | { phase: "failed"; message: string };

  const manage = $derived(canManage && client !== null);

  let adding = $state(false);
  let addProvider = $state<AccountProvider>("codex");
  let addLabel = $state("");
  let addBusy = $state(false);
  let addError = $state<string | null>(null);

  let confirmRemove = $state<string | null>(null);
  let removeBusy = $state<string | null>(null);
  let rowError = $state<{ id: string; message: string } | null>(null);

  /** The one account mid sign-in; one at a time keeps the pane readable. */
  let signInFor = $state<string | null>(null);
  let signIn = $state<SignInView | null>(null);
  let loginCode = $state("");
  let codeBusy = $state(false);
  let codeSent = $state(false);
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const atLimit = $derived(accounts.length >= ACCOUNT_LIMIT);

  function stopPolling(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  onDestroy(() => {
    destroyed = true;
    stopPolling();
  });

  function replaceAccount(next: BotAccount): void {
    onaccounts?.(accounts.map((a) => (a.id === next.id ? next : a)));
  }

  function openAdd(): void {
    adding = true;
    addError = null;
    addLabel = "";
  }

  async function submitAdd(): Promise<void> {
    if (!client || addBusy) return;
    const label = addLabel.trim();
    if (!label) {
      addError = "Give the account a name.";
      return;
    }
    addBusy = true;
    addError = null;
    try {
      const res = await client.add({ provider: addProvider, label, authKind: "subscription" });
      if (!res.ok) {
        console.warn("[hq-desktop] add bot account failed", res.status ?? res.reason);
        addError = addFailureMessage(res);
        return;
      }
      const list = accountsFromWritePayload(res.value);
      const created = accountFromPayload((res.value as { account?: unknown } | null)?.account);
      if (list) onaccounts?.(list);
      else if (created) onaccounts?.([...accounts, created]);
      adding = false;
      addLabel = "";
      if (created) void beginSignIn(created.id);
    } catch (err) {
      console.warn("[hq-desktop] add bot account failed", err);
      addError = "Couldn't add the account. Try again.";
    } finally {
      addBusy = false;
    }
  }

  async function submitRemove(id: string): Promise<void> {
    if (!client || removeBusy) return;
    removeBusy = id;
    rowError = null;
    try {
      const res = await client.remove(id);
      if (!res.ok) {
        console.warn("[hq-desktop] remove bot account failed", res.status ?? res.reason);
        rowError = { id, message: removeFailureMessage(res) };
        return;
      }
      confirmRemove = null;
      if (signInFor === id) cancelSignIn();
      const list = accountsFromWritePayload(res.value);
      onaccounts?.(list ?? accounts.filter((a) => a.id !== id));
    } catch (err) {
      console.warn("[hq-desktop] remove bot account failed", err);
      rowError = { id, message: "Couldn't remove the account. Try again." };
    } finally {
      removeBusy = null;
    }
  }

  async function beginSignIn(id: string): Promise<void> {
    if (!client) return;
    stopPolling();
    signInFor = id;
    signIn = { phase: "starting" };
    loginCode = "";
    codeSent = false;
    rowError = null;
    try {
      const res = await client.startSignIn(id);
      if (destroyed || signInFor !== id) return;
      if (!res.ok) {
        console.warn("[hq-desktop] start account sign-in failed", res.status ?? res.reason);
        signIn = { phase: "failed", message: res.status === 403 ? "Only the bot's owner can sign in its accounts." : signInFailureMessage(null) };
        return;
      }
      const view = accountSignInFromPayload(res.value);
      if (view.state === "failed") {
        signIn = { phase: "failed", message: signInFailureMessage(view.reason) };
        return;
      }
      signIn = view.state === "pending" ? { phase: "pending", url: view.url, code: view.code } : { phase: "pending", url: null, code: null };
      schedule(id);
    } catch (err) {
      console.warn("[hq-desktop] start account sign-in failed", err);
      if (signInFor === id) signIn = { phase: "failed", message: signInFailureMessage(null) };
    }
  }

  function schedule(id: string): void {
    stopPolling();
    if (destroyed) return;
    timer = setTimeout(() => void check(id), pollMs);
  }

  async function check(id: string): Promise<void> {
    timer = null;
    if (!client || destroyed || signInFor !== id) return;
    try {
      const res = await client.getSignIn(id);
      if (destroyed || signInFor !== id) return;
      if (!res.ok) {
        // A missed check is not a failed sign-in; look again.
        console.warn("[hq-desktop] account sign-in check failed", res.status ?? res.reason);
        schedule(id);
        return;
      }
      const view = accountSignInFromPayload(res.value);
      const account = accountFromPayload((res.value as { account?: unknown } | null)?.account);
      if (view.state === "signed-in") {
        const current = accounts.find((a) => a.id === id);
        const next = account ?? (current ? { ...current, status: "active" as const, benchedUntil: null } : null);
        if (next) replaceAccount(next.status === "needs_auth" ? { ...next, status: "active" } : next);
        cancelSignIn();
        return;
      }
      if (view.state === "failed") {
        signIn = { phase: "failed", message: signInFailureMessage(view.reason) };
        return;
      }
      if (view.state === "pending" && signIn?.phase === "pending") {
        signIn = { phase: "pending", url: view.url ?? signIn.url, code: view.code ?? signIn.code };
      }
      schedule(id);
    } catch (err) {
      console.warn("[hq-desktop] account sign-in check failed", err);
      schedule(id);
    }
  }

  function cancelSignIn(): void {
    stopPolling();
    signInFor = null;
    signIn = null;
    loginCode = "";
    codeSent = false;
  }

  async function sendCode(id: string): Promise<void> {
    const code = loginCode.trim();
    if (!client?.submitLoginCode || !code || codeBusy) return;
    codeBusy = true;
    try {
      const res = await client.submitLoginCode(id, code);
      if (!res.ok) {
        console.warn("[hq-desktop] send account login code failed", res.status ?? res.reason);
        signIn = { phase: "failed", message: codeFailureMessage(res) };
        stopPolling();
        return;
      }
      codeSent = true;
      loginCode = "";
    } catch (err) {
      console.warn("[hq-desktop] send account login code failed", err);
      signIn = { phase: "failed", message: "Couldn't send the code. Try again." };
      stopPolling();
    } finally {
      codeBusy = false;
    }
  }

  async function copyCode(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch (err) {
      console.warn("[hq-desktop] copy sign-in code failed", err);
      copied = false;
    }
  }
</script>

<section class="g" data-testid="bot-accounts">
  <div class="k">
    Accounts <span class="count">{accounts.length}</span>
    {#if manage && !adding && !atLimit}
      <button type="button" class="link" data-testid="bot-accounts-add" onclick={openAdd}><RailIcon name="plus" />Add</button>
    {/if}
  </div>
  {#each accounts as account (account.id)}
    <div class="acct" data-testid="bot-account" data-account-id={account.id}>
      <div class="run">
        <span class="mk" class:live={account.status === "active"} class:err={account.status === "needs_auth"}></span>
        <div>
          <span class="t">{accountName(account)}</span>
          <span class="meta">{providerLabel(account.provider)} · <span data-testid="bot-account-status">{statusLabel(account)}</span></span>
        </div>
        {#if manage && !account.legacy && signInFor !== account.id && confirmRemove !== account.id}
          <span class="ctl">
            {#if account.status === "needs_auth"}
              <button type="button" class="link" data-testid="bot-account-sign-in" onclick={() => void beginSignIn(account.id)}><RailIcon name="key" />Sign in</button>
            {/if}
            <button
              type="button"
              class="link"
              data-testid="bot-account-remove"
              disabled={accounts.length <= 1}
              title={accounts.length <= 1 ? "A bot needs at least one account." : undefined}
              onclick={() => {
                confirmRemove = account.id;
                rowError = null;
              }}><RailIcon name="trash" />Remove</button>
          </span>
        {/if}
      </div>
      {#if manage && confirmRemove === account.id}
        <div class="panel" data-testid="bot-account-confirm-remove">
          <span>Remove {accountName(account)} from this bot?</span>
          <div class="row">
            <button type="button" class="btn" data-testid="bot-account-remove-confirm" disabled={removeBusy === account.id} onclick={() => void submitRemove(account.id)}><RailIcon name="trash" />{removeBusy === account.id ? "Removing…" : "Remove"}</button>
            <button type="button" class="btn" disabled={removeBusy === account.id} onclick={() => (confirmRemove = null)}><RailIcon name="x" />Cancel</button>
          </div>
        </div>
      {/if}
      {#if rowError?.id === account.id}
        <p class="err" data-testid="bot-account-error">{rowError.message}</p>
      {/if}
      {#if manage && signInFor === account.id && signIn}
        <div class="panel" data-testid="bot-account-sign-in-panel">
          {#if signIn.phase === "starting"}
            <span class="hint">Starting sign-in…</span>
          {:else if signIn.phase === "failed"}
            <p class="err" data-testid="bot-account-sign-in-error">{signIn.message}</p>
            <div class="row">
              <button type="button" class="btn" data-testid="bot-account-sign-in-retry" onclick={() => void beginSignIn(account.id)}><RailIcon name="refresh" />Try again</button>
              <button type="button" class="btn" onclick={cancelSignIn}><RailIcon name="x" />Cancel</button>
            </div>
          {:else}
            {@const pending = signIn}
            {#if account.provider === "claude"}
              <span class="hint">Sign in to Claude, then paste the code it shows you.</span>
            {:else}
              <span class="hint">Open the sign-in page and enter this code.</span>
              {#if pending.code}
                <div class="code-row">
                  <span class="code" data-testid="bot-account-sign-in-code">{pending.code}</span>
                  <button type="button" class="link" onclick={() => void copyCode(pending.code!)}><RailIcon name="copy" />{copied ? "Copied" : "Copy"}</button>
                </div>
              {/if}
            {/if}
            <div class="row">
              <button
                type="button"
                class="btn"
                data-testid="bot-account-open-sign-in"
                disabled={!pending.url}
                onclick={() => pending.url && openExternalHref(pending.url, onopenurl)}
              ><RailIcon name="external" />{pending.url ? "Open sign-in page" : "Getting the link…"}</button>
            </div>
            {#if account.provider === "claude" && client?.submitLoginCode}
              {#if codeSent}
                <span class="hint" data-testid="bot-account-code-sent">Code sent. Finishing sign-in…</span>
              {:else}
                <div class="row">
                  <input class="fld" data-testid="bot-account-login-code" placeholder="Paste the code" autocomplete="off" bind:value={loginCode} />
                  <button type="button" class="btn" data-testid="bot-account-send-code" disabled={!loginCode.trim() || codeBusy} onclick={() => void sendCode(account.id)}><RailIcon name="send" />{codeBusy ? "Sending…" : "Send code"}</button>
                </div>
              {/if}
            {:else}
              <span class="hint">Waiting for sign-in…</span>
            {/if}
            <div class="row">
              <button type="button" class="link solo" onclick={cancelSignIn}><RailIcon name="x" />Cancel sign-in</button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
  {#if manage && adding}
    <form
      class="panel"
      data-testid="bot-accounts-add-form"
      onsubmit={(e) => {
        e.preventDefault();
        void submitAdd();
      }}
    >
      <div class="row">
        <select class="fld" data-testid="bot-accounts-add-provider" aria-label="Provider" bind:value={addProvider} disabled={addBusy}>
          {#each ACCOUNT_PROVIDERS as p (p)}
            <option value={p}>{providerLabel(p)}</option>
          {/each}
        </select>
        <input
          class="fld"
          data-testid="bot-accounts-add-label"
          aria-label="Account name"
          placeholder="Name, like Work"
          maxlength={ACCOUNT_LABEL_MAX}
          autocomplete="off"
          bind:value={addLabel}
          disabled={addBusy}
        />
      </div>
      {#if addError}<p class="err" data-testid="bot-accounts-add-error">{addError}</p>{/if}
      <div class="row">
        <button type="submit" class="btn" data-testid="bot-accounts-add-submit" disabled={addBusy}><RailIcon name="plus" />{addBusy ? "Adding…" : addError ? "Try again" : "Add account"}</button>
        <button type="button" class="btn" disabled={addBusy} onclick={() => (adding = false)}><RailIcon name="x" />Cancel</button>
      </div>
    </form>
  {/if}
</section>

<style>
  .g { border-top: 1px solid var(--v4-rowline, var(--line)); padding-top: 12px; }
  .k {
    color: var(--v4-text-2);
    font-weight: 500;
    display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
  }
  .count { color: var(--v4-text-3); font-weight: 400; font-variant-numeric: tabular-nums; }
  .link {
    display: inline-flex; align-items: center; gap: 4px;
    margin-left: auto; padding: 0; border: 0; background: none;
    color: var(--v4-text-3); font: inherit; font-weight: 400; cursor: pointer;
  }
  .link:hover:not(:disabled) { color: var(--v4-text-1); }
  .link:disabled { opacity: 0.5; cursor: default; }
  .link.solo { margin-left: 0; }
  .acct { border-bottom: 1px solid var(--v4-rowline, var(--line)); }
  .acct:last-of-type { border-bottom: 0; }
  .run { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 6px 0; color: var(--v4-text-1); }
  .mk { width: 6px; height: 6px; border-radius: 50%; background: var(--v4-text-3); margin-top: 7px; }
  .mk.live { background: var(--v4-ok); }
  .mk.err { background: var(--v4-error); }
  .t { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: block; color: var(--v4-text-3); }
  .ctl { display: inline-flex; gap: 10px; }
  .panel { display: flex; flex-direction: column; gap: 6px; padding: 0 0 8px 14px; color: var(--v4-text-2); }
  form.panel { padding: 6px 0 0; }
  .row { display: flex; gap: 6px; align-items: center; }
  .hint { color: var(--v4-text-3); }
  .code-row { display: flex; align-items: center; gap: 8px; }
  .code { color: var(--v4-text-1); font-family: var(--font-mono, "Geist Mono", monospace); font-variant-numeric: tabular-nums; }
  .fld {
    flex: 1 1 0; min-width: 0;
    min-height: 28px; border-radius: 6px; background: var(--v4-control-faint); border: 1px solid var(--v4-control-border, var(--line));
    color: var(--v4-text-1); padding: 4px 10px; font: inherit; box-sizing: border-box;
  }
  select.fld { flex: 0 0 auto; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    flex: 1 1 0;
    min-width: 0;
    height: var(--hq-btn-h);
    padding: 0 var(--hq-btn-pad-inline);
    border: 1px solid var(--v4-control-border, var(--line2));
    background: transparent;
    color: var(--v4-text-1);
    border-radius: var(--v4-radius-button, 6px);
    font: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: var(--hover, var(--v4-hover)); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .err { margin: 0; color: var(--v4-error); }
</style>
