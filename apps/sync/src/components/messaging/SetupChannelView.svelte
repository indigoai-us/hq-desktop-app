<script lang="ts">
  // Synthetic #setup support pane: pinned welcome sequence + launch actions +
  // a live thread that sends through the normal channel pipeline with
  // channelId "setup". Fetch/send tolerate a channel that does not exist
  // server-side yet (empty history, no error). Launch paths REUSE the
  // installer/desktop card commands — do not invent new ones.
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import { safeHref } from '../../lib/markdown';
  import type { AiTools } from '../../lib/onboarding-summary';
  import {
    SETUP_CHANNEL_ID,
    SETUP_LAUNCH_COMMANDS,
    SETUP_WELCOME_MESSAGES,
  } from '../../lib/setup-channel';
  import {
    resolveClaudeLaunchPath,
    resolveCodexLaunchPath,
    SETUP_PROMPT,
  } from '../../desktop-alt/lib/setup-launch';
  import Conversation, { type ConversationMessage } from './Conversation.svelte';

  interface Props {
    hqFolderPath: string;
  }

  let { hqFolderPath }: Props = $props();

  interface SetupMessageRow extends ConversationMessage {
    fromEmail?: string;
  }

  interface ChannelDetail {
    messages?: SetupMessageRow[];
  }

  type LaunchKey = 'claude' | 'codex' | 'grok';

  let messages = $state<SetupMessageRow[]>([]);
  let sending = $state(false);
  let sendError = $state<string | null>(null);
  let localEchoSeq = 0;

  let aiTools = $state<AiTools | null>(null);
  let launching = $state<LaunchKey | null>(null);
  let opened = $state<Partial<Record<LaunchKey, boolean>>>({});
  let launchErrors = $state<Partial<Record<LaunchKey, string>>>({});
  let openedTimers: Partial<Record<LaunchKey, ReturnType<typeof setTimeout>>> = {};

  const canLaunch = $derived(hqFolderPath.trim().length > 0);

  async function ensureAiTools(): Promise<AiTools | null> {
    if (aiTools) return aiTools;
    try {
      aiTools = await invoke<AiTools>('detect_ai_tools');
    } catch {
      aiTools = null;
    }
    return aiTools;
  }

  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function setLaunchError(key: LaunchKey, message: string | null): void {
    launchErrors = { ...launchErrors, [key]: message ?? undefined };
  }

  function markOpened(key: LaunchKey): void {
    opened = { ...opened, [key]: true };
    if (openedTimers[key]) clearTimeout(openedTimers[key]);
    openedTimers[key] = setTimeout(() => {
      opened = { ...opened, [key]: false };
    }, 1800);
  }

  function launchLabel(key: LaunchKey, idle: string): string {
    if (launching === key) return 'Opening…';
    if (opened[key]) return 'Opened';
    return idle;
  }

  async function launchClaude(): Promise<void> {
    if (!canLaunch || launching) return;
    setLaunchError('claude', null);
    launching = 'claude';
    try {
      const path = resolveClaudeLaunchPath(await ensureAiTools());
      if (path === 'deep-link') {
        await invoke('open_claude_code_link', {
          url: buildClaudeCodeUrl({
            folder: hqFolderPath,
            prompt: SETUP_LAUNCH_COMMANDS.claude.prompt,
          }),
        });
        markOpened('claude');
      } else if (path === 'cli') {
        await invoke('launch_claude_code', { path: hqFolderPath });
        markOpened('claude');
      } else {
        let copied = false;
        try {
          await navigator.clipboard.writeText(SETUP_PROMPT);
          copied = true;
        } catch {
          copied = false;
        }
        setLaunchError(
          'claude',
          copied
            ? 'Claude Code was not detected. Open your HQ folder in Claude Code and run /setup — the prompt was copied to your clipboard.'
            : 'Claude Code was not detected. Open your HQ folder in Claude Code and run /setup.',
        );
      }
    } catch (err) {
      setLaunchError('claude', `Could not open Claude Code: ${errorMessage(err)}`);
    } finally {
      launching = null;
    }
  }

  async function launchCodex(): Promise<void> {
    if (!canLaunch || launching) return;
    setLaunchError('codex', null);
    launching = 'codex';
    try {
      const tools = await ensureAiTools();
      const path = resolveCodexLaunchPath(tools);
      // Cascade: ChatGPT desktop app's Codex surface (workspace + /setup
      // pre-typed via launch_codex_workspace) → codex CLI in a terminal →
      // clipboard copy of the prompt as last resort.
      if (path === 'desktop') {
        try {
          await invoke('launch_codex_workspace', {
            path: hqFolderPath,
            prompt: SETUP_LAUNCH_COMMANDS.codex.prompt,
          });
          markOpened('codex');
          return;
        } catch (err) {
          if (!tools?.codex_cli) {
            setLaunchError('codex', `Could not open Codex: ${errorMessage(err)}`);
            return;
          }
          // Fall through to the terminal CLI.
        }
      }
      if (path !== 'none') {
        await invoke('launch_cli_in_terminal', {
          path: hqFolderPath,
          tool: SETUP_LAUNCH_COMMANDS.codex.kind,
        });
        markOpened('codex');
        return;
      }
      let copied = false;
      try {
        await navigator.clipboard.writeText(SETUP_PROMPT);
        copied = true;
      } catch {
        copied = false;
      }
      setLaunchError(
        'codex',
        copied
          ? "Codex was not detected. Open your HQ folder in the ChatGPT app's Codex tab (or the codex CLI) and run /setup — the prompt was copied to your clipboard."
          : "Codex was not detected. Open your HQ folder in the ChatGPT app's Codex tab (or the codex CLI) and run /setup.",
      );
    } catch (err) {
      setLaunchError('codex', `Could not open Codex: ${errorMessage(err)}`);
    } finally {
      launching = null;
    }
  }

  async function launchGrok(): Promise<void> {
    if (!canLaunch || launching) return;
    setLaunchError('grok', null);
    launching = 'grok';
    try {
      await invoke('launch_cli_in_terminal', {
        path: hqFolderPath,
        tool: SETUP_LAUNCH_COMMANDS.grok.tool,
      });
      markOpened('grok');
    } catch (err) {
      setLaunchError('grok', `Could not open Grok Build: ${errorMessage(err)}`);
    } finally {
      launching = null;
    }
  }

  async function openResourceLink(event: MouseEvent, href: string): Promise<void> {
    event.preventDefault();
    const safe = safeHref(href);
    if (!safe || !/^https?:/i.test(safe)) return;
    try {
      await openExternal(safe);
    } catch {
      window.open(safe, '_blank', 'noopener,noreferrer');
    }
  }

  async function loadMessages(): Promise<SetupMessageRow[] | null> {
    try {
      const detail = await invoke<ChannelDetail>('fetch_channel', {
        channelId: SETUP_CHANNEL_ID,
      });
      return [...(detail.messages ?? [])].reverse();
    } catch {
      // Synthetic channel may not exist server-side yet.
      return null;
    }
  }

  function localEcho(text: string): SetupMessageRow {
    localEchoSeq += 1;
    return {
      eventId: `local-setup-${localEchoSeq}`,
      fromPersonUid: 'me',
      fromEmail: '',
      fromDisplayName: 'You',
      body: text,
      details: null,
      prompt: null,
      createdAt: new Date().toISOString(),
      direction: 'out',
    };
  }

  async function send(text: string): Promise<void> {
    if (!text || sending) return;
    sending = true;
    sendError = null;
    try {
      await invoke('send_channel_message', {
        channelId: SETUP_CHANNEL_ID,
        body: text,
      });
      const priorIds = new Set(messages.map((m) => m.eventId));
      const fetched = await loadMessages();
      if (fetched) {
        const found = fetched.some((m) => m.body === text && !priorIds.has(m.eventId));
        messages = found ? fetched : [...fetched, localEcho(text)];
      } else {
        messages = [...messages, localEcho(text)];
      }
    } catch (err) {
      sendError = typeof err === 'string' ? err : 'Failed to send message';
      console.error('setup-channel: send_channel_message failed', err);
    } finally {
      sending = false;
    }
  }

  onMount(() => {
    void (async () => {
      const fetched = await loadMessages();
      if (fetched) messages = fetched;
    })();
    return () => {
      for (const timer of Object.values(openedTimers)) {
        if (timer) clearTimeout(timer);
      }
    };
  });
