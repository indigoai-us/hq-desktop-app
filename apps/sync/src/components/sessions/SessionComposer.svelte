<script lang="ts">
  /**
   * The composer — one rounded bar that is also the whole setup screen.
   *
   * There is no "start a session" form anywhere in this surface: company,
   * model, effort and permission mode are PILLS on the bar itself, so the
   * first thing a user does is type, not fill in a wizard. Changing a pill
   * mid-session is legal — it simply describes the session the NEXT send will
   * belong to, and the bar says so rather than silently doing something else.
   *
   * Sending WHILE the agent is working is allowed on purpose — that is
   * steering, and the backend accepts a mid-turn user line. So `working` never
   * disables the textarea; it only turns the send arrow into Stop.
   *
   * All autocomplete decisions come from the pure helpers in
   * `./slash-commands`; this component owns only the DOM and the keyboard.
   */
  import { onMount } from 'svelte';
  import { filterSlashCommands, applySlashCommand } from './slash-commands';
  import type { SessionCommand } from './session-events';
  import type { ComposerImage, SessionModel } from './session-models';
  import { EFFORT_OPTIONS } from './session-models';

  interface CompanyOption {
    slug: string;
    displayName: string;
  }

  interface Props {
    /** Merged slash-command catalog (probe + the session's own `started` list). */
    commands?: SessionCommand[];
    /** True while the agent is mid-turn — turns Send into Stop, never disables input. */
    working?: boolean;
    /** True when nothing can be sent at all (no CLI, ended session). */
    disabled?: boolean;
    /** A blocking preflight problem with its exact remedy. One line, above the bar. */
    notice?: string;
    placeholder?: string;
    /** Take the caret on mount — the composer IS this page's primary control. */
    autofocus?: boolean;

    companies?: CompanyOption[];
    company?: string | null;
    models?: SessionModel[];
    /** The selected model's `value` (`null` = the CLI's own default). */
    model?: string | null;
    effort?: string | null;
    permissionMode?: 'prompt' | 'bypassAll';

    /** The pills now describe a DIFFERENT session than the live one. */
    newSessionPending?: boolean;

    /** Footer: the HQ folder's basename. */
    hqFolder?: string;
    /** Footer: a short form of the live session id. */
    sessionShort?: string;
    /** Footer: the last turn's cost, e.g. "2 in · 17 out · $0.68". */
    usageLabel?: string;

    onsend?: (text: string, images: ComposerImage[]) => void;
    onstop?: () => void;
    oncompany?: (slug: string | null) => void;
    onmodel?: (value: string | null) => void;
    oneffort?: (value: string | null) => void;
    onpermission?: (mode: 'prompt' | 'bypassAll') => void;
  }

  let {
    commands = [],
    working = false,
    disabled = false,
    notice = '',
    placeholder = 'Do anything…',
    autofocus = false,
    companies = [],
    company = null,
    models = [],
    model = null,
    effort = null,
    permissionMode = 'prompt',
    newSessionPending = false,
    hqFolder = '',
    sessionShort = '',
    usageLabel = '',
    onsend,
    onstop,
    oncompany,
    onmodel,
    oneffort,
    onpermission,
  }: Props = $props();

  let draft = $state('');
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let attached = $state<ComposerImage[]>([]);
  let attachError = $state('');
  let highlighted = $state(0);
  /** Dismissed with Escape; re-armed as soon as the draft changes. */
  let suppressed = $state(false);
  let lastDraft = $state('');

  const matches = $derived(suppressed ? [] : filterSlashCommands(draft, commands));
  const menuOpen = $derived(matches.length > 0);
  const safeIndex = $derived(
    matches.length === 0 ? 0 : Math.min(Math.max(highlighted, 0), matches.length - 1),
  );

  /**
   * A live session can report a model the catalog does not list (an older
   * session, a probe that failed). Carry it as its own option rather than
   * silently showing a different model's name on the pill.
   */
  const modelOptions = $derived(
    model !== null && !models.some((entry) => entry.value === model)
      ? [...models, { value: model, label: model }]
      : models,
  );
  const modelLabel = $derived(
    modelOptions.find((entry) => entry.value === model)?.label ??
      modelOptions[0]?.label ??
      'Default',
  );
  const effortLabel = $derived(
    EFFORT_OPTIONS.find((option) => option.value === effort)?.label ?? 'Auto',
  );
  const canSend = $derived(!disabled && draft.trim().length > 0);

  onMount(() => {
    if (autofocus) textarea?.focus();
    // Measure again once styles have certainly landed. The first pass can run
    // against an unstyled textarea — dev-mode CSS is injected asynchronously —
    // which reports a scrollHeight at the clamp and pins the bar open at its
    // maximum height on first paint.
    requestAnimationFrame(autosize);
  });

  /** Grow the textarea with its content, up to a bounded height. */
  const MAX_ROWS_PX = 200;

  function autosize() {
    const el = textarea;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }

  $effect(() => {
    // Touch `draft` so the effect re-runs on every keystroke.
    void draft;
    autosize();
  });

  // A changed draft re-arms a menu the user dismissed with Escape, and resets
  // the highlight to the best match.
  $effect(() => {
    if (draft === lastDraft) return;
    lastDraft = draft;
    suppressed = false;
    highlighted = 0;
  });

  function pick(command: SessionCommand) {
    draft = applySlashCommand(draft, command);
    suppressed = true;
    textarea?.focus();
  }

  function submit() {
    const text = draft.trim();
    if (!text || disabled) return;
    onsend?.(text, attached);
    draft = '';
    attached = [];
    attachError = '';
    suppressed = false;
  }

  function onKeydown(event: KeyboardEvent) {
    if (menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        highlighted = (safeIndex + 1) % matches.length;
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        highlighted = (safeIndex - 1 + matches.length) % matches.length;
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        const chosen = matches[safeIndex];
        if (chosen) pick(chosen);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        suppressed = true;
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  /** Images ride the turn as raw base64 — the backend adds no data-URL prefix. */
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

  function readImage(file: File): Promise<ComposerImage> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const comma = result.indexOf(',');
        if (comma === -1) {
          reject(new Error(`Could not read ${file.name}`));
          return;
        }
        resolve({
          mediaType: file.type || 'image/png',
          base64: result.slice(comma + 1),
          name: file.name,
        });
      };
      reader.readAsDataURL(file);
    });
  }

  async function onFiles(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0) return;
    attachError = '';
    const next: ComposerImage[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        attachError = 'Only images can be attached.';
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        attachError = `${file.name} is too large (max 4 MB).`;
        continue;
      }
      try {
        next.push(await readImage(file));
      } catch (err) {
        attachError = err instanceof Error ? err.message : String(err);
      }
    }
    if (next.length > 0) attached = [...attached, ...next];
  }

  function removeImage(name: string) {
    attached = attached.filter((image) => image.name !== name);
  }
