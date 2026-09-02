<!--
  Branded sign-in card. Ported from hq-console's /signin (page.tsx +
  provider-buttons.tsx) — same dark card + provider-button visual language,
  reimplemented in SvelteKit with component-scoped CSS (apps/web ships no
  Tailwind).

  Each enabled provider is a plain <a> to /auth/signin?idp=<Provider>; the
  server load turns that into the Cognito deep-link redirect. Full navigation
  (data-sveltekit-reload) so the browser follows the off-origin 302 instead of
  the client router trying to fetch it. Disabled providers render as a dead,
  labelled button with a "coming soon" note — never a link that 400s.
-->
<script lang="ts">
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  function href(id: string): string {
    const q = new URLSearchParams({ idp: id });
    if (data.callbackUrl && data.callbackUrl !== "/") {
      q.set("callbackUrl", data.callbackUrl);
    }
    return `/auth/signin?${q.toString()}`;
  }
</script>

<svelte:head>
  <title>Sign in — HQ Work</title>
</svelte:head>

<main class="wrap">
  <section class="card">
    <span class="brand">HQ Work</span>
    <h1>Sign in to HQ Work</h1>
    <p class="lede">Choose the provider connected to your HQ account.</p>

    {#if data.error}
      <p class="alert" role="alert" data-testid="signin-error">{data.error}</p>
    {/if}

    <div class="providers">
      {#each data.providers as provider (provider.id)}
        {#if provider.enabled && data.configured}
          <a
            class="provider"
            data-testid={`signin-${provider.id.toLowerCase()}`}
            href={href(provider.id)}
            data-sveltekit-reload
            aria-label={`Continue with ${provider.label}`}
          >
            <span class="icon">
              {#if provider.id === "Google"}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                >
                  <path
                    fill="#4285f4"
                    d="M23.5 12.3c0-.8-.1-1.5-.2-2.2H12v4.3h6.5c-.3 1.4-1.1 2.6-2.3 3.4v2.8h3.7c2.2-2 3.6-4.9 3.6-8.3Z"
                  />
                  <path
                    fill="#34a853"
                    d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.7-2.8c-1 .7-2.4 1.1-4.2 1.1-3.1 0-5.7-2.1-6.6-4.9H1.6v3C3.5 21.3 7.4 24 12 24Z"
                  />
                  <path
                    fill="#fbbc04"
                    d="M5.4 14.5c-.2-.7-.4-1.6-.4-2.5s.1-1.7.4-2.5v-3H1.6C.6 8.1 0 10 0 12s.6 3.9 1.6 5.5l3.8-3Z"
                  />
                  <path
                    fill="#ea4335"
                    d="M12 4.7c1.7 0 3.3.6 4.5 1.8l3.2-3.2C17.8 1.2 15.1 0 12 0 7.4 0 3.5 2.7 1.6 6.5l3.8 3C6.3 6.8 8.9 4.7 12 4.7Z"
                  />
                </svg>
              {:else}
                <span class="ms-icon" aria-hidden="true">
                  <span style="background:#f25022"></span>
                  <span style="background:#7fba00"></span>
                  <span style="background:#00a4ef"></span>
                  <span style="background:#ffb900"></span>
                </span>
              {/if}
            </span>
            <span class="label">Continue with {provider.label}</span>
          </a>
        {:else}
          <button
            class="provider"
            type="button"
            data-testid={`signin-${provider.id.toLowerCase()}`}
            disabled
            aria-disabled="true"
            aria-label={`Continue with ${provider.label} (coming soon)`}
          >
            <span class="icon">
              <span class="ms-icon" aria-hidden="true">
                <span style="background:#f25022"></span>
                <span style="background:#7fba00"></span>
                <span style="background:#00a4ef"></span>
                <span style="background:#ffb900"></span>
              </span>
            </span>
            <span class="label">Continue with {provider.label}</span>
            <span
              class="soon"
              data-testid={`signin-${provider.id.toLowerCase()}-note`}
            >
              Coming soon
            </span>
          </button>
        {/if}
      {/each}
    </div>

    {#if !data.configured}
      <p class="note" data-testid="signin-unconfigured">
        Sign-in is not configured in this environment.
      </p>
    {/if}
  </section>
</main>

<style>
  /*
    Adaptive palette: dark is home (matches the shell ground), but the page
    also renders correctly under prefers-color-scheme: light. All colors flow
    from these tokens so both themes stay consistent.
  */
  .wrap {
    /* dark (default) */
    --page-bg: #0b0b0d;
    --card-bg: #161618;
    --card-border: rgba(255, 255, 255, 0.08);
    --text: #fafafa;
    --text-muted: #a1a1aa;
    --text-faint: #71717a;
    --provider-bg: rgba(255, 255, 255, 0.05);
    --provider-border: rgba(255, 255, 255, 0.14);
    --provider-bg-hover: rgba(255, 255, 255, 0.09);
    --provider-border-hover: rgba(255, 255, 255, 0.24);
    --pill-bg: rgba(255, 255, 255, 0.08);
    --pill-text: #d4d4d8;
    --alert-bg: rgba(239, 68, 68, 0.1);
    --alert-border: rgba(248, 113, 113, 0.25);
    --alert-text: #fecaca;

    box-sizing: border-box;
    display: flex;
    min-height: 100vh;
    min-height: 100dvh;
    align-items: center;
    justify-content: center;
    background: var(--page-bg);
    color: var(--text);
    padding: 2.5rem 1.5rem;
    font-family:
      "Geist",
      ui-sans-serif,
      system-ui,
      -apple-system,
      "Segoe UI",
      Roboto,
      sans-serif;
  }
  @media (prefers-color-scheme: light) {
    .wrap {
      --page-bg: #f6f6f8;
      --card-bg: #ffffff;
      --card-border: rgba(0, 0, 0, 0.08);
      --text: #18181b;
      --text-muted: #52525b;
      --text-faint: #71717a;
      --provider-bg: #ffffff;
      --provider-border: rgba(0, 0, 0, 0.12);
      --provider-bg-hover: rgba(0, 0, 0, 0.03);
      --provider-border-hover: rgba(0, 0, 0, 0.22);
      --pill-bg: rgba(0, 0, 0, 0.06);
      --pill-text: #52525b;
      --alert-bg: rgba(239, 68, 68, 0.08);
      --alert-border: rgba(220, 38, 38, 0.25);
      --alert-text: #b91c1c;
    }
  }
  * {
    box-sizing: border-box;
  }
  .card {
    width: 100%;
    max-width: 26rem;
    border: 1px solid var(--card-border);
    background: var(--card-bg);
    padding: 2rem;
    border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
  }
  .brand {
    display: block;
    color: var(--text-faint);
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  h1 {
    margin: 0.5rem 0 0;
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .lede {
    margin: 0.5rem 0 0;
    line-height: 1.55;
    font-size: 0.9375rem;
    color: var(--text-muted);
  }
  .alert {
    margin-top: 1.25rem;
    border: 1px solid var(--alert-border);
    background: var(--alert-bg);
    padding: 0.625rem 0.75rem;
    font-size: 0.875rem;
    color: var(--alert-text);
    border-radius: 8px;
  }
  .providers {
    margin-top: 1.75rem;
    display: grid;
    gap: 0.75rem;
  }
  .provider {
    display: grid;
    grid-template-columns: 1.25rem 1fr auto;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    height: 2.875rem;
    padding: 0 1rem;
    border-radius: 8px;
    border: 1px solid var(--provider-border);
    background: var(--provider-bg);
    color: var(--text);
    font-size: 0.9375rem;
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background-color 0.15s ease;
  }
  a.provider:hover {
    border-color: var(--provider-border-hover);
    background: var(--provider-bg-hover);
  }
  a.provider:focus-visible {
    outline: 2px solid var(--provider-border-hover);
    outline-offset: 2px;
  }
  button.provider:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 1.25rem;
  }
  .label {
    justify-self: start;
  }
  .soon {
    justify-self: end;
    padding: 0.1875rem 0.5rem;
    border-radius: 999px;
    background: var(--pill-bg);
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--pill-text);
    white-space: nowrap;
  }
  .ms-icon {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1px;
    width: 1rem;
    height: 1rem;
  }
  .ms-icon > span {
    display: block;
  }
  .note {
    margin-top: 1.25rem;
    font-size: 0.8125rem;
    color: var(--text-faint);
  }
</style>
