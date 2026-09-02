<script lang="ts">
  /**
   * The composer — one rounded box that is also the whole setup screen.
   *
   * TWO ROWS, like the Claude Code desktop composer: the text on top, every
   * control on a single baseline underneath it. Nothing sits beside the
   * textarea, because a control parked next to the caret is a control the eye
   * has to step over on the way to the next word.
   *
   * There is no "start a session" form anywhere in this surface: tool,
   * company, model, effort and permission mode are PILLS on the bottom row, so
   * the first thing a user does is type, not fill in a wizard. Changing a pill
   * mid-session is legal — it simply describes the session the NEXT send will
   * belong to, and the bar says so rather than silently doing something else.
   *
   * Sending WHILE the agent is working is allowed on purpose — that is
   * steering, and the backend accepts a mid-turn user line. So `working` never
   * disables the textarea; it only turns the send arrow into a stop.
   *
   * The menus are absolutely positioned against their own pill INSIDE this
   * box, never portalled and never rendered in the transcript's scroll
   * container — a popover that opens upward out of a scrolling ancestor is a
   * popover with its top sliced off.
   *
   * All autocomplete decisions come from the pure helpers in
   * `./slash-commands` and `./mentions`, and every model name comes from
   * `./session-models`; this component owns only the DOM and the keyboard.
   *
   * `@`-mentions: an `@` at a word start opens `MentionPicker` over the same
   * slot the slash menu uses (the two never show together — a mention token
   * under the caret wins). Picking inserts `@Display Name` AND keeps a chip
   * under the textarea that says who will be DMed; the chip has an × and a
   * mention whose text was deleted loses its chip, so nothing is ever DMed
   * that the user cannot see promised right under their draft.
   */
  import { onMount, tick } from 'svelte';
  import MentionPicker from './MentionPicker.svelte';
  import {
    addMention,
    applyMention,
    filterMentionCandidates,
    mentionQueryAt,
    pruneMentions,
    removeMention,
    type Mention,
    type MentionCandidate,
  } from './mentions';
  import { filterSlashCommands, applySlashCommand } from './slash-commands';
  import type { SessionCommand } from './session-events';
  import type { ComposerImage, SessionModel, SessionToolId } from './session-models';
  import {
    EFFORT_OPTIONS,
    TOOL_OPTIONS,
    firstSentence,
    modelMenuRows,
    modelPillLabel,
  } from './session-models';

  interface CompanyOption {
    slug: string;
    displayName: string;
  }

  /** Which pill's popover is open. One at a time — they share the same row. */
  type MenuName = 'permission' | 'company' | 'tool' | 'model' | 'effort';

  interface Props {
    /** Merged slash-command catalog (probe + the session's own `started` list). */
    commands?: SessionCommand[];
    /** True while the agent is mid-turn — turns Send into Stop, never disables input. */
    working?: boolean;
    /** True when nothing can be sent at all (no CLI, ended session). */
    disabled?: boolean;
    /** A blocking preflight problem with its exact remedy. One line, above the box. */
    notice?: string;
    placeholder?: string;
    /** Take the caret on mount — the composer IS this page's primary control. */
    autofocus?: boolean;

    companies?: CompanyOption[];
    company?: string | null;
    models?: SessionModel[];
    /** The selected model's `value` (`null` = the CLI's own default). */
    model?: string | null;
    /** The model the live session actually resolved, from `started`. */
    resolvedModel?: string | null;
    effort?: string | null;
    permissionMode?: 'prompt' | 'bypassAll';
    tool?: SessionToolId;
    /** Preflight says the Codex CLI is on this machine. */
    codexAvailable?: boolean;

    /** The COMPANY pill now describes a different session than the live one. */
    newSessionPending?: boolean;
    /**
     * The model / effort pills moved on a CLI that cannot be rebound
     * mid-session (Claude), so the choice lands on the next session rather
     * than on the next turn. Codex takes both per turn and never sets this.
     */
    overridesDeferred?: boolean;

    /** Footer: the HQ folder's basename. The whole footer. */
    hqFolder?: string;

    /** Who `@` can mention in the session's company (people + fleet agents). */
    mentionCandidates?: MentionCandidate[];
    /** The last mention fan-out's outcome, e.g. "DM'd Corey Epstein". */
    mentionStatus?: { text: string; error: boolean } | null;

    /** `mentions` are the chips still showing at send time — the DM list. */
    onsend?: (text: string, images: ComposerImage[], mentions: Mention[]) => void;
    onstop?: () => void;
    oncompany?: (slug: string | null) => void;
    onmodel?: (value: string | null) => void;
    oneffort?: (value: string | null) => void;
    onpermission?: (mode: 'prompt' | 'bypassAll') => void;
    ontool?: (tool: SessionToolId) => void;
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
    resolvedModel = null,
    effort = null,
    permissionMode = 'prompt',
    tool = 'claude',
    codexAvailable = false,
    newSessionPending = false,
    overridesDeferred = false,
    hqFolder = '',
    mentionCandidates = [],
    mentionStatus = null,
    onsend,
    onstop,
    oncompany,
    onmodel,
    oneffort,
    onpermission,
    ontool,
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
  let openMenu = $state<MenuName | null>(null);

  // --- @mentions ------------------------------------------------------------
  /** Where the caret is, mirrored from the textarea on every edit/move. */
  let caret = $state(0);
  /** Every mention picked so far; `chips` is the subset the draft still names. */
  let mentions = $state<Mention[]>([]);
  let mentionHighlighted = $state(0);
  /** Dismissed with Escape; re-armed as soon as the draft changes. */
  let mentionSuppressed = $state(false);

  const mentionQuery = $derived(mentionSuppressed ? null : mentionQueryAt(draft, caret));
  const mentionMatches = $derived(
    mentionQuery ? filterMentionCandidates(mentionCandidates, mentionQuery.query) : [],
  );
  const mentionOpen = $derived(mentionQuery !== null && mentionMatches.length > 0);
  const mentionIndex = $derived(
    mentionMatches.length === 0
      ? 0
      : Math.min(Math.max(mentionHighlighted, 0), mentionMatches.length - 1),
  );
  const chips = $derived(pruneMentions(mentions, draft));

  const matches = $derived(suppressed ? [] : filterSlashCommands(draft, commands));
  // A mention token under the caret takes the slot; the slash menu yields.
  const menuOpen = $derived(!mentionOpen && matches.length > 0);
  const safeIndex = $derived(
    matches.length === 0 ? 0 : Math.min(Math.max(highlighted, 0), matches.length - 1),
  );

  /**
   * A live session can report a model the catalog does not list (an older
   * session, a probe that failed). Carry it as its own option rather than
   * silently offering a menu the current selection is missing from.
   */
  const pickable = $derived.by(() => {
    // Already deduped by id and disambiguated where two ids share a name — the
    // Codex catalog ships several models per version and used to render three
    // identical "GPT 5.6" rows.
    const offered = modelMenuRows(models, tool);
    if (model !== null && !offered.some((entry) => entry.value === model)) {
      return [...offered, { value: model, label: model } satisfies SessionModel];
    }
    return offered;
  });

  const modelLabel = $derived(modelPillLabel(models, model, resolvedModel, tool));
  const effortLabel = $derived(
    EFFORT_OPTIONS.find((option) => option.value === effort)?.label ?? 'Auto',
  );
  const companyLabel = $derived(
    companies.find((option) => option.slug === company)?.displayName ?? company ?? 'Company',
  );
  const permissionLabel = $derived(
    permissionMode === 'bypassAll' ? 'Bypass permissions' : 'Prompt for permissions',
  );
  const toolOption = $derived(
    TOOL_OPTIONS.find((option) => option.value === tool) ?? TOOL_OPTIONS[0],
  );
  const canSend = $derived(!disabled && draft.trim().length > 0);

  onMount(() => {
    if (autofocus) textarea?.focus();
    // Measure again once styles have certainly landed. The first pass can run
    // against an unstyled textarea — dev-mode CSS is injected asynchronously —
    // which reports a scrollHeight at the clamp and pins the box open at its
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
    mentionSuppressed = false;
    mentionHighlighted = 0;
  });

  /** Mirror the textarea's caret so the `@` query follows the cursor. */
  function syncCaret() {
    const el = textarea;
    if (!el) return;
    const at = el.selectionStart;
    caret = typeof at === 'number' ? at : draft.length;
  }

  async function pickMention(candidate: MentionCandidate) {
    const query = mentionQuery;
    if (!query) return;
    const next = applyMention(draft, query, candidate);
    draft = next.draft;
    mentions = addMention(mentions, candidate);
    mentionSuppressed = true;
    caret = next.caret;
    await tick();
    const el = textarea;
    if (el) {
      if (typeof el.setSelectionRange === 'function') el.setSelectionRange(next.caret, next.caret);
      el.focus();
    }
  }

  function dropMention(uid: string) {
    mentions = removeMention(mentions, uid);
    textarea?.focus();
  }

  function toggleMenu(name: MenuName, event: MouseEvent) {
    // Without this the window listener below would close the menu the same
    // click just opened.
    event.stopPropagation();
    openMenu = openMenu === name ? null : name;
  }

  function closeMenus() {
    openMenu = null;
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && openMenu !== null) {
      openMenu = null;
      textarea?.focus();
    }
  }

  function pick(command: SessionCommand) {
    draft = applySlashCommand(draft, command);
    suppressed = true;
    textarea?.focus();
  }

  function submit() {
    const text = draft.trim();
    if (!text || disabled) return;
    onsend?.(text, attached, chips);
    draft = '';
    attached = [];
    attachError = '';
    suppressed = false;
    mentions = [];
    mentionSuppressed = false;
    caret = 0;
  }

  function onKeydown(event: KeyboardEvent) {
    if (mentionOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        mentionHighlighted = (mentionIndex + 1) % mentionMatches.length;
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        mentionHighlighted = (mentionIndex - 1 + mentionMatches.length) % mentionMatches.length;
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        const chosen = mentionMatches[mentionIndex];
        if (chosen) void pickMention(chosen);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        mentionSuppressed = true;
        return;
      }
    }

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

