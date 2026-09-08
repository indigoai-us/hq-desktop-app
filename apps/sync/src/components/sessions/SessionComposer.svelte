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
   * `./slash-commands`, `./mentions` and `./context-attachments`, and every
   * model name comes from `./session-models`; this component owns only the
   * DOM and the keyboard.
   *
   * `/` opens `SlashPicker` — HQ workers, HQ skills by scope, and the CLI's
   * own commands — over the slot the `@` picker uses (the two never show
   * together; a mention token under the caret wins). The draft is the search.
   * A pick leaves a COMMAND CHIP above the draft — the kind pill and the name
   * (`design · mockup`, `/handoff`) — for as long as the draft still starts
   * with the picked token. The chip is a label, never the payload: the text
   * sent is the draft, verbatim.
   *
   * `@`-mentions: an `@` at a word start opens `MentionPicker`. Picking
   * inserts `@Display Name` AND keeps a chip under the textarea that says who
   * will be DMed; the chip has an × and a mention whose text was deleted loses
   * its chip, so nothing is ever DMed that the user cannot see promised right
   * under their draft.
   *
   * `+` opens `ContextAttachMenu`: an image, a meeting, a signal, a vault
   * file or a pasted path. Each pick is a chip on the same row the mentions
   * use; its text is read the moment it lands so the running size under the
   * chips is honest, and every loaded chip rides the send as a context block
   * the page appends after the words.
   *
   * The company pill has a second level: pick a company, then a project (or
   * "No project"), and the page orients the first send with `/startwork`. The
   * opt-out toggle lives in the same menu.
   */
  import { onMount, tick } from 'svelte';
  import ContextAttachMenu from './ContextAttachMenu.svelte';
  import MentionPicker from './MentionPicker.svelte';
  import ProjectPicker from './ProjectPicker.svelte';
  import SlashPicker from './SlashPicker.svelte';
  import {
    ATTACHMENT_CHARS,
    addAttachment,
    attachmentLabel,
    contextSizeLabel,
    exceedsContextBudget,
    removeAttachment,
    type ContextAttachment,
    type ContextLoaders,
    type LoadedAttachment,
  } from './context-attachments';
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
  import {
    kindLabel,
    replaceSlashQuery,
    serializeComposerRoute,
    slashQueryAt,
    type ComposerRoute,
    type PickerKind,
    type PickerRow,
    type SkillCatalog,
  } from './slash-commands';
  import { isStartworkTurn, type ProjectEntry, type ProjectViewer } from './startwork';
  import { positionPicker } from './picker-position';
  import type { SessionCommand } from './session-events';
  import type {
    ComposerImage,
    EffortOption,
    SessionModel,
    SessionToolId,
  } from './session-models';
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
  type MenuName = 'permission' | 'company' | 'tool' | 'model' | 'effort' | 'attach';

  /** The picked slash command, as the chip above the draft names it. */
  interface CommandToken {
    route: ComposerRoute;
    kind: PickerKind;
    label: string;
  }

  /** A context chip: the pick, plus its read text (or why it has none yet). */
  interface ContextChip extends ContextAttachment {
    text?: string;
    truncated?: boolean;
    loading: boolean;
    error?: string;
  }

  interface Props {
    /** Merged slash-command catalog (probe + the session's own `started` list). */
    commands?: SessionCommand[];
    /** HQ workers + skills for the `/` picker; null until loaded. */
    catalog?: SkillCatalog | null;
    catalogLoading?: boolean;
    catalogError?: string;
    groupMetadataAvailable?: boolean;
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
    /** The chosen project's name for the company pill's second level. */
    project?: string | null;
    projects?: ProjectEntry[];
    projectsLoading?: boolean;
    projectsError?: string;
    /** Who is signed in — the project picker's "Mine" chip. */
    viewer?: ProjectViewer | null;
    /** "Run /startwork on first message". */
    startworkEnabled?: boolean;
    /** The automatic orientation that will run before this fresh session's message. */
    orientationCommand?: string | null;
    models?: SessionModel[];
    /** The selected model's `value` (`null` = the CLI's own default). */
    model?: string | null;
    /** The model the live session actually resolved, from `started`. */
    resolvedModel?: string | null;
    effort?: string | null;
    /**
     * The effort ladder the CURRENT tool takes. Codex reasons at `xhigh` and
     * `ultra`, Claude at `max`; the page clamps `effort` to whichever ladder
     * is showing, so the pill never names a rung its CLI would reject.
     */
    effortOptions?: EffortOption[];
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
    /**
     * The page dropped a model the current tool cannot run ("Model reset to
     * Default for Claude"). One footer line, cleared on the next pick.
     */
    modelNote?: string;
    modelsLoading?: boolean;
    modelsError?: string;
    onrefreshmodels?: () => void;

    /** Footer: the HQ folder's basename. The whole footer. */
    hqFolder?: string;

    /** Who `@` can mention in the session's company (people + fleet agents). */
    mentionCandidates?: MentionCandidate[];
    /** The last mention fan-out's outcome, e.g. "DM'd Corey Epstein". */
    mentionStatus?: { text: string; error: boolean } | null;
    /** The `+` menu's readers; null leaves only Image… enabled. */
    context?: ContextLoaders | null;

    /**
     * `mentions` are the chips still showing at send time — the DM list;
     * `attachments` the loaded context chips, in the order they were added.
     */
    onsend?: (
      text: string,
      images: ComposerImage[],
      mentions: Mention[],
      attachments: LoadedAttachment[],
    ) => void;
    onstop?: () => void;
    oncompany?: (slug: string | null) => void;
    onproject?: (name: string | null) => void;
    onstartworktoggle?: (enabled: boolean) => void;
    onmodel?: (value: string | null) => void;
    oneffort?: (value: string | null) => void;
    onpermission?: (mode: 'prompt' | 'bypassAll') => void;
    ontool?: (tool: SessionToolId) => void;
  }

  let {
    commands = [],
    catalog = null,
    catalogLoading = false,
    catalogError = '',
    groupMetadataAvailable = true,
    working = false,
    disabled = false,
    notice = '',
    placeholder = 'Do anything…',
    autofocus = false,
    companies = [],
    company = null,
    project = null,
    projects = [],
    projectsLoading = false,
    projectsError = '',
    viewer = null,
    startworkEnabled = true,
    orientationCommand = null,
    models = [],
    model = null,
    resolvedModel = null,
    effort = null,
    effortOptions = EFFORT_OPTIONS,
    permissionMode = 'prompt',
    tool = 'claude',
    codexAvailable = false,
    newSessionPending = false,
    overridesDeferred = false,
    modelNote = '',
    modelsLoading = false,
    modelsError = '',
    onrefreshmodels,
    hqFolder = '',
    mentionCandidates = [],
    mentionStatus = null,
    context = null,
    onsend,
    onstop,
    oncompany,
    onproject,
    onstartworktoggle,
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
  /** Dismissed with Escape; re-armed as soon as the draft changes. */
  let suppressed = $state(false);
  let lastDraft = $state('');
  let openMenu = $state<MenuName | null>(null);
  /** The company menu's two levels. */
  let companyPane = $state<'companies' | 'projects'>('companies');

  // --- / picker ---------------------------------------------------------------
  let slashPicker = $state<{ handleKey: (event: KeyboardEvent) => boolean } | null>(null);
  /** A picked skill/worker route is independent from the natural-language draft. */
  let commandToken = $state<CommandToken | null>(null);

  // --- @mentions ------------------------------------------------------------
  /** Where the caret is, mirrored from the textarea on every edit/move. */
  let caret = $state(0);
  /** Every mention picked so far; `chips` is the subset the draft still names. */
  let mentions = $state<Mention[]>([]);
  let mentionHighlighted = $state(0);
  /** Dismissed with Escape; re-armed as soon as the draft changes. */
  let mentionSuppressed = $state(false);

  // --- context chips ----------------------------------------------------------
  let contextChips = $state<ContextChip[]>([]);
  let contextError = $state('');

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
  const commandChip = $derived(commandToken);
  const orientationPreview = $derived(
    orientationCommand && !isStartworkTurn(draft) ? orientationCommand : null,
  );

  /** The `/token` under the caret, wherever it appears in the draft. */
  const slashQuery = $derived(suppressed ? null : slashQueryAt(draft, caret));
  // A mention token under the caret takes the slot; the slash picker yields.
  const pickerOpen = $derived(!mentionOpen && slashQuery !== null);

  const loadedContext = $derived(
    contextChips.filter((chip): chip is ContextChip & { text: string } => typeof chip.text === 'string'),
  );
  const contextLoading = $derived(contextChips.some((chip) => chip.loading));

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
    effortOptions.find((option) => option.value === effort)?.label ?? 'Auto',
  );
  const companyName = $derived(
    companies.find((option) => option.slug === company)?.displayName ?? company ?? 'Company',
  );
  const companyLabel = $derived(project ? `${companyName} · ${project}` : companyName);
  const permissionLabel = $derived(
    permissionMode === 'bypassAll' ? 'Bypass permissions' : 'Prompt for permissions',
  );
  const toolOption = $derived(
    TOOL_OPTIONS.find((option) => option.value === tool) ?? TOOL_OPTIONS[0],
  );
  const canSend = $derived(
    !disabled && !contextLoading &&
      (commandToken?.route.kind === 'skill' || draft.trim().length > 0),
  );

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
    const opening = openMenu !== name;
    openMenu = opening ? name : null;
    // Once a company is bound, the useful next choice is its project. Changing
    // company remains one explicit Back action away inside the same control.
    if (name === 'company' && opening) companyPane = company ? 'projects' : 'companies';
  }

  function closeMenus() {
    openMenu = null;
  }

  /**
   * Open the model menu from outside — the transcript's `model_not_found`
   * line offers "Choose a model", and the fix should be the menu itself, not
   * a hunt for the pill.
   */
  export function openModelMenu(): void {
    openMenu = 'model';
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && openMenu !== null) {
      openMenu = null;
      textarea?.focus();
    }
  }

  /** A picker row becomes a route pill without discarding surrounding prose. */
  async function pickRow(row: PickerRow) {
    if (!row.route) return;
    const query = slashQuery;
    if (!query) return;
    const kind: PickerKind = row.route.kind;
    commandToken = { route: row.route, kind, label: row.route.label };
    const next = replaceSlashQuery(draft, query, '');
    draft = next.draft;
    caret = next.caret;
    suppressed = true;
    await tick();
    const el = textarea;
    if (el) {
      if (typeof el.setSelectionRange === 'function') el.setSelectionRange(next.caret, next.caret);
      el.focus();
    }
  }

  /** Removing the pill never removes the user's prompt. */
  function dropCommand() {
    commandToken = null;
    suppressed = true;
    textarea?.focus();
  }

  /**
   * A fresh draft — the strip's "+" and the new-session route: the text, the
   * images, the mention and context chips and the command chip all go; the
   * pills (company, tool, model…) stay, they are props.
   */
  export function reset(): void {
    draft = '';
    attached = [];
    attachError = '';
    suppressed = false;
    mentions = [];
    mentionSuppressed = false;
    caret = 0;
    contextChips = [];
    contextError = '';
    commandToken = null;
    openMenu = null;
    void tick().then(autosize);
  }

  /** The picker's search box typed: the draft follows it. */
  function onPickerQuery(query: string) {
    const active = slashQuery;
    if (!active) return;
    const next = replaceSlashQuery(draft, active, `/${query}`);
    draft = next.draft;
    caret = next.caret;
  }

  // --- context chips ----------------------------------------------------------

  async function addContext(attachment: ContextAttachment) {
    contextError = '';
    closeMenus();
    textarea?.focus();
    const next = addAttachment(contextChips, { ...attachment, loading: true } as ContextChip);
    if (next.error) {
      contextError = next.error;
      return;
    }
    if (next.list.length === contextChips.length) return; // already attached
    contextChips = next.list;
    const readers = context;
    if (!readers) {
      contextChips = removeAttachment(contextChips, attachment.path);
      contextError = 'Context files cannot be read right now.';
      return;
    }
    try {
      const ref = await readers.referenceText(attachment.path, ATTACHMENT_CHARS);
      // The chip may have been removed while the read was in flight.
      if (!contextChips.some((chip) => chip.path === attachment.path)) return;
      if (exceedsContextBudget(loadedContext, ref.text)) {
        contextChips = removeAttachment(contextChips, attachment.path);
        contextError = `${attachmentLabel(attachment)} would push the context past the 24k-character budget.`;
        return;
      }
      contextChips = contextChips.map((chip) =>
        chip.path === attachment.path
          ? { ...chip, text: ref.text, truncated: ref.truncated, loading: false }
          : chip,
      );
    } catch (err) {
      contextChips = removeAttachment(contextChips, attachment.path);
      contextError = `Couldn't read ${attachmentLabel(attachment)}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  function dropContext(path: string) {
    contextChips = removeAttachment(contextChips, path);
    contextError = '';
    textarea?.focus();
  }

  function submit() {
    const prompt = draft.trim();
    if (disabled || contextLoading || (!commandToken && !prompt)) return;
    if (commandToken?.route.kind === 'worker' && !prompt) return;
    const text = commandToken ? serializeComposerRoute(commandToken.route, prompt) : prompt;
    const attachments: LoadedAttachment[] = loadedContext.map((chip) => ({
      kind: chip.kind,
      title: chip.title,
      path: chip.path,
      subtitle: chip.subtitle,
      text: chip.text,
      truncated: chip.truncated ?? false,
    }));
    onsend?.(text, attached, chips, attachments);
    draft = '';
    attached = [];
    attachError = '';
    suppressed = false;
    mentions = [];
    mentionSuppressed = false;
    caret = 0;
    contextChips = [];
    contextError = '';
    commandToken = null;
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

    if (pickerOpen && slashPicker?.handleKey(event)) {
      event.preventDefault();
      return;
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

  function pickImage() {
    closeMenus();
    fileInput?.click();
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

  {#if pickerOpen && slashQuery}
    <SlashPicker
      bind:this={slashPicker}
      query={slashQuery.prefix}
      {catalog}
      {catalogLoading}
      {catalogError}
      {company}
      {groupMetadataAvailable}
      onpick={pickRow}
      onquery={onPickerQuery}
      onclose={() => {
        suppressed = true;
        textarea?.focus();
      }}
    />
  {/if}

  <div class="box">
    {#if orientationPreview}
      <div class="orientation-preview" data-testid="session-orientation-preview">
        <span class="orientation-preview-label">Session context</span>
        <code>{orientationPreview}</code>
      </div>
    {/if}

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

    {#if commandChip}
      <div class="command-row" data-testid="session-command-chips">
        <span
          class={`command-chip kind-${commandChip.kind}`}
          data-testid="session-command-chip"
          data-kind={commandChip.kind}
          data-route={commandChip.route.kind}
        >
          <span class="command-chip-kind">{kindLabel(commandChip.kind)}</span>
          <span class="command-chip-name">{commandChip.label}</span>
          <button
            type="button"
            class="command-chip-remove"
            aria-label={`Remove ${commandChip.label}`}
            title={`Remove ${commandChip.label}`}
            data-testid="session-command-remove"
            onclick={dropCommand}
          >
            ✕
          </button>
        </span>
      </div>
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

    {#if contextChips.length > 0}
      <div class="mention-chips" data-testid="session-context-chips">
        <span class="mention-chips-label">Context</span>
        {#each contextChips as chip (chip.path)}
          <span
            class="mention-chip"
            class:loading={chip.loading}
            data-testid="session-context-chip"
            data-kind={chip.kind}
            data-path={chip.path}
            title={chip.path}
          >
            <span class="mention-chip-name">{attachmentLabel(chip)}</span>
            {#if chip.loading}
              <span class="chip-note" aria-label="Reading">…</span>
            {:else if chip.truncated}
              <span class="chip-note" data-testid="session-context-truncated">truncated</span>
            {/if}
            <button
              type="button"
              class="mention-chip-remove"
              aria-label={`Remove ${attachmentLabel(chip)}`}
              title={`Remove ${attachmentLabel(chip)}`}
              data-testid="session-context-remove"
              onclick={() => dropContext(chip.path)}
            >
              ✕
            </button>
          </span>
        {/each}
        <span class="mention-chips-label size" data-testid="session-context-size">
          {contextSizeLabel(loadedContext)}
        </span>
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

        <div class="pill-wrap">
          <button
            type="button"
            class="icon-button attach"
            aria-label="Attach context"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'attach'}
            data-testid="session-composer-attach"
            onclick={(event) => toggleMenu('attach', event)}
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
          {#if openMenu === 'attach'}
            <ContextAttachMenu
              {company}
              loaders={context}
              onimage={pickImage}
              onattach={(attachment) => void addContext(attachment)}
              onclose={() => {
                closeMenus();
                textarea?.focus();
              }}
            />
          {/if}
        </div>
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
              <!-- Rows that move WITHIN this two-level menu stop their click so
                   the window listener does not close it: picking a company
                   opens the project pane, and the toggle stays put. -->
              <div
                class="menu menu-wide"
                class:menu-projects={companyPane === 'projects'}
                role="menu"
                data-testid="session-menu-company"
                data-pane={companyPane}
                use:positionPicker={companyPane === 'projects'}
              >
                {#if companyPane === 'companies'}
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={startworkEnabled}
                    class="menu-item"
                    data-testid="session-menu-startwork-toggle"
                    onclick={(event) => {
                      event.stopPropagation();
                      onstartworktoggle?.(!startworkEnabled);
                    }}
                  >
                    <span class="menu-label">
                      <span class="check" aria-hidden="true">{startworkEnabled ? '✓' : ''}</span>
                      Run /startwork on first message
                    </span>
                    <span class="menu-sub">Orients the session in HQ before your first message</span>
                  </button>
                  <div class="menu-rule"></div>
                  {#each companies as option (option.slug)}
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={option.slug === company}
                      class="menu-item"
                      class:selected={option.slug === company}
                      data-testid="session-menu-company-item"
                      onclick={(event) => {
                        event.stopPropagation();
                        oncompany?.(option.slug);
                        companyPane = 'projects';
                      }}
                    >
                      <span class="menu-label">{option.displayName}</span>
                    </button>
                  {/each}
                  <div class="menu-rule"></div>
                  <button
                    type="button"
                    role="menuitem"
                    class="menu-item"
                    disabled={!company}
                    data-testid="session-menu-project-open"
                    onclick={(event) => {
                      event.stopPropagation();
                      companyPane = 'projects';
                    }}
                  >
                    <span class="menu-label">
                      Project
                      <span class="menu-value">{project ?? 'None'}</span>
                      <span class="chev-right" aria-hidden="true">›</span>
                    </span>
                  </button>
                {:else}
                  <button
                    type="button"
                    class="menu-item menu-back"
                    data-testid="session-menu-project-back"
                    onclick={(event) => {
                      event.stopPropagation();
                      companyPane = 'companies';
                    }}
                  >
                    <span class="menu-label">
                      <span class="chev-left" aria-hidden="true">‹</span>
                      Change company
                    </span>
                    <span class="menu-sub">Currently {companyName}</span>
                  </button>
                  <div class="menu-rule"></div>
                  <ProjectPicker
                    {projects}
                    selected={project}
                    loading={projectsLoading}
                    error={projectsError}
                    {viewer}
                    onpick={(name) => {
                      onproject?.(name);
                      closeMenus();
                      textarea?.focus();
                    }}
                  />
                {/if}
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
            <span class="pill-face">{modelsLoading ? 'Loading models…' : modelLabel}</span>
            <span class="chev" aria-hidden="true">⌄</span>
          </button>
          {#if openMenu === 'model'}
            <div class="menu menu-right menu-wide" use:positionPicker={false} role="menu" data-testid="session-menu-model">
              {#if modelsLoading}
                <div class="model-loading" role="status"><span class="model-spinner" aria-hidden="true"></span>Loading available models…</div>
              {:else if modelsError}
                <div class="model-loading" role="status">Could not load models. Please retry.</div>
              {:else}
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
              {/if}
              {#if onrefreshmodels}
                <button type="button" role="menuitem" class="menu-item" disabled={modelsLoading} onclick={onrefreshmodels}>Refresh models</button>
              {/if}
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
              {#each effortOptions as option (option.value ?? '@auto')}
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
    {#if modelNote}
      <span class="foot-note" role="status" data-testid="session-model-reset-note">{modelNote}</span>
    {/if}
    {#if attachError}
      <span class="foot-note error" data-testid="session-attach-error">{attachError}</span>
    {/if}
    {#if contextError}
      <span class="foot-note error" role="alert" data-testid="session-context-error">{contextError}</span>
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
  .model-loading { display:flex; align-items:center; gap:10px; padding:20px 12px; font-size:13px; color:var(--v4-text-2); }
  .model-spinner { width:14px; height:14px; flex-shrink:0; border:2px solid var(--v4-hairline); border-top-color:currentColor; border-radius:50%; animation:model-spin .8s linear infinite; }
  @keyframes model-spin { to { transform:rotate(360deg); } }
  @media(prefers-reduced-motion:reduce) { .model-spinner { animation:none; } }
  .composer {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    min-width: 0;
    max-width: var(--session-column-width, 760px);
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

  .orientation-preview {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 6px;
    padding: 7px 9px;
    border-radius: 10px;
    background: var(--v4-active-row);
    color: var(--v4-text-2);
    font-size: var(--type-metadata);
    line-height: 1.35;
  }

  .orientation-preview-label {
    color: var(--v4-text-3);
    white-space: nowrap;
  }

  .orientation-preview code {
    overflow: hidden;
    color: var(--v4-text-1);
    font-family: var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .icon-button:hover,
  .icon-button[aria-expanded='true'] {
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
    box-sizing: border-box;
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

  /* The project pane is a real list: wider, taller, and it scrolls its own
     rows under a fixed search + filter head. */
  .menu-projects {
    box-sizing: border-box;
    width: clamp(320px, 68vw, 560px);
    min-width: 0;
    max-width: calc(100vw - 48px);
    max-height: min(480px, calc(100vh - 112px));
    overflow: hidden;
  }

  .menu-rule {
    height: 1px;
    margin: 3px 4px;
    background: var(--v4-hairline);
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

  .menu-value {
    margin-left: auto;
    font-weight: 400;
    color: var(--v4-text-3);
  }

  .chev-right,
  .chev-left {
    color: var(--v4-text-3);
  }

  .check {
    display: inline-block;
    width: 12px;
    text-align: center;
  }

  .menu-back .menu-label {
    color: var(--v4-text-2);
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

  /* --- the command chip --------------------------------------------------- */

  /* The picked route stays visually distinct from the user's prompt. Skills use
     a quiet fill; workers use an outline. Both remain monochrome. */
  .command-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0 0 4px;
    padding: 0 4px;
  }

  .command-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    max-width: 100%;
    padding: 0 4px 0 4px;
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
    color: var(--v4-text-1);
    font-size: 12px;
  }

  .command-chip-kind {
    display: inline-flex;
    align-items: center;
    height: 16px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: 0;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.02em;
    line-height: 1;
    white-space: nowrap;
  }

  .command-chip.kind-worker .command-chip-kind,
  .command-chip.kind-worker-skill .command-chip-kind {
    border-color: var(--v4-control-border, var(--v4-hairline));
    background: transparent;
    color: var(--v4-text-2);
  }

  .command-chip.kind-worker-skill {
    border-color: var(--v4-control-border, var(--v4-hairline));
  }

  .command-chip.kind-skill {
    background: var(--v4-secondary-bg, rgba(255, 255, 255, 0.08));
    border-color: transparent;
    color: var(--v4-secondary-fg);
  }

  .command-chip.kind-skill .command-chip-kind {
    border-color: color-mix(in srgb, currentColor 30%, transparent);
  }

  .command-chip.kind-cli .command-chip-kind {
    border-color: var(--v4-hairline);
    color: var(--v4-text-3);
  }

  .command-chip-name {
    min-width: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
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

  .command-chip-remove:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  /* --- @mention + context chips ----------------------------------------- */

  /* The chip is the promise: one row under the draft naming every recipient
     the send will DM (or every file it will carry), each removable. It reads
     as a sentence ("Will DM Corey Epstein"), because the action it announces
     leaves the app. Context chips share the row's grammar on purpose. */
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

  .mention-chips-label.size {
    margin-left: auto;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
  }

  .mention-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    max-width: 100%;
    padding: 0 4px 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-2);
    font-size: 11px;
  }

  .mention-chip.loading {
    opacity: 0.6;
  }

  .mention-chip-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip-note {
    flex: none;
    font-size: 10px;
    color: var(--v4-text-3);
  }

  .mention-chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
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
</style>
