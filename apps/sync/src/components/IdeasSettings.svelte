<script lang="ts">
  /**
   * Ideas settings section (US-012) — five rows: extraction, sync, default
   * company, retention, and the capture chord.
   *
   * Conventions follow WidgetSettings.svelte: Svelte 5 runes, optimistic
   * update with revert on failure, a single `pendingSetting` that disables the
   * section while a write is in flight, and an inline failure banner. No
   * native dialogs anywhere — a confirm()/alert() here would be a modal on a
   * settings pane.
   *
   * Two deliberate choices:
   * - The model disclosure renders ABOVE the control and is always on screen.
   *   A disclosure revealed only after you flip the switch is not a
   *   disclosure. Model is never selected without an explicit click.
   * - Retention offers a maximum edge and nothing else. There is no
   *   auto-delete control, because nothing is ever auto-deleted.
   */
  import {
    listIdeaCompanies,
    loadIdeasSettings,
    saveIdeasPrefs,
    setCaptureChord,
    type IdeaCompany,
    type IdeasExtractionMode,
    type IdeasSettingsState,
  } from '../lib/ideas/ideas-settings';

  type IdeasMutation =
    | { setting: 'extraction'; value: IdeasExtractionMode }
    | { setting: 'sync'; value: boolean }
    | { setting: 'company'; value: string | null }
    | { setting: 'retention'; value: number };
  type IdeasMutationFailure = IdeasMutation & { message: string };

  /**
   * No `showLoadError` prop. WidgetSettings has one because SettingsPage also
   * invokes its command and can report the failure itself; nothing invokes
   * `ideas_get_settings` but us, so there is no second surface to defer to.
   * A flag no caller ever set to false could only have one effect: suppress
   * the banner while the rows are already hidden, i.e. render a silently blank
   * section. A failed load always surfaces here.
   */

  let settings = $state<IdeasSettingsState | null>(null);
  let companies = $state<IdeaCompany[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let pendingSetting = $state<IdeasMutation['setting'] | 'chord' | null>(null);
  let mutationFailure = $state<IdeasMutationFailure | null>(null);
  /** Chord failures are reported on the row, never as a dialog. */
  let chordError = $state<string | null>(null);
  /**
   * Non-fatal: the rebind worked, but the OS would not release the previous
   * chord, so that combination may stay reserved system-wide until restart.
   * Surfacing it beats leaving it in a log file nobody reads.
   */
  let staleChordWarning = $state<string | null>(null);
  let capturingChord = $state(false);

  const saving = $derived(pendingSetting !== null);
  const extractionMode = $derived<IdeasExtractionMode>(settings?.extractionMode ?? 'local');
  /**
   * Fails CLOSED, and with the SAME predicate `localOnlyBadge` uses
   * (`=== false`), so the panel and the board header can never disagree about
   * the posture. Anything other than an explicit `false` — absent, null, a
   * malformed payload — reads as "syncing", which understates privacy rather
   * than promising it.
   */
  const syncEnabled = $derived(settings?.syncEnabled !== false);
  const imageMaxEdge = $derived(settings?.imageMaxEdge ?? 2000);
  const edgeChoices = $derived(settings?.imageMaxEdgeChoices?.length ? settings.imageMaxEdgeChoices : [1200, 2000, 4000]);
  const activeCompany = $derived(settings?.activeCompany ?? '');
  const chordDisplay = $derived(settings?.captureChordDisplay ?? '⌥⇧C');
  /**
   * A stored default company that is no longer in the membership list must
   * still appear in the picker. Otherwise the `<select>` falls back to
   * rendering blank while the chip next to it shows the stale slug — a control
   * that contradicts its own label.
   */
  const storedCompany = $derived(settings?.defaultCompany ?? null);
  const storedCompanyMissing = $derived(
    !!storedCompany && !companies.some((company) => company.slug === storedCompany),
  );

  $effect(() => {
    void load();
  });

  async function load() {
    loading = true;
    loadError = null;
    try {
      const [loaded, companyList] = await Promise.all([
        loadIdeasSettings(),
        listIdeaCompanies().catch(() => [] as IdeaCompany[]),
      ]);
      settings = loaded;
      companies = companyList;
    } catch (err) {
      loadError = String(err);
    } finally {
      loading = false;
    }
  }

  function applyLocal(mutation: IdeasMutation, next: IdeasSettingsState): IdeasSettingsState {
    switch (mutation.setting) {
      case 'extraction':
        return { ...next, extractionMode: mutation.value };
      case 'sync':
        return { ...next, syncEnabled: mutation.value, localOnly: !mutation.value };
      case 'company':
        return { ...next, defaultCompany: mutation.value };
      case 'retention':
        return { ...next, imageMaxEdge: mutation.value };
    }
  }

  function mutationPatch(mutation: IdeasMutation) {
    switch (mutation.setting) {
      case 'extraction':
        return { ideasExtractionMode: mutation.value };
      case 'sync':
        return { ideasSyncEnabled: mutation.value };
      case 'company':
        return { ideasDefaultCompany: mutation.value };
      case 'retention':
        return { ideasImageMaxEdge: mutation.value };
    }
  }

  function mutationLabel(failure: IdeasMutationFailure): string {
    switch (failure.setting) {
      case 'extraction':
        return 'extraction setting';
      case 'sync':
        return 'capture sync setting';
      case 'company':
        return 'default company';
      case 'retention':
        return 'image size limit';
    }
  }

  async function applyMutation(mutation: IdeasMutation, isRetry = false): Promise<void> {
    const current = settings;
    if (loading || saving || !current) return;
    pendingSetting = mutation.setting;
    if (!isRetry) mutationFailure = null;
    settings = applyLocal(mutation, current);
    try {
      await saveIdeasPrefs(mutationPatch(mutation));
      mutationFailure = null;
      // Sync and company changes move which root the settings resolve to;
      // re-read it so the note names the path captures would use.
      if (mutation.setting === 'sync' || mutation.setting === 'company') {
        try {
          settings = await loadIdeasSettings();
        } catch {
          // Keep the optimistic value; the write already succeeded.
        }
      }
    } catch (err) {
      settings = current;
      mutationFailure = { ...mutation, message: String(err) };
    } finally {
      pendingSetting = null;
    }
  }

  async function retryMutation(): Promise<void> {
    const failure = mutationFailure;
    if (!failure || saving) return;
    await applyMutation(failure, true);
  }

  function handleExtraction(value: IdeasExtractionMode): void {
    if (value === extractionMode) return;
    void applyMutation({ setting: 'extraction', value });
  }

  function handleSync(value: boolean): void {
    if (value === syncEnabled) return;
    void applyMutation({ setting: 'sync', value });
  }

  function handleCompanyChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    void applyMutation({ setting: 'company', value: value === '' ? null : value });
  }

  function handleRetentionChange(event: Event): void {
    const value = Number((event.currentTarget as HTMLSelectElement).value);
    void applyMutation({
      setting: 'retention',
      value: Number.isFinite(value) ? value : 2000,
    });
  }

  /**
   * Chord rebinding.
   *
   * The settings window is an ordinary focusable webview window (unlike the
   * non-activating capture toast), so a keydown listener on the focused
   * "Rebind" button is enough — no focusable toggle round-trip is needed here.
   * Press the button, then press the chord.
   */
  function chordFromEvent(event: KeyboardEvent): string | null {
    const parts: string[] = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    const code = event.code;
    if (/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2]))$/.test(code)) {
      parts.push(code);
      return parts.join('+');
    }
    return null;
  }

  function beginCapture(): void {
    if (loading || saving) return;
    capturingChord = true;
    chordError = null;
  }

  function cancelCapture(): void {
    capturingChord = false;
  }

  async function handleChordKeydown(event: KeyboardEvent): Promise<void> {
    if (!capturingChord) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelCapture();
      return;
    }
    // Modifier-only presses are the user still assembling the chord.
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
    event.preventDefault();
    const chord = chordFromEvent(event);
    if (!chord) {
      chordError = 'That key can’t be used in a chord. Try a letter, a digit, or F1–F12.';
      return;
    }
    capturingChord = false;
    pendingSetting = 'chord';
    chordError = null;
    staleChordWarning = null;
    try {
      const applied = await setCaptureChord(chord);
      // Keep the previously loaded settings and swap only the chord — a failed
      // rebind must leave the old chord on screen, so we never clear it first.
      if (settings) {
        settings = { ...settings, captureChord: applied.chord, captureChordDisplay: applied.display };
      }
      staleChordWarning = applied.staleChordWarning ?? null;
    } catch (err) {
      chordError = String(err);
    } finally {
      pendingSetting = null;
    }
  }
