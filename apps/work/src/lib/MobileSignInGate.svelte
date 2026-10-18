<!--
  The phone's sign-in screen.

  Google opens Cognito straight away. Microsoft first asks for the email, so
  the flow can pick the person's work (`MsOrg*`) or personal provider the same
  way the desktop app does. The labels are the desktop app's existing copy.
-->
<script lang="ts">
  import {
    MOBILE_SIGNIN_PROVIDERS,
    MOBILE_SIGNIN_PROVIDER_LABEL,
    type MobileSignInProvider,
  } from "./mobile-providers";
  import type { MobileSignInState } from "./mobile-sign-in";

  let {
    signInState,
    error = null,
    onSignIn,
  }: {
    signInState: MobileSignInState;
    error?: string | null;
    onSignIn: (provider: MobileSignInProvider, options?: { email?: string }) => void;
  } = $props();

  let chosen = $state<MobileSignInProvider | null>(null);
  let microsoftEmail = $state("");
  let microsoftEmailPrompt = $state(false);

  const opening = $derived(signInState === "opening");

  function choose(provider: MobileSignInProvider): void {
    if (provider === "Microsoft" && microsoftEmail.trim() === "") {
      microsoftEmailPrompt = true;
      return;
    }
    chosen = provider;
    onSignIn(
      provider,
      provider === "Microsoft" ? { email: microsoftEmail.trim() } : undefined,
    );
  }
</script>

<h1>Sign in to HQ Work</h1>
<p class="lede">
  This opens your browser to sign in, then brings you straight back.
</p>
{#each MOBILE_SIGNIN_PROVIDERS as provider}
  <button
    class="go"
    data-testid={`mobile-signin-${provider}`}
    disabled={opening}
    onclick={() => choose(provider)}
  >
    {opening && chosen === provider
      ? "Opening your browser…"
      : `Continue with ${MOBILE_SIGNIN_PROVIDER_LABEL[provider]}`}
  </button>
{/each}
{#if microsoftEmailPrompt}
  <form
    class="microsoft-email"
    data-testid="mobile-microsoft-email-form"
    onsubmit={(event) => {
      event.preventDefault();
      choose("Microsoft");
    }}
  >
    <label for="mobile-signin-microsoft-email">Enter the Microsoft email you use with HQ</label>
    <input
      id="mobile-signin-microsoft-email"
      data-testid="mobile-microsoft-email"
      type="email"
      autocomplete="username"
      autocapitalize="none"
      spellcheck="false"
      bind:value={microsoftEmail}
      disabled={opening}
    />
    <button
      class="go"
      type="submit"
      data-testid="mobile-microsoft-email-continue"
      disabled={opening || microsoftEmail.trim() === ""}
    >
      Continue
    </button>
  </form>
{/if}
{#if error}
  <p class="error" role="alert" data-testid="mobile-signin-error">{error}</p>
{/if}

<style>
  h1 {
    margin: 0;
    font-size: 1.4rem;
    font-weight: 600;
  }

  .lede {
    margin: 0;
    max-width: 26rem;
    font-size: 0.95rem;
    line-height: 1.5;
    opacity: 0.72;
  }

  .go {
    margin-top: 0.75rem;
    /* Comfortably above the 44pt minimum touch target on both platforms. */
    min-height: 3rem;
    min-width: 12rem;
    padding: 0 1.5rem;
    border: 0;
    border-radius: 0.65rem;
    background: var(--hq-accent, #4c6ef5);
    color: #fff;
    font-size: 1rem;
    font-weight: 600;
  }

  .go:disabled {
    opacity: 0.6;
  }

  .microsoft-email {
    display: grid;
    gap: 0.5rem;
    width: 100%;
    max-width: 20rem;
    margin-top: 0.5rem;
    text-align: left;
  }

  .microsoft-email label {
    font-size: 0.85rem;
    line-height: 1.4;
    opacity: 0.72;
  }

  .microsoft-email input {
    box-sizing: border-box;
    width: 100%;
    min-height: 3rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid rgba(232, 234, 240, 0.25);
    border-radius: 0.65rem;
    background: transparent;
    color: inherit;
    font: inherit;
    /* 16px or larger stops iOS zooming the page when the field takes focus. */
    font-size: 1rem;
  }

  .error {
    margin: 0.5rem 0 0;
    max-width: 26rem;
    font-size: 0.9rem;
    line-height: 1.4;
    color: var(--hq-danger, #ff8a8a);
  }
</style>