</script>

<div class="setup-view">
  <header class="channel-header" data-tauri-drag-region>
    <div class="channel-title">
      <span class="channel-hash" aria-hidden="true">#</span>
      <h2>setup</h2>
      <span class="scope-chip" title="Getting started">Getting started</span>
    </div>
  </header>

  <section class="setup-intro" aria-label="Getting started with HQ Desktop">
    <div class="welcome-list">
      {#each SETUP_WELCOME_MESSAGES as message (message.id)}
        <article class="welcome-card" data-welcome-id={message.id}>
          <span class="welcome-author">HQ</span>
          <div class="welcome-bubble">
            {#if message.title}
              <h3 class="welcome-title">{message.title}</h3>
            {/if}
            <p class="welcome-body">{message.body}</p>
            {#if message.links?.length}
              <ul class="welcome-links">
                {#each message.links as link (link.href)}
                  <li>
                    <a
                      class="welcome-link"
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onclick={(event) => void openResourceLink(event, link.href)}
                    >
                      {link.label}
                    </a>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        </article>
      {/each}
    </div>

    <div class="setup-actions">
      <div class="setup-action">
        <button
          type="button"
          class="launch-btn primary"
          disabled={!canLaunch || launching !== null}
          aria-busy={launching === 'claude'}
          onclick={() => void launchClaude()}
        >
          {launchLabel('claude', 'Open setup in Claude Code')}
        </button>
        {#if launchErrors.claude}
          <p class="launch-error" role="alert">{launchErrors.claude}</p>
        {/if}
      </div>
      <div class="setup-action">
        <button
          type="button"
          class="launch-btn secondary"
          disabled={!canLaunch || launching !== null}
          aria-busy={launching === 'codex'}
          onclick={() => void launchCodex()}
        >
          {launchLabel('codex', 'Open setup in Codex')}
        </button>
        {#if launchErrors.codex}
          <p class="launch-error" role="alert">{launchErrors.codex}</p>
        {/if}
      </div>
      <div class="setup-action">
        <button
          type="button"
          class="launch-btn secondary"
          disabled={!canLaunch || launching !== null}
          aria-busy={launching === 'grok'}
          onclick={() => void launchGrok()}
        >
          {launchLabel('grok', 'Open setup in Grok Build (terminal)')}
        </button>
        {#if launchErrors.grok}
          <p class="launch-error" role="alert">{launchErrors.grok}</p>
        {/if}
      </div>
    </div>
  </section>

  <Conversation
    {messages}
    showAuthors={true}
    loading={false}
    error={null}
    {sending}
    {sendError}
    placeholder="Message #setup — ask the HQ team anything…"
    onsend={send}
  />
</div>

<style>
  .setup-view {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .channel-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--border, var(--pop-divider));
    flex-shrink: 0;
  }

  .channel-title {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    min-width: 0;
  }

  .channel-hash {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--muted, var(--pop-muted));
  }

  .channel-title h2 {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--fg, var(--pop-text));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scope-chip {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    font-size: var(--text-base);
    font-weight: 560;
    letter-spacing: 0.02em;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--muted-2, var(--pop-muted));
  }

  .setup-intro {
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 1.25rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    border-bottom: 1px solid var(--border, var(--pop-divider));
  }

  .welcome-list {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.625rem;
  }

  .welcome-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    max-width: min(80%, 420px);
  }

  .welcome-author {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--pop-muted);
    margin: 0 0.25rem 0.125rem;
  }

  .welcome-bubble {
    padding: 0.5rem 0.75rem;
    border-radius: 16px;
    border-bottom-left-radius: 4px;
    background: var(--pop-hover);
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .welcome-title {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--fg, var(--pop-text));
  }

  .welcome-body {
    margin: 0;
    font-size: var(--text-base);
    line-height: 1.55;
    color: var(--fg, var(--pop-text));
  }

  .welcome-links {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .welcome-link {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--fg, var(--pop-text));
    text-decoration: underline;
    text-underline-offset: 0.125rem;
  }

  .welcome-link:hover {
    color: var(--pop-muted);
  }

  .setup-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .setup-action {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-width: 100%;
  }

  .launch-btn {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    padding: 0.4375rem 0.875rem;
    border: 1px solid transparent;
    border-radius: var(--radius-button, 7px);
    font-size: var(--text-base);
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
    transition:
      background-color 0.12s ease,
      filter 0.12s ease,
      transform 120ms var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1));
  }

  .launch-btn.primary {
    background: var(--accent, var(--c-btn-bg));
    color: var(--accent-fg, var(--c-btn-fg));
  }

  .launch-btn.secondary {
    background: var(--c-btn2-bg);
    color: var(--c-btn2-fg);
    border-color: var(--c-field-border);
  }

  .launch-btn.primary:hover:not(:disabled) {
    filter: brightness(0.94);
  }

  .launch-btn.secondary:hover:not(:disabled) {
    background: var(--pop-hover);
  }

  .launch-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .launch-btn:active:not(:disabled) {
    transform: scale(0.97);
  }

  .launch-btn:focus-visible {
    outline: 2px solid var(--pop-text);
    outline-offset: 2px;
  }

  .launch-error {
    margin: 0;
    max-width: 22rem;
    font-size: var(--text-base);
    line-height: 1.4;
    color: var(--red, var(--popover-danger));
  }

  @media (prefers-reduced-motion: reduce) {
    .launch-btn {
      transition: none;
    }

    .launch-btn:active:not(:disabled) {
      transform: none;
    }
  }
</style>
