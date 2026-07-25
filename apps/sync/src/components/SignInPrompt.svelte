<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { open } from '@tauri-apps/plugin-shell';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import CopyPromptButton from './CopyPromptButton.svelte';
  import { emitDesktopTelemetry } from '../lib/desktop-telemetry';

  interface Props {
    reauth?: boolean;
    onsuccess?: (auth: { authenticated: boolean; expiresAt: string }) => void;
  }

  let { reauth = false, onsuccess }: Props = $props();

  type SignInProvider = 'Google' | 'Microsoft';
  const providers: { key: SignInProvider; label: string }[] = [
    { key: 'Google', label: 'Google' },
    { key: 'Microsoft', label: 'Microsoft' },
  ];

  let loadingProvider = $state<SignInProvider | null>(null);
  let error = $state('');
  let lastProvider = $state<SignInProvider | null>(null);
  let activeState = $state<string | null>(null);
  let signInRun = 0;

  function isCurrentSignInRun(run: number): boolean {
    return run === signInRun;
  }

  async function cancelPendingSignIn(state = activeState) {
    try {
      await invoke('oauth_cancel_listen', { state });
    } catch (cancelError) {
      console.warn('[signin] failed to cancel OAuth listener:', cancelError);
    }
  }

  async function handleSignIn(provider: SignInProvider) {
    const run = ++signInRun;
    loadingProvider = provider;
    error = '';
    lastProvider = provider;
    activeState = null;
    console.info('[signin] OAuth runner started', { provider });

    try {
      // Step 1: Start OAuth login. This binds both loopback listener families
      // before the provider URL is returned, so a fast redirect cannot race it.
      const { authorizeUrl, state } = await invoke<{
        authorizeUrl: string;
        state: string;
      }>('start_oauth_login', { provider });
      if (!isCurrentSignInRun(run)) {
        await cancelPendingSignIn(state);
        return;
      }
      activeState = state;

      // Step 2: Open browser for user to authenticate
      console.info('[signin] OAuth browser open requested', { provider });
      await open(authorizeUrl);
      console.info('[signin] OAuth browser opened', { provider });
      if (!isCurrentSignInRun(run)) return;

      // Step 3: Listen for the OAuth callback code
      console.info('[signin] OAuth runner waiting for callback', { provider });
      const { code } = await invoke<{ code: string }>(
        'oauth_listen_for_code',
        { state }
      );
      if (!isCurrentSignInRun(run)) return;

      // Step 4: Exchange code for tokens
      console.info('[signin] OAuth token exchange requested', { provider });
      const result = await invoke<{
        authenticated: boolean;
        expiresAt: string;
      }>('oauth_exchange_code', { code });
      if (!isCurrentSignInRun(run)) return;

      // Step 5: Notify parent of success
      if (result.authenticated) {
        // Pull focus back from the browser to the menubar popover so the
        // user sees the post-sign-in UI transition immediately. `.show()`
        // is defensive — the popover should still be open from the tray
        // click that started this flow, but the OAuth redirect can take a
        // while and users occasionally dismiss the window in the meantime.
        try {
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
        } catch (focusErr) {
          // Focus-stealing isn't critical; log but don't block success.
          console.warn('[signin] failed to refocus window:', focusErr);
        }
        void emitDesktopTelemetry({
          eventName: 'oauth_signin_succeeded',
          properties: { provider },
        });
        console.info('[signin] OAuth runner succeeded', { provider });
        onsuccess?.(result);
      } else {
        error = 'That sign-in did not finish. Choose your provider and try once more.';
      }
    } catch (err) {
      if (!isCurrentSignInRun(run)) return;
      console.error('[signin] OAuth runner failed:', err);
      error = 'That sign-in did not finish. Choose your provider and try once more.';
      await cancelPendingSignIn();
    } finally {
      if (isCurrentSignInRun(run)) {
        loadingProvider = null;
        activeState = null;
        console.info('[signin] OAuth runner idle', { provider });
      }
    }
  }

  async function handleCancel() {
    if (!loadingProvider) return;

    const provider = loadingProvider;
    const state = activeState;
    ++signInRun;
    console.info('[signin] OAuth runner cancellation requested', { provider });
    await cancelPendingSignIn(state);
    loadingProvider = null;
    activeState = null;
    error = 'Sign-in cancelled. Retry when you are ready.';
    console.info('[signin] OAuth runner cancelled', { provider });
  }

  function handleRetry() {
    if (lastProvider && !loadingProvider) {
      void handleSignIn(lastProvider);
    }
  }

  // Escape hatch: an always-available way out if a browser sign-in stalls and
  // never redirects back (the loopback listener has its own 5-min timeout, but
  // the user shouldn't be trapped staring at a spinner until then).
  async function handleQuit() {
    try {
      await invoke('quit_app');
    } catch (e) {
      console.error('Failed to quit:', e);
    }
  }
</script>

