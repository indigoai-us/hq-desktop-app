<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { open } from '@tauri-apps/plugin-shell';
  import { onDestroy } from 'svelte';
  import {
    mapSignInError,
    type SignInProvider,
  } from '../../lib/onboarding-signin';

  interface Props {
    onsignedin?: () => void;
  }

  let { onsignedin }: Props = $props();

  const providers: { key: SignInProvider; label: string }[] = [
    { key: 'Google', label: 'Google' },
    { key: 'Microsoft', label: 'Microsoft' },
  ];

  let loadingProvider = $state<SignInProvider | null>(null);
  let error = $state('');
  let currentCall = 0;
  let mounted = true;

  onDestroy(() => {
    mounted = false;
    currentCall += 1;
  });

  function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  async function invokeCommand<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    if (typeof invoke !== 'function') {
      throw new Error('The desktop bridge is not available in this environment.');
    }
    return invoke<T>(command, args);
  }

  async function openInBrowser(url: string): Promise<void> {
    if (typeof open !== 'function') {
      throw new Error('The desktop shell cannot open a browser in this environment.');
    }
    await open(url);
  }

  function isCurrentCall(call: number): boolean {
    return mounted && call === currentCall;
  }

  async function handleSignIn(provider: SignInProvider) {
    const call = ++currentCall;
    loadingProvider = provider;
    error = '';

    try {
      const { authorizeUrl, state } = await invokeCommand<{
        authorizeUrl: string;
        state: string;
      }>('start_oauth_login', { provider });
      if (!isCurrentCall(call)) return;

      await openInBrowser(authorizeUrl);
      if (!isCurrentCall(call)) return;

      const { code } = await invokeCommand<{ code: string }>(
        'oauth_listen_for_code',
        { state },
      );
      if (!isCurrentCall(call)) return;

      const result = await invokeCommand<{
        authenticated: boolean;
        expiresAt?: string;
      }>('oauth_exchange_code', { code });
      if (!isCurrentCall(call)) return;

      if (result.authenticated) {
        onsignedin?.();
      } else {
        error = 'Authentication failed. Please try again.';
      }
    } catch (err) {
      if (!isCurrentCall(call)) return;
      console.error('[onboarding-signin] sign-in failed:', err);
      error = mapSignInError(errorMessage(err), provider);
    } finally {
      if (isCurrentCall(call)) {
        loadingProvider = null;
      }
    }
  }
</script>

<div class="signin-screen" data-testid="onboarding-signin">
  <div class="signin-copy">
    <h1>Sign in to continue setting up HQ</h1>
    <p>Use Google or Microsoft to continue.</p>
  </div>

  {#if error}
    <p class="notice" role="alert">{error}</p>
  {/if}

  <div class="signin-actions">
    {#each providers as provider}
      <button
        type="button"
        class="provider-button"
        onclick={() => handleSignIn(provider.key)}
      >
        {#if provider.key === 'Google'}
          {@render GoogleGlyph()}
        {:else}
          {@render MicrosoftGlyph()}
        {/if}
        <span>
          {loadingProvider === provider.key
            ? `Reopen ${provider.label} sign-in`
            : `Continue with ${provider.label}`}
        </span>
      </button>
    {/each}
  </div>

  {#if loadingProvider}
    <p class="loading-hint">
      A browser window opened for {loadingProvider} sign-in. Complete it there and
      you'll return here automatically. If the tab closed or opened in the wrong
      window, click the button above to try again.
    </p>
  {/if}
</div>

{#snippet GoogleGlyph()}
  <svg
    class="provider-glyph"
    width="18"
    height="18"
    viewBox="0 0 18 18"
    aria-hidden="true"
  >
    <path
      d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      fill="#4285F4"
    />
    <path
      d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      fill="#34A853"
    />
    <path
      d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
      fill="#FBBC05"
    />
    <path
      d="M9 3.579c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.892 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z"
      fill="#EA4335"
    />
  </svg>
{/snippet}

{#snippet MicrosoftGlyph()}
  <span class="provider-glyph microsoft-glyph" aria-hidden="true">
    <span></span>
    <span></span>
    <span></span>
    <span></span>
  </span>
{/snippet}

<style>
  .signin-screen {
    display: flex;
    flex-direction: column;
    gap: var(--space-5, 20px);
    width: 100%;
    max-width: 420px;
  }

  .signin-copy {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 12px);
  }

  h1 {
    margin: 0;
    color: var(--popover-text-heading, #ffffff);
    font-size: 28px;
    font-weight: 600;
    line-height: 1.15;
  }

  p {
    margin: 0;
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
    font-size: var(--text-base, 13px);
    font-weight: 400;
    line-height: 1.6;
  }

  .signin-actions {
    display: grid;
    gap: var(--space-3, 12px);
    width: 100%;
  }

  .provider-button {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3, 12px);
    width: 100%;
    min-height: 40px;
    padding: 0 var(--space-4, 16px);
    border: 1px solid var(--popover-primary, #ffffff);
    border-radius: var(--radius-sm, 8px);
    background: var(--popover-primary, #ffffff);
    color: var(--popover-primary-text, #111113);
    font: inherit;
    font-size: var(--text-sm, 13px);
    font-weight: 650;
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      opacity 0.12s ease;
  }

  .provider-button:hover:not(:disabled) {
    background: var(--popover-primary-hover, rgba(255, 255, 255, 0.9));
  }

  .provider-button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .provider-glyph {
    flex: 0 0 auto;
  }

  .microsoft-glyph {
    display: grid;
    width: 18px;
    height: 18px;
    grid-template-columns: repeat(2, 1fr);
    gap: 2px;
  }

  .microsoft-glyph span:nth-child(1) {
    background: #f25022;
  }

  .microsoft-glyph span:nth-child(2) {
    background: #7fba00;
  }

  .microsoft-glyph span:nth-child(3) {
    background: #00a4ef;
  }

  .microsoft-glyph span:nth-child(4) {
    background: #ffb900;
  }

  .notice {
    padding: var(--space-3, 12px);
    border: 1px solid var(--popover-notice-border, rgba(255, 255, 255, 0.16));
    border-radius: var(--radius-sm, 8px);
    background: var(--popover-notice-bg, rgba(255, 255, 255, 0.05));
    color: var(--popover-notice, rgba(255, 255, 255, 0.65));
  }

  .loading-hint {
    color: var(--popover-text-muted, rgba(255, 255, 255, 0.52));
    font-size: var(--text-sm, 13px);
    text-align: center;
  }
</style>
