<script lang="ts">
  import "../home/tokens.css";
  import "../common/button/button-standard.css";
  import {
    SIGNIN_COPY,
    deriveSignInPresentation,
    type CompanySignInRole,
    type CompanySignInView,
    type SignInFailure,
  } from "./company-signin-model.js";

  interface Props {
    role: CompanySignInRole;
    view: CompanySignInView | null;
    failure?: SignInFailure | null;
    codeError?: string | null;
    busy?: "submit" | "refresh" | "regenerate" | null;
    now?: number;
    notice?: string | null;
    onRefresh?: () => void;
    onRegenerate?: () => void;
    onSubmitCode?: (code: string) => void;
  }

  let {
    role,
    view,
    failure = null,
    codeError = null,
    busy = null,
    now = Date.now(),
    notice = null,
    onRefresh,
    onRegenerate,
    onSubmitCode,
  }: Props = $props();

  let code = $state("");

  const card = $derived(deriveSignInPresentation({ role, view, failure, codeError, now }));

  function submit(event: Event) {
    event.preventDefault();
    if (!card.showCode || busy) return;
    const value = code.trim();
    code = "";
    if (!value) return;
    onSubmitCode?.(value);
  }
</script>

<section
  class="signin"
  data-testid="company-signin-card"
  data-phase={card.phase}
  data-waiting-for-code={card.phase === "awaiting_code" || card.phase === "code_rejected" ? "true" : "false"}
  aria-busy={busy ? "true" : "false"}
>
  <div class="head">
    <h2>{SIGNIN_COPY.title}</h2>
    <span class="badge" data-testid="company-signin-badge" data-kind={card.phase}>{card.badge}</span>
  </div>

  {#if card.phase !== "loading"}
    <p class="headline" data-testid="company-signin-headline">{card.headline}</p>
  {/if}
  {#if card.detail}
    <p class="detail" data-testid="company-signin-detail">{card.detail}</p>
  {/if}
  {#if notice}
    <p class="detail" data-testid="company-signin-notice">{notice}</p>
  {/if}

  {#if card.showLink && card.loginUrl}
    <ol>
      <li>
        <a data-testid="company-signin-open" href={card.loginUrl} target="_blank" rel="noreferrer">{SIGNIN_COPY.openLink}</a>
        {SIGNIN_COPY.openRest}
      </li>
      <li>{SIGNIN_COPY.paste}</li>
    </ol>
  {/if}
  {#if card.expiry && card.phase !== "expired"}
    <p class="expiry" data-testid="company-signin-expiry">{card.expiry}</p>
  {/if}

  {#if card.showCode}
    <form onsubmit={submit}>
      <label for="company-signin-code">{SIGNIN_COPY.codeLabel}</label>
      <div class="code-row">
        <input
          id="company-signin-code"
          data-testid="company-signin-code"
          type="password"
          autocomplete="off"
          spellcheck="false"
          aria-label="Sign-in code"
          aria-invalid={card.codeError ? "true" : undefined}
          aria-describedby={card.codeError ? "company-signin-error" : undefined}
          value={code}
          oninput={(event) => {
            const target = event.currentTarget;
            if (target instanceof HTMLInputElement) code = target.value;
          }}
        />
        <button class="primary" type="submit" data-testid="company-signin-submit" disabled={busy === "submit" || code.trim() === ""}>
          {busy === "submit" ? SIGNIN_COPY.submitting : SIGNIN_COPY.submit}
        </button>
      </div>
      {#if card.codeError}
        <p id="company-signin-error" class="error" role="alert" data-testid="company-signin-error">{card.codeError}</p>
      {/if}
    </form>
  {/if}

  {#if card.showRefresh || card.showNewLink}
    <div class="actions">
      {#if card.showRefresh}
        <button type="button" data-testid="company-signin-refresh" disabled={busy === "refresh"} onclick={() => onRefresh?.()}>{SIGNIN_COPY.refresh}</button>
      {/if}
      {#if card.showNewLink}
        <button type="button" data-testid="company-signin-new-link" disabled={busy === "regenerate"} onclick={() => onRegenerate?.()}>{SIGNIN_COPY.newLink}</button>
      {/if}
    </div>
  {/if}
</section>

<style>
  .signin {
    box-sizing: border-box;
    border: 1px solid var(--v4-hairline, rgba(0, 0, 0, 0.12));
    background: var(--v4-surface-solid, #fff);
    color: var(--v4-text-1, #111);
    border-radius: 12px;
    padding: 16px;
    font-family: inherit;
    font-weight: var(--type-ui-weight, 400);
    font-size: var(--type-ui, 13px);
    line-height: var(--type-ui-line, 1.45);
  }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { margin: 0; font-size: 13px; font-weight: 500; }
  .badge {
    color: var(--v4-text-3, rgba(0, 0, 0, 0.62));
    border: 1px solid var(--v4-hairline, rgba(0, 0, 0, 0.12));
    border-radius: 999px;
    padding: 1px 8px;
  }
  .badge[data-kind="signed_in"] { color: var(--v4-ok, #128a3e); }
  .headline { margin: 12px 0 0; font-weight: 500; }
  .detail, .expiry, ol, form, .actions { margin: 10px 0 0; }
  ol { padding-left: 1.2em; }
  a { color: inherit; }
  label { display: block; margin-bottom: 6px; }
  .code-row { display: flex; gap: 8px; align-items: center; }
  input {
    flex: 1;
    min-width: 0;
    background: var(--v4-inset, rgba(0, 0, 0, 0.045));
    color: inherit;
    border: 1px solid var(--v4-control-border, rgba(0, 0, 0, 0.16));
    border-radius: var(--hq-btn-radius, 8px);
    padding: 8px 10px;
    font: inherit;
  }
  button {
    font-family: inherit;
    font-weight: var(--hq-btn-font-weight, 500);
    font-size: var(--hq-btn-font-size, 13px);
    line-height: var(--hq-btn-line-height, 1.45);
    min-height: var(--hq-btn-h, 30px);
    padding: var(--hq-btn-pad-block, 5px) var(--hq-btn-pad-inline, 10px);
    border-radius: var(--hq-btn-radius, 8px);
    border: var(--hq-btn-border, 1px) solid var(--v4-control-border, rgba(0, 0, 0, 0.16));
    background: var(--v4-secondary-bg, rgba(0, 0, 0, 0.06));
    color: var(--v4-text-1, #111);
    cursor: pointer;
  }
  button.primary {
    background: var(--v4-primary-bg, #111);
    color: var(--v4-primary-fg, #fff);
    border-color: transparent;
  }
  button:disabled { opacity: 0.45; cursor: default; }
  button:focus-visible, input:focus-visible, a:focus-visible {
    outline: 2px solid var(--v4-focus-ring, rgba(0, 0, 0, 0.42));
    outline-offset: 2px;
  }
  .actions { display: flex; gap: 8px; }
  .error { margin: 8px 0 0; color: var(--v4-error, #b42318); }
</style>
