<script lang="ts">
  import type { PlatformAdapter, SessionProviderId } from "@hq/platform";
  import "./settings-chrome.css";

  interface Props {
    adapter?: PlatformAdapter | null;
  }

  let { adapter = null }: Props = $props();

  const PROVIDERS: Array<{ id: SessionProviderId; name: string; short: string }> = [
    { id: "claude", name: "Claude Code", short: "Claude" },
    { id: "codex", name: "Codex", short: "Codex" },
    { id: "grok", name: "Grok", short: "Grok" },
  ];

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
      error = result.message || "Could not read AI tool status.";
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
    line = result.ok
      ? String((result.value as { message?: string }).message ?? "Sign-in did not complete.")
      : result.message || "Could not check sign-in.";
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
      line = result.message || `Could not open sign-in. If the browser did not open, run \`${id === "claude" ? "claude" : id} login\` in a terminal.`;
      return;
    }
    const state = String((result.value as { state?: string }).state ?? "");
    if (state === "connected") {
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
    line = String((result.value as { message?: string }).message ?? "Sign-in did not complete.");
  }

  async function install(id: SessionProviderId) {
    if (busy || !adapter?.sessions.installProvider) return;
    stopPolling();
    busy = id;
    action = "install";
    line = `Installing ${PROVIDERS.find((provider) => provider.id === id)?.name ?? id}…`;
    const result = await adapter.sessions.installProvider(id);
    if (!result.ok) {
      line = result.message || "Install failed. Check your network and try again.";
      busy = null;
      action = null;
      return;
    }
    line = "Installed. Connect to sign in.";
    busy = null;
    action = null;
    await load();
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
      Sign in to the tools your local bots think with. Local bots and sessions use the Claude Code, Codex, or Grok CLI on this Mac; HQ can install the CLI and open the tool’s own sign-in. HQ sign-in is separate. Usage stays with the tool account — remaining quota is not shown here yet.
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
            >
              {busy === provider.id && action === "connect" ? "Connecting…" : `Connect ${provider.short}`}
            </button>
          {:else}
            <button
              type="button"
              class="ss-btn"
              disabled={Boolean(busy) || loading || !adapter?.sessions.installProvider}
              onclick={() => void install(provider.id)}
            >
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
</div>
