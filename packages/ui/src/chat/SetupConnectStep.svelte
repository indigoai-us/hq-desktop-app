<script lang="ts">
  /**
   * The Connect step on #welcome: before setup can run, at least one coding
   * agent (Claude Code or Codex) must be installed and signed in on this Mac.
   * The same flow the Sessions page shows, in the hero's voice. Talks to the
   * host only through `SetupRunApi` (provider status + browser sign-in).
   */
  import { onDestroy } from "svelte";
  import SetupButton from "./SetupButton.svelte";
  import type { SetupProviderLoginState, SetupProviderStatus, SetupProviderTool, SetupRunApi } from "./setup-run";

  interface Props {
    api: SetupRunApi;
    providers: SetupProviderStatus;
    /** Ask the host again (after a sign-in or an install). */
    onrefresh: () => Promise<void>;
    /** `hero`: white on the wallpaper. `surface`: shell tokens, under the chat. */
    variant?: "hero" | "surface";
    /** Shorter lead for the in-chat version. */
    lead?: string;
    /** The engine's own words about why the run stopped, kept small. */
    detail?: string;
    /** Offered on signed-in rows: run setup with that agent. */
    onrun?: (tool: SetupProviderTool) => void;
    runBusy?: boolean;
  }

  let { api, providers, onrefresh, variant = "hero", lead, detail, onrun, runBusy = false }: Props = $props();

  const TOOLS: readonly { id: SetupProviderTool; name: string; app: string }[] = [
    { id: "claude", name: "Claude Code", app: "Claude" },
    { id: "codex", name: "Codex", app: "ChatGPT" },
  ];

  const available = (tool: SetupProviderTool) => (tool === "claude" ? providers.claudeAvailable : providers.codexAvailable);
  const connected = (tool: SetupProviderTool) =>
    available(tool) && (tool === "claude" ? providers.claudeLoggedIn : providers.codexLoggedIn);

  let active = $state<SetupProviderTool | null>(null);
  let loginState = $state<SetupProviderLoginState["state"]>("disconnected");
  let message = $state("");
  let busy = $state(false);
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function stopPolling(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  async function apply(result: SetupProviderLoginState, tool: SetupProviderTool, token: number): Promise<void> {
    if (token !== generation) return;
    loginState = result.state;
    message = result.message ?? "";
    if (result.state === "connected") {
      stopPolling();
      await onrefresh();
    } else if (result.state === "waiting") {
      timer = setTimeout(() => void poll(tool, token), 1500);
    }
  }

  async function poll(tool: SetupProviderTool, token: number): Promise<void> {
    try {
      await apply(await api.providerLoginStatus!(tool), tool, token);
    } catch {
      if (token === generation) {
        loginState = "error";
        message = "Could not check sign-in. Please try again.";
      }
    }
  }

  async function connect(tool: SetupProviderTool): Promise<void> {
    if (busy || loginState === "waiting" || !api.providerLoginStart) return;
    stopPolling();
    active = tool;
    busy = true;
    message = "";
    const token = ++generation;
    try {
      await apply(await api.providerLoginStart(tool), tool, token);
    } catch {
      if (token === generation) {
        loginState = "error";
        message = "Could not open sign-in. Check that the app is installed, then try again.";
      }
    } finally {
      if (token === generation) busy = false;
    }
  }

  async function cancel(): Promise<void> {
    const tool = active;
    if (!tool || busy || !api.providerLoginCancel) return;
    stopPolling();
    const token = ++generation;
    busy = true;
    try {
      const result = await api.providerLoginCancel(tool);
      if (token !== generation) return;
      await apply(result, tool, token);
      if (result.state === "disconnected") {
        active = null;
        message = "";
      }
    } catch {
      loginState = "error";
      message = "Could not cancel sign-in. Try again.";
    } finally {
      busy = false;
    }
  }

  async function checkAgain(): Promise<void> {
    if (busy) return;
    busy = true;
    message = "";
    try {
      await onrefresh();
      if (!TOOLS.some((tool) => connected(tool.id))) message = "No sign-in found yet.";
    } finally {
      busy = false;
    }
  }

  async function install(tool: SetupProviderTool): Promise<void> {
    const url = api.providerInstallUrl?.(tool);
    if (!url) return;
    try {
      await api.openExternal?.(url);
    } catch {
      message = `Could not open the download page. Visit ${url} in your browser.`;
    }
  }

  onDestroy(() => {
    ++generation;
    stopPolling();
  });
</script>

<div class="connect" class:connect--surface={variant === "surface"} data-testid="setup-connect-step" aria-label="Connect an AI tool">
  <p class="lead">{lead ?? "Setup runs through your own coding tool. Connect one to continue — you only need one."}</p>
  {#if detail}
    <p class="detail" data-testid="setup-connect-detail">{detail}</p>
  {/if}
  <ul class="providers">
    {#each TOOLS as tool (tool.id)}
      <li class="provider" data-testid={`setup-connect-${tool.id}`} data-state={connected(tool.id) ? "connected" : available(tool.id) ? "available" : "missing"}>
        <span class="provider-text">
          <span class="provider-name">{tool.name}</span>
          <span class="provider-state">
            {connected(tool.id) ? "Connected" : available(tool.id) ? "Installed, not signed in" : `Not installed — it comes with the ${tool.app} app`}
          </span>
        </span>
        {#if connected(tool.id) && onrun}
          <SetupButton
            variant="primary"
            data-testid={`setup-connect-${tool.id}-run`}
            disabled={runBusy || busy}
            onclick={() => onrun?.(tool.id)}
          >
            Run Setup with {tool.name}
          </SetupButton>
        {:else if connected(tool.id)}
          <span class="provider-check" aria-hidden="true">✓</span>
        {:else if available(tool.id)}
          <SetupButton
            variant="primary"
            data-testid={`setup-connect-${tool.id}-signin`}
            disabled={busy || loginState === "waiting"}
            onclick={() => void connect(tool.id)}
          >
            {busy && active === tool.id ? "Opening sign-in…" : `Connect ${tool.app}`}
          </SetupButton>
        {:else}
          <SetupButton data-testid={`setup-connect-${tool.id}-install`} onclick={() => void install(tool.id)}>
            Get the {tool.app} app
          </SetupButton>
        {/if}
      </li>
    {/each}
  </ul>
  {#if active && (loginState === "waiting" || loginState === "error" || message)}
    <div class="flow" aria-live="polite" data-testid="setup-connect-flow">
      {#if loginState === "waiting"}
        <span>Finish signing in in your browser — HQ will notice on its own.</span>
        <SetupButton variant="quiet" disabled={busy} onclick={() => void cancel()}>Cancel</SetupButton>
      {:else}
        <span class:error={loginState === "error"}>{message || "Sign-in did not complete."}</span>
        <SetupButton variant="quiet" disabled={busy} onclick={() => void connect(active!)}>Try again</SetupButton>
      {/if}
    </div>
  {:else if message}
    <p class="flow" aria-live="polite">{message}</p>
  {/if}
  <SetupButton variant="quiet" data-testid="setup-connect-check" disabled={busy || loginState === "waiting"} onclick={() => void checkAgain()}>
    {busy ? "Checking…" : "Already signed in? Check again"}
  </SetupButton>
</div>

<style>
  .connect--surface {
    --c-text: var(--text-1, inherit);
    --c-text-2: var(--text-2, inherit);
    --c-text-3: var(--text-3, rgba(127, 127, 127, 0.9));
    --c-line: var(--border, rgba(127, 127, 127, 0.25));
    --c-error: var(--danger, #d9534f);
    color: var(--c-text);
    max-width: 48ch;
  }
  .connect--surface .lead,
  .connect--surface .flow {
    color: var(--c-text-2);
  }
  .detail {
    margin: -4px 0 8px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--c-text-3, rgba(255, 255, 255, 0.7));
    overflow-wrap: anywhere;
  }
  .connect--surface .detail {
    color: var(--c-text-3);
  }
  .connect--surface .provider {
    border-top-color: var(--c-line);
  }
  .connect--surface .provider-state {
    color: var(--c-text-3);
  }
  .connect--surface .error {
    color: var(--c-error);
  }

  .connect {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 56ch;
    color: #ffffff;
  }
  /* On the wallpaper the buttons are white on art (see SetupButton). */
  .connect:not(.connect--surface) {
    --setup-btn-fg: #fff;
    --setup-btn-line: rgba(255, 255, 255, 0.6);
    --setup-btn-primary-bg: #fff;
    --setup-btn-primary-fg: #111;
    --setup-btn-muted: rgba(255, 255, 255, 0.8);
    --setup-btn-hover: rgba(255, 255, 255, 0.14);
  }
  /* Column parent: keep the standalone check button its own width. */
  .connect > :global(.setup-btn) {
    align-self: flex-start;
  }
  .lead {
    margin: 0;
    font-size: var(--text-base, 13px);
    line-height: 1.55;
    color: rgba(255, 255, 255, 0.78);
  }
  .providers {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .provider {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
    border-top: 1px solid rgba(255, 255, 255, 0.18);
  }
  .provider-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .provider-name {
    font-size: 13px;
    font-weight: 600;
  }
  .provider-state {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.66);
  }
  .provider-check {
    font-weight: 600;
  }
  .flow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.78);
  }
  .error {
    color: #ffb4b4;
  }
</style>
