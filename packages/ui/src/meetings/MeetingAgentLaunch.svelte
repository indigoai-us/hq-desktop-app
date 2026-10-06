<script lang="ts">
  import { onMount } from "svelte";
  import { createLaunchActions, type LaunchKey } from "../settings/launch-actions";
  import { meetingAgentLaunchServices } from "./meetings-store.svelte";
  import { meetingAgentPrompt, readMeetingAgentProvider, rememberMeetingAgentProvider } from "./meeting-agent-prompt";

  interface Props { title?: string | null; companyUid: string; recallBotId: string; startTime?: string | null; }
  let { title = null, companyUid, recallBotId, startTime = null }: Props = $props();
  let provider = $state<LaunchKey>(readMeetingAgentProvider());
  let pending = $state<LaunchKey | null>(null);
  let message = $state<string | null>(null);
  let installed = $state<Partial<Record<LaunchKey, boolean>> | null>(null);
  const label = $derived(provider === "codex" ? "Open in Codex" : "Open in Claude Code");
  const providerInstalled = $derived(installed === null || installed[provider] !== false);

  onMount(() => {
    const services = meetingAgentLaunchServices();
    if (!services) return;
    void services.shell.detectAiTools().then((result) => {
      if (!result.ok || !result.value || typeof result.value !== "object") return;
      const tools = result.value as { claude_cli?: boolean; claude_desktop?: boolean; codex_cli?: boolean; codex_desktop?: boolean };
      installed = { claude: Boolean(tools.claude_cli || tools.claude_desktop), codex: Boolean(tools.codex_cli || tools.codex_desktop) };
      if (installed[provider] === false && installed[provider === "claude" ? "codex" : "claude"]) provider = provider === "claude" ? "codex" : "claude";
    }).catch(() => { /* Unknown stays available so a transient probe never blocks launch. */ });
  });

  async function launch(next: LaunchKey): Promise<void> {
    if (pending || (next !== "claude" && next !== "codex")) return;
    const services = meetingAgentLaunchServices();
    if (!services) { message = "Opening an agent is unavailable in this view."; return; }
    pending = next; message = null; provider = next; rememberMeetingAgentProvider(next);
    try {
      const status = await services.getSetupStatus();
      const folder = status.ok && status.value && typeof status.value === "object"
        ? String((status.value as { hqFolderPath?: unknown }).hqFolderPath ?? "").trim() : "";
      if (!folder) { message = "HQ folder not configured yet. Finish setup first."; return; }
      const actions = createLaunchActions({ shell: services.shell, hqFolderPath: folder, prompt: meetingAgentPrompt({ title, companyUid, recallBotId, startTime }) });
      message = next === "claude" ? await actions.launchClaude() : await actions.launchCodex();
    } finally { pending = null; }
  }

  async function copyPrompt(): Promise<void> {
    try { await navigator.clipboard.writeText(meetingAgentPrompt({ title, companyUid, recallBotId, startTime })); message = "Meeting prompt copied."; }
    catch { message = "Could not copy the meeting prompt."; }
  }
</script>

<div class="agent-launch" data-testid="meeting-agent-launch">
  <button type="button" class="open" disabled={pending !== null || !providerInstalled} aria-busy={pending === provider} onclick={() => void launch(provider)}>{pending === provider ? "Opening…" : label}</button>
  <select aria-label="Choose agent" disabled={pending !== null} value={provider} onchange={(event) => void launch((event.currentTarget as HTMLSelectElement).value as LaunchKey)}>
    <option value="claude" disabled={installed?.claude === false}>Claude Code</option><option value="codex" disabled={installed?.codex === false}>Codex</option>
  </select>
  {#if message}<div class="message" role="status">{message} {#if message.includes("prompt")}<button type="button" onclick={() => void copyPrompt()}>Copy prompt</button>{/if}</div>{/if}
</div>

<style>
  .agent-launch { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .open, select, .message button { border: 1px solid var(--line2); background: var(--surface); color: var(--t1); border-radius: 6px; font: inherit; font-size: 13px; min-height: 28px; padding: 3px 8px; }
  .open { cursor: pointer; } .open:disabled, select:disabled { opacity: .6; cursor: default; }
  .message { flex-basis: 100%; color: var(--t2); font-size: 13px; } .message button { min-height: 24px; margin-left: 6px; cursor: pointer; }
</style>
