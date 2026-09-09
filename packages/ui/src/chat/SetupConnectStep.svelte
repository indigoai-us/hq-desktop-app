<script lang="ts">
  /**
   * The Connect step on #welcome: before setup can run, at least one coding
   * agent (Claude Code or Codex) must be installed and signed in on this Mac.
   * The same flow the Sessions page shows, in the hero's voice. Talks to the
   * host only through `SetupRunApi` (provider status + browser sign-in).
   */
  import { onDestroy } from "svelte";
  import type { SetupProviderLoginState, SetupProviderStatus, SetupProviderTool, SetupRunApi } from "./setup-run";

  interface Props {
    api: SetupRunApi;
    providers: SetupProviderStatus;
    /** Ask the host again (after a sign-in or an install). */
    onrefresh: () => Promise<void>;
  }

  let { api, providers, onrefresh }: Props = $props();

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

<div class="connect" data-testid="setup-connect-step" aria-label="Connect an agent">
  <p class="lead">Setup runs through your own coding agent. Connect one to continue — you only need one.</p>
  <ul class="providers">
    {#each TOOLS as tool (tool.id)}
      <li class="provider" data-testid={`setup-connect-${tool.id}`} data-state={connected(tool.id) ? "connected" : available(tool.id) ? "available" : "missing"}>
        <span class="provider-text">
          <span class="provider-name">{tool.name}</span>
          <span class="provider-state">
            {connected(tool.id) ? "Connected" : available(tool.id) ? "Installed, not signed in" : `Not installed — it comes with the ${tool.app} app`}
          </span>
        </span>
        {#if connected(tool.id)}
          <span class="provider-check" aria-hidden="true">✓</span>
        {:else if available(tool.id)}
          <button
            type="button"
            class="launch-btn primary"
            data-testid={`setup-connect-${tool.id}-signin`}
            disabled={busy || loginState === "waiting"}
            onclick={() => void connect(tool.id)}
          >
            {busy && active === tool.id ? "Opening sign-in…" : `Connect ${tool.app}`}
          </button>
        {:else}
          <button type="button" class="launch-btn" data-testid={`setup-connect-${tool.id}-install`} onclick={() => void install(tool.id)}>
            Get the {tool.app} app
          </button>
        {/if}
      </li>
    {/each}
  </ul>
  {#if active && (loginState === "waiting" || loginState === "error" || message)}
    <div class="flow" aria-live="polite" data-testid="setup-connect-flow">
      {#if loginState === "waiting"}
        <span>Finish signing in in your browser — HQ will notice on its own.</span>
        <button type="button" class="quiet-btn" disabled={busy} onclick={() => void cancel()}>Cancel</button>
      {:else}
        <span class:error={loginState === "error"}>{message || "Sign-in did not complete."}</span>
        <button type="button" class="quiet-btn" disabled={busy} onclick={() => void connect(active!)}>Try again</button>
      {/if}
    </div>
  {:else if message}
    <p class="flow" aria-live="polite">{message}</p>
  {/if}
  <button type="button" class="quiet-btn" data-testid="setup-connect-check" disabled={busy || loginState === "waiting"} onclick={() => void checkAgain()}>
    {busy ? "Checking…" : "Already signed in? Check again"}
  </button>
</div>

<style>
  .connect {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 56ch;
    color: #ffffff;
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
    gap: 10px;
    margin: 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.78);
  }
  .error {
    color: #ffb4b4;
  }
  .launch-btn {
    display: inline-flex;
    align-items: center;
    min-height: 30px;
    padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.38);
    border-radius: 0;
    background: rgba(6, 6, 6, 0.28);
    color: #ffffff;
    font: inherit;
    font-size: var(--text-base, 13px);
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
  }
  .launch-btn.primary {
    border-color: #ffffff;
    background: #ffffff;
    color: #0a0b0d;
  }
  .launch-btn:disabled,
  .quiet-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .quiet-btn {
    align-self: flex-start;
    min-height: 22px;
    padding: 0;
    border: 0;
    background: transparent;
    color: rgba(255, 255, 255, 0.72);
    font: inherit;
    font-size: 12px;
    text-decoration: underline;
    text-underline-offset: 0.16em;
    cursor: pointer;
  }
</style>