</script>

<div class="composer" data-testid="session-composer">
  {#if notice}
    <p class="composer-notice" role="alert" data-testid="session-composer-notice">{notice}</p>
  {/if}

  {#if menuOpen}
    <ul
      class="slash-menu"
      role="listbox"
      aria-label="Slash commands"
      data-testid="session-slash-menu"
    >
      {#each matches as command, index (command.name)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={index === safeIndex}
            class="slash-item"
            class:highlighted={index === safeIndex}
            data-testid="session-slash-item"
            onmouseenter={() => (highlighted = index)}
            onclick={() => pick(command)}
          >
            <span class="slash-name">/{command.name}</span>
            {#if command.argumentHint}
              <span class="slash-args">{command.argumentHint}</span>
            {/if}
            {#if command.description}
              <span class="slash-description">{command.description}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="bar">
    {#if attached.length > 0}
      <ul class="attachments" data-testid="session-composer-attachments">
        {#each attached as image (image.name)}
          <li>
            <button
              type="button"
              class="attachment"
              title={`Remove ${image.name}`}
              onclick={() => removeImage(image.name)}
            >
              {image.name} ✕
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="bar-main">
      <button
        type="button"
        class="icon-button attach"
        aria-label="Attach an image"
        data-testid="session-composer-attach"
        onclick={() => fileInput?.click()}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M10.6 4.2 5.5 9.3a1.7 1.7 0 0 0 2.4 2.4l5.1-5.1a3.1 3.1 0 0 0-4.4-4.4L3.3 7.5a4.5 4.5 0 0 0 6.4 6.4l4.1-4.1"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <input
        bind:this={fileInput}
        class="file-input"
        type="file"
        accept="image/*"
        multiple
        data-testid="session-composer-file"
        onchange={onFiles}
      />

      <textarea
        bind:this={textarea}
        bind:value={draft}
        class="composer-input"
        rows="1"
        {placeholder}
        aria-label="Message the agent"
        data-testid="session-composer-input"
        onkeydown={onKeydown}
      ></textarea>

      <div class="pills">
        {#if companies.length > 0}
          <label class="pill" data-testid="session-pill-company">
            <span class="sr-only">Company</span>
            <select
              value={company ?? ''}
              onchange={(event) => oncompany?.(event.currentTarget.value || null)}
            >
              {#each companies as option (option.slug)}
                <option value={option.slug}>{option.displayName}</option>
              {/each}
            </select>
            <span class="pill-face">{
              companies.find((c) => c.slug === company)?.displayName ?? 'Company'
            }</span>
          </label>
        {/if}

        <label class="pill" data-testid="session-pill-model">
          <span class="sr-only">Model</span>
          <select
            value={model ?? ''}
            onchange={(event) => onmodel?.(event.currentTarget.value || null)}
          >
            {#each modelOptions as option (option.value ?? '@default')}
              <option value={option.value ?? ''}>{option.label}</option>
            {/each}
          </select>
          <span class="pill-face">{modelLabel}</span>
        </label>

        <label class="pill" data-testid="session-pill-effort">
          <span class="sr-only">Effort</span>
          <select
            value={effort ?? ''}
            onchange={(event) => oneffort?.(event.currentTarget.value || null)}
          >
            {#each EFFORT_OPTIONS as option (option.value ?? '@auto')}
              <option value={option.value ?? ''}>{option.label}</option>
            {/each}
          </select>
          <span class="pill-face">{effortLabel}</span>
        </label>

        <label class="pill subtle" data-testid="session-pill-permission">
          <span class="sr-only">Permission mode</span>
          <select
            value={permissionMode}
            onchange={(event) =>
              onpermission?.(event.currentTarget.value === 'bypassAll' ? 'bypassAll' : 'prompt')}
          >
            <option value="prompt">Prompt</option>
            <option value="bypassAll">Bypass</option>
          </select>
          <span class="pill-face">{permissionMode === 'bypassAll' ? 'Bypass' : 'Prompt'}</span>
        </label>
      </div>

      {#if working}
        <button
          type="button"
          class="go stop"
          aria-label="Stop"
          data-testid="session-composer-stop"
          onclick={() => onstop?.()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1.5" y="1.5" width="7" height="7" rx="1.4" fill="currentColor" />
          </svg>
        </button>
      {:else}
        <button
          type="button"
          class="go"
          aria-label="Send"
          disabled={!canSend}
          data-testid="session-composer-send"
          onclick={submit}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M7 11.5v-9M3.2 6.3 7 2.5l3.8 3.8"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      {/if}
    </div>
  </div>

  <div class="footer">
    {#if hqFolder}
      <span class="foot-pill" data-testid="session-foot-folder">{hqFolder}</span>
    {/if}
    {#if sessionShort}
      <span class="foot-pill" data-testid="session-foot-id">{sessionShort}</span>
    {/if}
    {#if usageLabel}
      <span class="foot-pill usage" data-testid="session-foot-usage">{usageLabel}</span>
    {/if}
    {#if newSessionPending}
      <span class="foot-note" data-testid="session-new-session-hint">
        Next message starts a new session
      </span>
    {:else if working}
      <span class="foot-note" data-testid="session-composer-steer-hint">
        Sending now steers the turn in progress
      </span>
    {/if}
    {#if attachError}
      <span class="foot-note error" data-testid="session-attach-error">{attachError}</span>
    {/if}
  </div>
</div>

<style>
  .composer {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    font-family: var(--font-sans);
  }

  .composer-notice {
    margin: 0;
    padding: 6px 10px;
    border-radius: var(--v4-radius-button);
    background: color-mix(in srgb, var(--v4-warn, currentColor) 10%, transparent);
    color: var(--v4-text-2);
    font-size: var(--type-metadata);
    line-height: 1.5;
  }

  /* --- the bar ---------------------------------------------------------- */

  .bar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: 20px;
    background: var(--v4-raised);
  }

  .bar:focus-within {
    border-color: var(--v4-control-border, var(--v4-hairline));
  }

  .bar-main {
    display: flex;
    align-items: flex-end;
    gap: 6px;
  }

  .composer-input {
    flex: 1;
    min-width: 0;
    max-height: 200px;
    padding: 6px 2px;
    resize: none;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-body);
    line-height: 1.45;
  }

  .composer-input::placeholder {
    color: var(--v4-text-3);
  }

  .file-input {
    display: none;
  }

  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--v4-text-3);
    cursor: pointer;
  }

  .icon-button:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  /* --- pills ------------------------------------------------------------ */

  .pills {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }

  .pill {
    position: relative;
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 8px;
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-2);
    font-size: var(--type-metadata);
    cursor: pointer;
  }

  .pill:hover {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .pill.subtle {
    color: var(--v4-text-3);
  }

  .pill select {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    border: 0;
    cursor: pointer;
    font: inherit;
  }

  .pill-face {
    pointer-events: none;
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* --- send / stop ------------------------------------------------------ */

  .go {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 50%;
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    cursor: pointer;
  }

  .go:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .go.stop {
    background: var(--v4-control-faint, var(--v4-active-row));
    color: var(--v4-text-1);
  }

  /* --- attachments ------------------------------------------------------ */

  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    padding: 0 0 0 32px;
    list-style: none;
  }

  .attachment {
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: transparent;
    color: var(--v4-text-3);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    cursor: pointer;
  }

  /* --- footer ----------------------------------------------------------- */

  .footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 0 12px;
    min-height: 14px;
  }

  .foot-pill,
  .foot-note {
    font-size: 11px;
    line-height: 14px;
    color: var(--v4-text-3);
  }

  .foot-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono, ui-monospace, monospace);
    opacity: 0.85;
  }

  .foot-note.error {
    color: var(--v4-error, var(--v4-text-2));
  }

  /* --- slash autocomplete ----------------------------------------------- */

  .slash-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    right: 0;
    z-index: 5;
    max-height: 240px;
    overflow-y: auto;
    margin: 0;
    padding: 4px;
    list-style: none;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card);
    background: var(--v4-popover-strong, var(--v4-popover, var(--v4-raised)));
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    box-shadow: var(--v4-shadow-popover, none);
  }

  .slash-item {
    display: flex;
    align-items: baseline;
    gap: var(--v4-space-2);
    width: 100%;
    padding: 5px var(--v4-space-2);
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-metadata);
    text-align: left;
    cursor: pointer;
  }

  .slash-item.highlighted {
    background: var(--v4-active-row);
  }

  .slash-name {
    font-family: var(--font-mono, ui-monospace, monospace);
    flex: none;
  }

  .slash-args {
    color: var(--v4-text-3);
    flex: none;
  }

  .slash-description {
    color: var(--v4-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