<svelte:window onclick={closeMenus} onkeydown={onWindowKeydown} />

<div class="composer" data-testid="session-composer">
  {#if notice}
    <p class="composer-notice" role="alert" data-testid="session-composer-notice">{notice}</p>
  {/if}

  {#if mentionOpen}
    <MentionPicker
      candidates={mentionMatches}
      highlighted={mentionIndex}
      onpick={(candidate) => void pickMention(candidate)}
      onhover={(index) => (mentionHighlighted = index)}
    />
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

  <div class="box">
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

    <div class="text-row">
      <textarea
        bind:this={textarea}
        bind:value={draft}
        class="composer-input"
        rows="1"
        {placeholder}
        aria-label="Message the agent"
        data-testid="session-composer-input"
        onkeydown={onKeydown}
        onkeyup={syncCaret}
        oninput={syncCaret}
        onclick={syncCaret}
        onselect={syncCaret}
      ></textarea>
      {#if canSend && !working}
        <span class="enter-hint" aria-hidden="true">⏎</span>
      {/if}
    </div>

    {#if chips.length > 0}
      <div class="mention-chips" data-testid="session-mention-chips">
        <span class="mention-chips-label">Will DM</span>
        {#each chips as mention (mention.uid)}
          <span class="mention-chip" data-testid="session-mention-chip" data-uid={mention.uid}>
            <span class="mention-chip-name">{mention.displayName}</span>
            <button
              type="button"
              class="mention-chip-remove"
              aria-label={`Don't DM ${mention.displayName}`}
              title={`Don't DM ${mention.displayName}`}
              data-testid="session-mention-remove"
              onclick={() => dropMention(mention.uid)}
            >
              ✕
            </button>
          </span>
        {/each}
      </div>
    {/if}

    <div class="controls" data-testid="session-composer-controls">
      <div class="cluster">
        <div class="pill-wrap">
          <button
            type="button"
            class="pill subtle"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'permission'}
            data-testid="session-pill-permission"
            onclick={(event) => toggleMenu('permission', event)}
          >
            <span class="pill-face">{permissionLabel}</span>
            <span class="chev" aria-hidden="true">⌄</span>
          </button>
          {#if openMenu === 'permission'}
            <div class="menu" role="menu" data-testid="session-menu-permission">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={permissionMode === 'prompt'}
                class="menu-item"
                class:selected={permissionMode === 'prompt'}
                onclick={() => {
                  onpermission?.('prompt');
                  closeMenus();
                }}
              >
                <span class="menu-label">Prompt for permissions</span>
                <span class="menu-sub">Ask before each tool runs</span>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={permissionMode === 'bypassAll'}
                class="menu-item"
                class:selected={permissionMode === 'bypassAll'}
                onclick={() => {
                  onpermission?.('bypassAll');
                  closeMenus();
                }}
              >
                <span class="menu-label">Bypass permissions</span>
                <span class="menu-sub">Run every tool without asking</span>
              </button>
            </div>
          {/if}
        </div>

        <button
          type="button"
          class="icon-button attach"
          aria-label="Attach an image"
          data-testid="session-composer-attach"
          onclick={() => fileInput?.click()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M7 2.4v9.2M2.4 7h9.2"
              stroke="currentColor"
              stroke-width="1.3"
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

        {#if companies.length > 0}
          <div class="pill-wrap">
            <button
              type="button"
              class="pill"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'company'}
              data-testid="session-pill-company"
              onclick={(event) => toggleMenu('company', event)}
            >
              <span class="pill-face">{companyLabel}</span>
              <span class="chev" aria-hidden="true">⌄</span>
            </button>
            {#if openMenu === 'company'}
              <div class="menu" role="menu" data-testid="session-menu-company">
                {#each companies as option (option.slug)}
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.slug === company}
                    class="menu-item"
                    class:selected={option.slug === company}
                    onclick={() => {
                      oncompany?.(option.slug);
                      closeMenus();
                    }}
                  >
                    <span class="menu-label">{option.displayName}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <div class="cluster right">
        <div class="pill-wrap">
          <button
            type="button"
            class="pill"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'tool'}
            data-testid="session-pill-tool"
            onclick={(event) => toggleMenu('tool', event)}
          >
            <span class="glyph" aria-hidden="true">{toolOption.glyph}</span>
            <span class="pill-face">{toolOption.label}</span>
            <span class="chev" aria-hidden="true">⌄</span>
          </button>
          {#if openMenu === 'tool'}
            <div class="menu menu-right" role="menu" data-testid="session-menu-tool">
              {#each TOOL_OPTIONS as option (option.value)}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.value === tool}
                  class="menu-item"
                  class:selected={option.value === tool}
                  disabled={option.value === 'codex' && !codexAvailable}
                  onclick={() => {
                    ontool?.(option.value);
                    closeMenus();
                  }}
                >
                  <span class="menu-label">
                    <span class="glyph" aria-hidden="true">{option.glyph}</span>
                    {option.label}
                  </span>
                  {#if option.value === 'codex' && !codexAvailable}
                    <span class="menu-sub">not installed</span>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <div class="pill-wrap">
          <button
            type="button"
            class="pill"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'model'}
            data-testid="session-pill-model"
            onclick={(event) => toggleMenu('model', event)}
          >
            <span class="pill-face">{modelLabel}</span>
            <span class="chev" aria-hidden="true">⌄</span>
          </button>
          {#if openMenu === 'model'}
            <div class="menu menu-right menu-wide" role="menu" data-testid="session-menu-model">
              {#each pickable as option (option.value)}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.value === model}
                  class="menu-item"
                  class:selected={option.value === model}
                  data-testid="session-menu-model-item"
                  onclick={() => {
                    onmodel?.(option.value);
                    closeMenus();
                  }}
                >
                  <span class="menu-label">{option.label}</span>
                  {#if firstSentence(option.description)}
                    <span class="menu-sub">{firstSentence(option.description)}</span>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <div class="pill-wrap">
          <button
            type="button"
            class="pill"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'effort'}
            data-testid="session-pill-effort"
            onclick={(event) => toggleMenu('effort', event)}
          >
            <span class="pill-face">{effortLabel}</span>
            <span class="chev" aria-hidden="true">⌄</span>
          </button>
          {#if openMenu === 'effort'}
            <div class="menu menu-right" role="menu" data-testid="session-menu-effort">
              {#each EFFORT_OPTIONS as option (option.value ?? '@auto')}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.value === effort}
                  class="menu-item"
                  class:selected={option.value === effort}
                  onclick={() => {
                    oneffort?.(option.value);
                    closeMenus();
                  }}
                >
                  <span class="menu-label">{option.label}</span>
                  {#if option.value === null}
                    <span class="menu-sub">Let the model decide</span>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>

        {#if working}
          <button
            type="button"
            class="go stop"
            aria-label="Stop"
            data-testid="session-composer-stop"
            onclick={() => onstop?.()}
          >
            <span class="spinner" aria-hidden="true"></span>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="2.2" y="2.2" width="5.6" height="5.6" rx="1.2" fill="currentColor" />
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
  </div>

  <div class="footer">
    {#if hqFolder}
      <span class="foot-pill" data-testid="session-foot-folder">{hqFolder}</span>
    {/if}
    {#if newSessionPending}
      <span class="foot-note" data-testid="session-new-session-hint">
        Next message starts a new session
      </span>
    {:else if overridesDeferred}
      <span class="foot-note" data-testid="session-overrides-deferred-hint">
        Model/effort apply to your next session
      </span>
    {:else if working}
      <span class="foot-note" data-testid="session-composer-steer-hint">
        Sending now steers the turn in progress
      </span>
    {/if}
    {#if attachError}
      <span class="foot-note error" data-testid="session-attach-error">{attachError}</span>
    {/if}
    {#if mentionStatus}
      <span
        class="foot-note"
        class:error={mentionStatus.error}
        role={mentionStatus.error ? 'alert' : undefined}
        data-testid="session-mention-status"
      >
        {mentionStatus.text}
      </span>
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

  /* --- the box ---------------------------------------------------------- */

  .box {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 8px 6px;
    border: 1px solid var(--v4-hairline);
    border-radius: 18px;
    background: var(--v4-raised);
  }

  .box:focus-within {
    border-color: var(--v4-control-border, var(--v4-hairline));
  }

  .text-row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 0 4px;
  }

  .composer-input {
    flex: 1;
    min-width: 0;
    max-height: 200px;
    padding: 2px 0 4px;
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

  .enter-hint {
    flex: none;
    padding-top: 3px;
    font-size: 11px;
    line-height: 1.45;
    color: var(--v4-text-3);
  }

  .file-input {
    display: none;
  }

  /* --- the control row -------------------------------------------------- */

  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-height: 32px;
  }

  .cluster {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }

  .cluster.right {
    flex: none;
    gap: 1px;
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

  .pill-wrap {
    position: relative;
    display: inline-flex;
    min-width: 0;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 26px;
    max-width: 190px;
    padding: 0 7px;
    border: 0;
    border-radius: var(--v4-radius-pill);
    background: transparent;
    color: var(--v4-text-2);
    font-family: inherit;
    font-size: var(--type-metadata);
    line-height: 1;
    cursor: pointer;
  }

  .pill:hover,
  .pill[aria-expanded='true'] {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .pill.subtle {
    color: var(--v4-text-3);
  }

  .pill-face {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .glyph {
    flex: none;
    opacity: 0.7;
  }

  /* The chevron is quiet until the pill is hovered or open — Claude's own
     restraint: a row of five permanent carets reads as a toolbar, not a line
     of words. */
  .chev {
    flex: none;
    font-size: 10px;
    line-height: 1;
    opacity: 0;
    transition: opacity 90ms ease-out;
  }

  .pill:hover .chev,
  .pill:focus-visible .chev,
  .pill[aria-expanded='true'] .chev {
    opacity: 0.6;
  }

  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }

  /* --- popovers --------------------------------------------------------- */

  .menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 6;
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 180px;
    max-height: 300px;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card);
    background: var(--v4-popover-strong, var(--v4-popover, var(--v4-raised)));
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    box-shadow: var(--v4-shadow-popover, none);
  }

  .menu-right {
    left: auto;
    right: 0;
  }

  .menu-wide {
    min-width: 260px;
  }

  .menu-item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-metadata);
    text-align: left;
    cursor: pointer;
  }

  .menu-item:hover:not(:disabled) {
    background: var(--v4-active-row);
  }

  .menu-item:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .menu-label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-weight: 600;
  }

  .menu-item.selected .menu-label {
    color: var(--v4-text-1);
  }

  .menu-sub {
    color: var(--v4-text-3);
    font-size: 11px;
    line-height: 1.35;
  }

  /* --- send / stop ------------------------------------------------------ */

  .go {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 28px;
    height: 28px;
    margin-left: 4px;
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

  .spinner {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1.5px solid transparent;
    border-top-color: currentColor;
    opacity: 0.7;
    animation: composer-spin 900ms linear infinite;
  }

  @keyframes composer-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
      opacity: 0.35;
    }
  }

  /* --- attachments ------------------------------------------------------ */

  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0 0 2px;
    padding: 0 4px;
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

  /* --- @mention chips --------------------------------------------------- */

  /* The chip is the promise: one row under the draft naming every recipient
     the send will DM, each removable. It reads as a sentence ("Will DM Corey
     Epstein"), because the action it announces leaves the app. */
  .mention-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 0 0 2px;
    padding: 0 4px;
  }

  .mention-chips-label {
    font-size: 11px;
    color: var(--v4-text-3);
  }

  .mention-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 4px 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-2);
    font-size: 11px;
  }

  .mention-chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--v4-text-3);
    font-size: 10px;
    cursor: pointer;
  }

  .mention-chip-remove:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  /* --- footer ----------------------------------------------------------- */

  /* The whole footer is the HQ folder's name. The session id, the token counts
     and the turn cost were removed on the owner's call: they are telemetry, and
     telemetry under the caret is noise. The store still carries all three. */
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