<div class="sign-in-container">
  <div class="sign-in-card">
    <div class="icon">
      <svg
        width="48"
        height="48"
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M24 4L8 12v12c0 11.1 6.8 21.4 16 24 9.2-2.6 16-12.9 16-24V12L24 4z"
          fill="currentColor"
          opacity="0.15"
        />
        <path
          d="M24 4L8 12v12c0 11.1 6.8 21.4 16 24 9.2-2.6 16-12.9 16-24V12L24 4z"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linejoin="round"
          fill="none"
        />
        <path
          d="M18 24l4 4 8-8"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </div>

    <h1>{reauth ? 'Keep sync moving' : 'Sign in to HQ'}</h1>
    <p class="description">
      {reauth
        ? 'Your files are safe. Continue with your provider and HQ will resume syncing.'
        : 'Use Google or Microsoft to sync your HQ files.'}
    </p>

    <div class="sign-in-actions">
      {#each providers as provider}
        <button
          class="sign-in-btn"
          onclick={() => handleSignIn(provider.key)}
          disabled={loadingProvider !== null}
        >
          {#if loadingProvider === provider.key}
            <span class="spinner"></span>
            Waiting for browser…
          {:else}
            {#if provider.key === 'Google'}
              {@render GoogleGlyph()}
            {:else}
              {@render MicrosoftGlyph()}
            {/if}
            Continue with {provider.label}
          {/if}
        </button>
      {/each}
    </div>

    {#if loadingProvider}
      <p class="loading-hint">
        A browser window opened for {loadingProvider} sign-in. Complete it there and
        you'll return here automatically. You can cancel, retry, or quit if sign-in gets stuck.
      </p>
      <button class="cancel-btn" onclick={handleCancel}>Cancel sign-in</button>
    {/if}

    <button class="quit-btn" onclick={handleQuit}>Quit HQ Sync</button>

    {#if error}
      <div class="error-block">
        <p class="error">{error}</p>
        {#if lastProvider}
          <button class="retry-btn" onclick={handleRetry}>
            Retry {lastProvider} sign-in
          </button>
        {/if}
        <CopyPromptButton
          variant="inline"
          label="Copy prompt"
          issue={{ kind: 'auth-expired', payload: { message: error } }}
        />
      </div>
    {/if}

    <p class="footer">Powered by Indigo</p>
  </div>
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
  .sign-in-container {
    display: flex;
    align-items: center;
    justify-content: center;
    /* Fill the window exactly and paint our own backdrop. The root
       html/body is transparent (so the Popover's rounded corners can
       show the desktop); without this the sign-in view inherits that
       transparency and the login screen looks like it's floating on
       the desktop. Matches .popover in Popover.svelte. */
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    padding: 1rem;
    background: var(--pop-bg);
    backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
    -webkit-backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
    color: var(--pop-text);
    font-family: var(--font-sans);
    overflow: hidden;
    /* Rounded corners — requires tauri window transparent:true +
       decorations:false + macOSPrivateApi:true for the OS to honor
       transparency outside the radius. */
    border-radius: 18px;
    border: 1px solid var(--pop-border);
    box-shadow: var(--pop-shadow), inset 0 1px 0 var(--pop-highlight);
  }

  .sign-in-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    width: 100%;
    max-width: 280px;
  }

  .icon {
    margin-bottom: 1rem;
  }

  h1 {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--pop-text);
    margin: 0 0 0.5rem 0;
  }

  .description {
    font-size: 0.8125rem;
    color: var(--pop-muted);
    margin: 0 0 1.5rem 0;
    line-height: 1.4;
  }

  .sign-in-actions {
    display: grid;
    gap: 0.625rem;
    width: 100%;
  }

  .sign-in-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.625rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 500;
    font-family: inherit;
    color: var(--pop-acc-fg);
    background-color: var(--pop-accent);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: background-color 0.15s ease, opacity 0.15s ease;
  }

  .sign-in-btn:hover:not(:disabled) {
    filter: brightness(0.94);
  }

  .sign-in-btn:active:not(:disabled) {
    filter: brightness(0.88);
  }

  .sign-in-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid color-mix(in srgb, var(--pop-acc-fg) 22%, transparent);
    border-top-color: var(--pop-acc-fg);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Sign-in failure: neutral grey notice — same rule as the rest of the app.
     The Copy-prompt button next to the message hands the failure to an HQ
     agent that can run `/hq-login` or diagnose deeper. */
  .error-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .error {
    font-size: 0.75rem;
    color: var(--pop-muted);
    margin: 0;
    line-height: 1.4;
  }

  .loading-hint {
    font-size: 0.6875rem;
    color: var(--pop-muted);
    margin: 0.75rem 0 0 0;
    line-height: 1.4;
  }

  .cancel-btn,
  .quit-btn,
  .retry-btn {
    margin-top: 0.875rem;
    padding: 0.375rem 0.625rem;
    font-size: 0.75rem;
    font-family: inherit;
    color: var(--pop-muted);
    background: none;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .cancel-btn:hover,
  .quit-btn:hover,
  .retry-btn:hover {
    background: var(--pop-hover);
    color: var(--pop-text);
  }

  .provider-glyph {
    flex-shrink: 0;
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

  .footer {
    font-size: 0.6875rem;
    color: var(--dot);
    margin: 1.5rem 0 0 0;
    letter-spacing: 0.02em;
  }

  @media (prefers-reduced-transparency: reduce) {
    .sign-in-container {
      background: var(--c-bg);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }
</style>