</script>

<div class="ideas-settings" data-loading={loading || undefined} data-testid="ideas-settings">
  <!-- A failed load must not render the fallback defaults as if they were the
       user's saved choices — `?? 'local'` / `?? true` / `?? 2000` / `?? '⌥⇧C'`
       are placeholders, not persisted state, and a panel that shows them after
       an error is telling the user something untrue about their settings. -->
  {#if !loadError}
  <!-- Extraction ------------------------------------------------------- -->
  <div class="setting-row stacked">
    <div class="setting-head">
      <div class="setting-info">
        <span class="setting-label">Extraction</span>
        <span class="setting-desc">
          On-device only (Vision OCR plus layout heuristics), or send the cropped image to a
          model for structured extraction. The second is markedly better on posts and articles;
          it costs per capture and the crop leaves the machine.
        </span>
      </div>
      <span class="setting-chip" data-testid="ideas-extraction-chip">
        {extractionMode === 'model' ? 'Model' : 'On device'}
      </span>
    </div>
    <!-- Disclosure lives ABOVE the control and is always visible: the cost
         and the data-leaves-device fact must be readable before the choice.

         Present tense here is CORRECT, unlike the Sync row below. Model
         extraction is wired end to end: the capture pipeline reads this
         preference at capture time (capture.rs `current_extraction_mode` ->
         `should_run_model`, in the post-capture enrichment chain) and runs the
         model stage from it. Verified by grep, not assumed. -->
    <p class="disclosure" data-testid="ideas-model-disclosure">
      {settings?.modelDisclosure ??
        'Model extraction sends each capture’s image and its recognized text to a vision model through HQ. The image leaves this device, and every capture processed this way adds a small per-capture cost to your account. Leave this off to keep extraction entirely on this device.'}
    </p>
    <div class="segmented" role="radiogroup" aria-label="Extraction">
      <button
        type="button"
        role="radio"
        aria-checked={extractionMode === 'local'}
        class:selected={extractionMode === 'local'}
        disabled={loading || saving}
        onclick={() => handleExtraction('local')}
        data-testid="ideas-extraction-local"
      >
        Local
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={extractionMode === 'model'}
        class:selected={extractionMode === 'model'}
        disabled={loading || saving}
        onclick={() => handleExtraction('model')}
        data-testid="ideas-extraction-model"
      >
        Model
      </button>
      {#if pendingSetting === 'extraction'}
        <span class="setting-pending" role="status">Saving…</span>
      {/if}
    </div>
  </div>

  <!-- Sync -------------------------------------------------------------- -->
  <div class="setting-row stacked">
    <div class="setting-head">
      <div class="setting-info">
        <span class="setting-label">Sync</span>
        <span class="setting-desc">
          Captures sync to the company vault by default. A deliberate hotkey capture is a
          different posture from ambient recording, and the difference should be stated, not
          assumed.
        </span>
      </div>
      <span class="setting-chip" data-testid="ideas-sync-chip">
        {syncEnabled ? 'Vault · synced' : 'Local only'}
      </span>
    </div>
    <div class="segmented" role="radiogroup" aria-label="Sync">
      <button
        type="button"
        role="radio"
        aria-checked={syncEnabled}
        class:selected={syncEnabled}
        disabled={loading || saving}
        onclick={() => handleSync(true)}
        data-testid="ideas-sync-on"
      >
        On
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={!syncEnabled}
        class:selected={!syncEnabled}
        disabled={loading || saving}
        onclick={() => handleSync(false)}
        data-testid="ideas-sync-off"
      >
        Off
      </button>
      {#if pendingSetting === 'sync'}
        <span class="setting-pending" role="status">Saving…</span>
      {/if}
    </div>
    {#if !syncEnabled}
      <!-- Present tense, and only as far as the code goes. The capture write
           path resolves its root from this preference, so "new captures are
           saved outside the vault" is true. What must NOT be claimed is that
           turning sync off protects captures taken while it was on — those are
           already in the vault and still sync, so the note says so. The panel
           test pins this wording. -->
      <p class="note" data-testid="ideas-local-only-note">
        New captures are saved to{settings?.capturesRoot
          ? ` ${settings.capturesRoot}`
          : ' a folder on this machine'}, outside the company vault, and are not synced to your
        team. Captures you already took while sync was on are still in the vault and still sync —
        turning this off does not move them.
      </p>
    {/if}
  </div>

  <!-- Default company --------------------------------------------------- -->
  <div class="setting-row stacked">
    <div class="setting-head">
      <div class="setting-info">
        <span class="setting-label">Default company</span>
        <span class="setting-desc">
          Which company a capture is filed to when nothing indicates otherwise. Follows the
          active HQ company; reassignment stays one chord away while the toast is up.
        </span>
      </div>
      <span class="setting-chip" data-testid="ideas-company-chip">
        {settings?.defaultCompany ?? 'Active company'}
      </span>
    </div>
    <span class="setting-control">
      {#if pendingSetting === 'company'}
        <span class="setting-pending" role="status">Saving…</span>
      {/if}
      <select
        class="picker"
        aria-label="Default company"
        data-testid="ideas-company-picker"
        value={settings?.defaultCompany ?? ''}
        onchange={handleCompanyChange}
        disabled={loading || saving}
      >
        <option value="">
          {activeCompany ? `Active company (${activeCompany})` : 'Active company'}
        </option>
        {#if storedCompanyMissing}
          <!-- Name the stale slug rather than render an empty selection. -->
          <option value={storedCompany} data-testid="ideas-company-missing">
            {storedCompany} (not in your current membership list)
          </option>
        {/if}
        {#each companies as company (company.slug)}
          <option value={company.slug}>{company.name}</option>
        {/each}
      </select>
    </span>
  </div>

  <!-- Retention --------------------------------------------------------- -->
  <div class="setting-row stacked">
    <div class="setting-head">
      <div class="setting-info">
        <span class="setting-label">Retention</span>
        <span class="setting-desc">
          Images are the expensive object in a synced vault and grow without bound. Captures are
          downsampled on write to this maximum edge. Nothing is ever auto-deleted.
        </span>
      </div>
      <span class="setting-chip" data-testid="ideas-retention-chip">{imageMaxEdge} px</span>
    </div>
    <span class="setting-control">
      {#if pendingSetting === 'retention'}
        <span class="setting-pending" role="status">Saving…</span>
      {/if}
      <select
        class="picker"
        aria-label="Image maximum edge"
        data-testid="ideas-retention-picker"
        value={String(imageMaxEdge)}
        onchange={handleRetentionChange}
        disabled={loading || saving}
      >
        {#each edgeChoices as choice (choice)}
          <option value={String(choice)}>{choice} px</option>
        {/each}
      </select>
    </span>
  </div>

  <!-- Capture chord ----------------------------------------------------- -->
  <div class="setting-row stacked">
    <div class="setting-head">
      <div class="setting-info">
        <span class="setting-label">Capture chord</span>
        <span class="setting-desc">
          Rebindable, because ⌥⇧C will collide on some machines. Press Rebind, then press the
          combination you want. If it’s taken — by another app, or by HQ itself — the rebind is
          refused and says so right here, and your current chord keeps working.
        </span>
      </div>
      <span class="setting-chip" data-testid="ideas-chord-chip">{chordDisplay}</span>
    </div>
    <span class="setting-control">
      {#if pendingSetting === 'chord'}
        <span class="setting-pending" role="status">Applying…</span>
      {/if}
      <button
        type="button"
        class="rebind"
        class:capturing={capturingChord}
        disabled={loading || saving}
        onclick={beginCapture}
        onblur={cancelCapture}
        onkeydown={handleChordKeydown}
        data-testid="ideas-chord-rebind"
      >
        {capturingChord ? 'Press the new chord…' : 'Rebind'}
      </button>
    </span>
    {#if chordError}
      <p class="error-line" role="alert" data-testid="ideas-chord-error">{chordError}</p>
    {:else if staleChordWarning}
      <p class="note warn-line" role="status" data-testid="ideas-chord-stale-warning">
        {staleChordWarning}
      </p>
    {/if}
  </div>

  {/if}

  {#if loadError}
    <p class="error-line" role="alert" data-testid="ideas-load-error">
      Couldn’t load your Ideas settings, so they’re hidden rather than shown wrong. Your saved
      choices are untouched — reopen this pane to try again.
      {loadError}
    </p>
  {:else if mutationFailure}
    <div class="error-line row-error" role="alert" data-testid="ideas-setting-error">
      <span>Couldn’t save the {mutationLabel(mutationFailure)}. {mutationFailure.message}</span>
      <button type="button" onclick={retryMutation} disabled={saving}>
        {pendingSetting === mutationFailure.setting ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  {/if}
</div>

<style>
  .ideas-settings {
    display: block;
  }

  .setting-row {
    display: flex;
    gap: 12px;
    padding: 10px 12px;
  }

  .setting-row.stacked {
    flex-direction: column;
    align-items: stretch;
  }

  .setting-row + .setting-row {
    border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
  }

  .setting-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }

  .setting-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: light-dark(rgba(0, 0, 0, 0.88), rgba(255, 255, 255, 0.92));
  }

  .setting-desc,
  .disclosure,
  .note {
    font-size: 0.6875rem;
    color: light-dark(rgba(0, 0, 0, 0.5), rgba(255, 255, 255, 0.55));
    line-height: 1.35;
  }

  .disclosure,
  .note {
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.625rem;
    border-radius: var(--radius-field, 6px);
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));
  }

  .setting-chip {
    flex: 0 0 auto;
    font-size: 0.6875rem;
    font-weight: 600;
    padding: 0.125rem 0.5rem;
    border-radius: var(--v4-radius-pill, 999px);
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1));
    color: light-dark(rgba(0, 0, 0, 0.7), rgba(255, 255, 255, 0.78));
  }

  .setting-control {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .setting-pending {
    color: light-dark(rgba(0, 0, 0, 0.5), rgba(255, 255, 255, 0.55));
    font-size: 0.6875rem;
    line-height: 1;
  }

  .segmented {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.5rem;
  }

  .segmented button,
  .rebind {
    font: inherit;
    font-size: 0.75rem;
    padding: 0.25rem 0.75rem;
    border-radius: var(--radius-field, 6px);
    border: 1px solid light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.14));
    background: light-dark(rgba(0, 0, 0, 0.03), rgba(255, 255, 255, 0.06));
    color: inherit;
    cursor: pointer;
  }

  .segmented button.selected {
    background: light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.18));
    font-weight: 600;
  }

  .rebind.capturing {
    border-color: var(--v4-focus-ring, currentColor);
  }

  .segmented button:disabled,
  .rebind:disabled,
  .picker:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .picker {
    font-size: 0.8125rem;
    font-family: inherit;
    max-width: 14rem;
    padding: 0.375rem 0.5rem;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    color: light-dark(rgba(0, 0, 0, 0.88), rgba(255, 255, 255, 0.92));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1));
    border-radius: var(--radius-field, 6px);
    cursor: pointer;
  }

  .warn-line {
    color: light-dark(#8a5200, #f0b429);
  }

  .error-line {
    margin: 0.5rem 0 0;
    font-size: 0.6875rem;
    line-height: 1.3;
    color: light-dark(#c0392b, #ff6b6b);
  }

  .row-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 6px 12px 10px;
  }

  .row-error button {
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    border-bottom: 1px solid currentColor;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
</style>
