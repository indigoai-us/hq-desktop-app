<!--
  ONE root route for all three targets.

  Web renders the shell straight away: its session was already resolved by the
  root layout, and hq-pro requests are authorised by a same-origin token read.

  A phone has neither. It signs in to the same Cognito app client itself, in
  the system browser, and comes back through the hqmobile:// deep link — so it
  needs a sign-in surface the static bundle can actually reach. `/auth/signin`
  is a server route that is not published to `build/`; navigating a phone there
  is how the shell ends up on SvelteKit's 404 page.

  The branch below is the whole divergence. Everything under it is shared.
-->
<script lang="ts">
  import { onMount } from "svelte";

  import { env } from "$env/dynamic/public";
  import { resolveHostPlatform } from "@hq/platform";

  import WorkShell from "$lib/WorkShell.svelte";
  import { createHqProFetch } from "$lib/hq-pro-client";
  import {
    createTauriMobileAuthSession,
    listenForAuthCallback,
    mobileTokenProvider,
  } from "$lib/mobile-auth-host";
  import {
    createMobileSignIn,
    type MobileSignInState,
  } from "$lib/mobile-sign-in";

  let { data } = $props();

  const platform = resolveHostPlatform();
  const isPhone = platform === "ios" || platform === "android";

  let signInState = $state<MobileSignInState>("checking");

  // Constructed once, and only on a phone: the desktop and web paths must not
  // pay for a Cognito client they never use.
  const mobile = isPhone
    ? (() => {
        const session = createTauriMobileAuthSession();
        const flow = createMobileSignIn({
          session,
          onState: (state) => (signInState = state),
        });
        return {
          flow,
          fetch: createHqProFetch({
            tokenProvider: mobileTokenProvider(session),
            // Never navigate a static bundle to the server sign-in route.
            onUnauthorized: () => flow.signOut(),
          }),
        };
      })()
    : null;

  onMount(() => {
    if (!mobile) return;
    void mobile.flow.start();
    // The listener is registered after start() is kicked off, not awaited
    // before it: a cold launch straight into the callback is replayed by
    // getCurrent() inside listenForAuthCallback.
    const unlisten = listenForAuthCallback((url) => {
      void mobile.flow.handleCallback(url);
    });
    return () => {
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  });
</script>

{#if !mobile}
  <WorkShell {data} apiUrl={env.PUBLIC_HQ_PRO_API_URL} />
{:else if signInState === "signed-in"}
  <WorkShell
    {data}
    apiUrl={env.PUBLIC_HQ_PRO_API_URL}
    fetch={mobile.fetch}
    onUnauthorized={() => mobile.flow.signOut()}
  />
{:else}
  <main class="gate" data-testid="mobile-signin">
    <span class="brand">HQ Work</span>
    {#if signInState === "checking"}
      <p class="lede" data-testid="mobile-signin-checking">Signing you in…</p>
    {:else}
      <h1>Sign in to HQ Work</h1>
      <p class="lede">
        This opens your browser to sign in, then brings you straight back.
      </p>
      <button
        class="go"
        data-testid="mobile-signin-start"
        disabled={signInState === "opening"}
        onclick={() => void mobile.flow.signIn()}
      >
        {signInState === "opening" ? "Opening your browser…" : "Sign in"}
      </button>
    {/if}
  </main>
{/if}

<style>
  .gate {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    min-height: 100dvh;
    padding: 2rem 1.5rem;
    text-align: center;
    background: var(--hq-bg, #0b0d12);
    color: var(--hq-fg, #e8eaf0);
  }

  .brand {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    opacity: 0.6;
  }

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
</style>
