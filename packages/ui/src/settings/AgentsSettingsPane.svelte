<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import type { PlatformAdapter, SessionProviderId } from "@hq/platform";
  import { hostComputerNoun } from "@hq/platform";
  import "./settings-chrome.css";
  import { announceRuntimeSignedIn } from "../chat/messaging/runtime-repair.svelte.js";
  import { CONNECTOR_APPS, INDIGO_MCP_URL, copyConnectorSetup } from "./hq-connector-setup.js";

  interface Props {
    adapter?: PlatformAdapter | null;
  }

  let { adapter = null }: Props = $props();

  const PROVIDERS: Array<{ id: SessionProviderId; name: string; short: string }> = [
    { id: "claude", name: "Claude Code", short: "Claude" },
    { id: "codex", name: "Codex", short: "Codex" },
    { id: "grok", name: "Grok", short: "Grok" },
  ];

  /**
   * The plain-language name for the host machine ("Mac", "PC", or
   * "computer"). Read once so the AI-tools lede never renames the machine
   * mid-flight.
   */
  const hostNoun = hostComputerNoun();

  let loading = $state(true);
  let error = $state("");
  let flags = $state<Record<string, boolean>>({});
  let models = $state<Partial<Record<SessionProviderId, string[]>>>({});
  let busy = $state<SessionProviderId | null>(null);
  let action = $state<"install" | "connect" | null>(null);
  let line = $state("");
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function available(id: SessionProviderId) {
    return Boolean(flags[`${id}Available`]);
  }
  function signedIn(id: SessionProviderId) {
    return available(id) && Boolean(flags[`${id}LoggedIn`]);
  }
  function statusLabel(id: SessionProviderId) {
    if (loading && !Object.keys(flags).length) return "Checking…";
    if (signedIn(id)) return "Signed in on this device";
    if (available(id)) return "Installed, not signed in";
    return "Not installed";
  }

  function modelLabels(raw: unknown): string[] {
    if (!raw || typeof raw !== "object") return [];
    const list = (raw as { models?: unknown }).models;
    if (!Array.isArray(list)) return [];
    const labels: string[] = [];
    for (const entry of list) {
      if (typeof entry === "string" && entry && entry !== "default") {
        labels.push(entry);
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      const value = rec.value ?? rec.id;
      if (value === "default" || value == null) continue;
      const label =
        (typeof rec.displayName === "string" && rec.displayName) ||
        (typeof rec.label === "string" && rec.label) ||
        String(value);
      if (label) labels.push(label);
    }
    return labels;
  }

  async function load() {
    const sessions = adapter?.sessions;
    if (!sessions?.preflight) {
      loading = false;
      error = "AI tool sign-in is only available in the HQ desktop app.";
      return;
    }
    loading = true;
    error = "";
    const result = await sessions.preflight();
    if (!result.ok) {
      console.warn("[agents-settings] preflight failed", result.message);
      error = "Couldn't read AI tool status. Try again.";
      loading = false;
      return;
    }
    const rec = result.value as Record<string, unknown>;
    flags = {
      claudeAvailable: rec.claudeAvailable === true,
      claudeLoggedIn: rec.claudeLoggedIn === true,
      codexAvailable: rec.codexAvailable === true,
      codexLoggedIn: rec.codexLoggedIn === true,
      grokAvailable: rec.grokAvailable === true,
      grokLoggedIn: rec.grokLoggedIn === true,
    };
    const next: Partial<Record<SessionProviderId, string[]>> = {};
    await Promise.all(
      PROVIDERS.filter((provider) => flags[`${provider.id}Available`]).map(async (provider) => {
        if (!sessions.slashCommands) return;
        const catalog = await sessions.slashCommands(provider.id);
        next[provider.id] = catalog.ok ? modelLabels(catalog.value) : [];
      }),
    );
    models = next;
    loading = false;
  }

  function stopPolling() {
    clearTimeout(timer);
    timer = undefined;
  }

  async function poll(id: SessionProviderId, token: number) {
    const status = adapter?.sessions.loginStatus;
    if (!status) return;
    const result = await status(id);
    if (token !== generation) return;
    const state = result.ok ? String((result.value as { state?: string }).state ?? "") : "error";
    if (state === "connected") {
      stopPolling();
      announceRuntimeSignedIn(id);
      busy = null;
      action = null;
      line = "";
      await load();
      return;
    }
    if (state === "waiting") {
      timer = setTimeout(() => void poll(id, token), 1500);
      return;
    }
    busy = null;
    console.warn(
      "[agents-settings] sign-in status failed",
      result.ok ? (result.value as { message?: string }).message : result.message,
    );
    line = result.ok
      ? "Sign-in did not complete. Try again."
      : "Couldn't check sign-in. Try again.";
  }

  async function connect(id: SessionProviderId) {
    if (busy || !adapter?.sessions.loginStart) return;
    stopPolling();
    busy = id;
    action = "connect";
    line = "Opening sign-in…";
    const token = ++generation;
    const result = await adapter.sessions.loginStart(id);
    if (token !== generation) return;
    if (!result.ok) {
      busy = null;
      console.warn("[agents-settings] sign-in start failed", result.message);
      line = `Couldn't open sign-in. Try again, or run \`${id === "claude" ? "claude" : id} login\` in a terminal.`;
      return;
    }
    const state = String((result.value as { state?: string }).state ?? "");
    if (state === "connected") {
      announceRuntimeSignedIn(id);
      busy = null;
      action = null;
      line = "";
      await load();
      return;
    }
    if (state === "waiting") {
      line = "Finish signing in in your browser. HQ will detect it automatically.";
      timer = setTimeout(() => void poll(id, token), 1500);
      return;
    }
    busy = null;
    console.warn("[agents-settings] sign-in did not complete", (result.value as { message?: string }).message);
    line = "Sign-in did not complete. Try again.";
  }

  async function install(id: SessionProviderId) {
    if (busy || !adapter?.sessions.installProvider) return;
    stopPolling();
    busy = id;
    action = "install";
    line = `Installing ${PROVIDERS.find((provider) => provider.id === id)?.name ?? id}…`;
    const result = await adapter.sessions.installProvider(id);
    if (!result.ok) {
      console.warn("[agents-settings] install failed", result.message);
      line = "Install failed. Check your network and try again.";
      busy = null;
      action = null;
      return;
    }
    line = "Installed. Connect to sign in.";
    busy = null;
    action = null;
    await load();
  }

  // Connect-AI-apps copy buttons. On a denied clipboard the setup text is
  // revealed inline so the person can select it by hand, and the button stays
  // live to retry.
  let copiedId = $state<string | null>(null);
  let copyFailedId = $state<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  async function copySetup(app: { id: string; copyText: string }) {
    clearTimeout(copyTimer);
    copiedId = null;
    copyFailedId = null;
    if (await copyConnectorSetup(app.copyText)) {
      copiedId = app.id;
      copyTimer = setTimeout(() => (copiedId = null), 1500);
    } else {
      copyFailedId = app.id;
    }
  }

  $effect(() => {
    void adapter;
    void load();
    return () => {
      ++generation;
      stopPolling();
    };
  });
</script>

<div class="ss-stack" data-testid="settings-agents-pane">
  <div class="ss-section">
    <p class="ss-section-label">AI tools</p>
    <p class="ss-lede">
      Sign in to the tools your local bots think with. Local bots and sessions use the Claude Code, Codex, or Grok CLI on this {hostNoun}; HQ can install the CLI and open the tool’s own sign-in. HQ sign-in is separate. Usage stays with the tool account - remaining quota is not shown here yet.
    </p>
    {#if error}
      <p class="ss-lede" role="alert" data-testid="settings-agents-error">{error}</p>
    {/if}
    {#each PROVIDERS as provider}
      <div class="ss-field" data-testid={`settings-agent-${provider.id}`}>
        <div>
          <div class="ss-field-label">{provider.name}</div>
          <div class="ss-field-help">{statusLabel(provider.id)}</div>
          {#if signedIn(provider.id) && (models[provider.id] ?? []).length}
            <div class="ss-field-help" data-testid={`settings-agent-${provider.id}-models`}>
              Models: {(models[provider.id] ?? []).join(", ")}
            </div>
          {/if}
        </div>
        <div>
          {#if signedIn(provider.id)}
            <span class="ss-field-value">Ready</span>
          {:else if available(provider.id)}
            <button
              type="button"
              class="ss-btn"
              disabled={Boolean(busy) || loading}
              onclick={() => void connect(provider.id)}
            ><RailIcon name="plug" />
              {busy === provider.id && action === "connect" ? "Connecting…" : `Connect ${provider.short}`}
            </button>
          {:else}
            <button
              type="button"
              class="ss-btn"
              disabled={Boolean(busy) || loading || !adapter?.sessions.installProvider}
              onclick={() => void install(provider.id)}
            ><RailIcon name="download" />
              {busy === provider.id && action === "install" ? "Installing…" : `Install ${provider.short}`}
            </button>
          {/if}
        </div>
      </div>
    {/each}
    {#if line}
      <p class="ss-lede" aria-live="polite">{line}</p>
    {/if}
  </div>

  <div class="ss-section" data-testid="settings-hq-connector">
    <p class="ss-section-label">Connect AI apps to HQ</p>
    <p class="ss-lede">
      Let Grok Bot, Claude, ChatGPT, Codex, or the Grok CLI read and write your HQ files and use your secrets and connected apps. Copy the setup for your app, paste it there, and sign in to HQ when the browser opens. One sign-in covers every company you belong to.
    </p>
    {#each [{ id: "url", name: "Connector URL", help: INDIGO_MCP_URL, copyText: INDIGO_MCP_URL }, ...CONNECTOR_APPS] as app (app.id)}
      <div class="ss-field" data-testid={`settings-hq-connector-${app.id}`}>
        <div class="ss-field-text">
          <div class="ss-field-label">{app.name}</div>
          <div class="ss-field-help">{app.help}</div>
          {#if "steps" in app && app.steps}
            <ol class="ss-field-help hq-connector-steps" data-testid={`settings-hq-connector-${app.id}-steps`}>
              {#each app.steps as step}<li>{step}</li>{/each}
            </ol>
          {/if}
          {#if copyFailedId === app.id}
            <pre class="ss-field-help hq-connector-manual" data-testid={`settings-hq-connector-${app.id}-manual`}>{app.copyText}</pre>
            <div class="ss-field-help" role="status">Copy didn't work. Select the text above, or tap the button to try again.</div>
          {/if}
        </div>
        <button
          type="button"
          class="ss-btn"
          data-testid={`settings-hq-connector-${app.id}-copy`}
          onclick={() => void copySetup(app)}
        >{copiedId === app.id ? "Copied" : ("copyLabel" in app && app.copyLabel) || "Copy"}</button>
      </div>
    {/each}
  </div>
</div>

<style>
  .hq-connector-steps {
    margin: 6px 0 0;
    padding-left: 18px;
  }
  .hq-connector-steps li + li {
    margin-top: 2px;
  }
  .hq-connector-manual {
    margin: 6px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }
</style>
