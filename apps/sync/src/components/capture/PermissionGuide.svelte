<script lang="ts" module>
  /** Event emitted by src-tauri/src/commands/capture.rs on the ready handshake. */
  export const EVENT_STATE = 'permission-guide:state';

  /** Shape of that payload (serde camelCase of `PermissionGuideState`). */
  export type GuideState = {
    grantPath: string;
    grantName: string;
    willReprompt: boolean;
  };

  /** Normalize a Tauri response that may arrive array-shaped through the IPC
   *  boundary (repo policy: normalize array-shaped Tauri responses at the
   *  adapter, never at the call site). */
  export function normalizeGuideState(raw: unknown): GuideState | null {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (typeof v.grantPath !== 'string') return null;
    return {
      grantPath: v.grantPath,
      grantName: typeof v.grantName === 'string' && v.grantName ? v.grantName : 'HQ',
      willReprompt: v.willReprompt === true,
    };
  }
</script>

<script lang="ts">
  /**
   * Guided screen-recording permission onboarding (hq-idea-board US-014).
   *
   * Renders inside the `permission-guide` Tauri window. It opens only when a
   * genuine capture attempt found Screen Recording unavailable *after* the
   * one-shot macOS prompt — never at launch, where that prompt would be
   * wasted.
   *
   * The panel does three things the old one-line banner could not:
   *   1. It deep-links the Screen Recording pane and sits beside it,
   *      always-on-top, so the user never loses their place.
   *   2. It presents the app bundle as a drag source to drop straight into
   *      the permissions list — with a copy-path fallback for anyone who
   *      cannot drag, and full keyboard operation for everyone.
   *   3. Rust polls the permission while this is open; the instant it flips,
   *      the panel closes and the capture the user attempted resumes on its
   *      own. Nothing in here has to detect that.
   *
   * It also says plainly that macOS will not ask again, so a previously
   * denied user understands why dragging is the only route rather than
   * concluding the app is broken.
   *
   * Mountable with zero Tauri APIs (happy-dom tests). Listeners and invokes
   * only run when `__TAURI_INTERNALS__` is present, and listeners tear down
   * through `safeUnlisten` (HQ-DESKTOP-39 shared teardown boundary).
   */
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { safeUnlisten } from '../../lib/listener-registry';

  let guide = $state<GuideState | null>(null);
  let copied = $state(false);
  let copyFailed = $state(false);
  let openFailed = $state(false);
  let dragFailed = $state(false);
  let entered = $state(false);

  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  const hasTauri = () =>
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in (window as unknown as Record<string, unknown>);

  const grantPath = $derived(guide?.grantPath ?? '');
  const grantName = $derived(guide?.grantName ?? 'HQ');
  const willReprompt = $derived(guide?.willReprompt === true);

  onMount(() => {
    // Purposeful motion: one entrance, no looping decoration.
    entered = true;

    if (!hasTauri()) return;

    let unlisten: UnlistenFn | null = null;
    void listen<unknown>(EVENT_STATE, (event) => {
      const next = normalizeGuideState(event.payload);
      if (next) guide = next;
      // Rust emits this on EVERY show, and the window is pre-rendered once —
      // so `onMount` fires only for the first open. Re-arming the keyboard
      // here is what keeps Escape and tab working on the second open and
      // after (Rust drops focusability again on every hide).
      enableKeyboard();
    }).then((fn) => {
      unlisten = fn;
    });

    // Ready handshake: get the drag target, and make the panel keyboard-
    // operable. The window is built non-activating, so it can only accept key
    // events once Rust flips focusable (repo policy
    // hq-desktop-app-nonactivating-window-toggle-focusable-for-input). Rust
    // deliberately does not focus it: the user is dragging into the Screen
    // Recording pane next door and must keep key focus there, so the panel
    // becomes key only when they click or tab into it.
    void invoke<unknown>('permission_guide_ready')
      .then((raw) => {
        const next = normalizeGuideState(raw);
        if (next) guide = next;
      })
      .catch((err) => console.error('permission_guide_ready failed:', err));
    enableKeyboard();

    return () => {
      if (copyResetTimer) clearTimeout(copyResetTimer);
      safeUnlisten(unlisten);
    };
  });

  /**
   * Make the window able to take key events.
   *
   * Called only once the window is already on screen, never before: flipping
   * focusable ahead of `show()` would let macOS make the panel key and pull
   * focus off the Screen Recording pane the user has to drag into. The panel
   * becomes key when they click or tab into it — see the Rust command's note.
   */
  function enableKeyboard() {
    if (!hasTauri()) return;
    void invoke('set_permission_guide_focusable', { focusable: true }).catch((err) =>
      console.error('set_permission_guide_focusable failed:', err),
    );
  }

  async function openSettings() {
    openFailed = false;
    if (!hasTauri()) return;
    try {
      await invoke('permissions_open_settings', { permission: 'screen-capture' });
    } catch (err) {
      console.error('permissions_open_settings failed:', err);
      openFailed = true;
    }
  }

  async function copyPath() {
    copied = false;
    copyFailed = false;
    dragFailed = false;
    if (!grantPath) return;
    try {
      await navigator.clipboard.writeText(grantPath);
      copied = true;
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copied = false;
      }, 2000);
    } catch (err) {
      console.error('permission-guide: clipboard write failed', err);
      // The path stays selectable in the panel, so this is recoverable.
      copyFailed = true;
    }
  }

  async function dismiss() {
    if (!hasTauri()) return;
    try {
      await invoke('dismiss_permission_guide');
    } catch (err) {
      console.error('dismiss_permission_guide failed:', err);
    }
  }

  /**
   * Start the REAL drag.
   *
   * This used to be an HTML5 DOM drag (a draggable chip whose `dragstart`
   * wrote a `file://` string onto the DataTransfer). That drag was inert: an
   * HTML5 drag inside a WKWebView never starts an `NSDraggingSession`, so
   * System Settings was never offered a file and its Screen Recording list
   * never highlighted — the chip looked draggable and accomplished nothing.
   * The drag has to be begun by AppKit.
   *
   * The webview's job is only to say "the chip is pressed" (arm) and "the
   * press ended" (cancel). Rust watches for the user's own left-mouse-drag
   * with a local event monitor and begins the session from that live event —
   * it cannot be begun from here, because by the time an invoke crosses the
   * IPC boundary the event AppKit is dispatching is no longer the user's
   * press. Waiting for a real drag event also means a plain click on the chip
   * never spawns a stray session.
   */
  let armed = false;
  let pressed = false;

  async function arm() {
    if (armed || !hasTauri()) return;
    armed = true;
    try {
      await invoke<string>('permission_guide_begin_drag');
      dragFailed = false;
    } catch (err) {
      console.error('permission_guide_begin_drag failed:', err);
      armed = false;
      // Never leave a chip that silently does nothing: surface the copy-path
      // route instead, which always works.
      dragFailed = true;
    }
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    if (!hasTauri()) return;
    void invoke('permission_guide_cancel_drag').catch((err) =>
      console.error('permission_guide_cancel_drag failed:', err),
    );
  }

  /**
   * Arm on hover, not on press.
   *
   * Arming costs one IPC round-trip plus a main-thread hop. Done on
   * `pointerdown`, a quick press-and-flick — exactly the gesture someone makes
   * when dragging toward another window — can be over before the monitor
   * exists, and the user sees the old do-nothing symptom intermittently.
   * Hovering gives Rust the head start, and you cannot press elsewhere in the
   * panel while the pointer is over the chip, so nothing else can trip it.
   */
  function onChipEnter() {
    void arm();
  }

  function onChipDown(event: PointerEvent) {
    if (event.button !== 0) return;
    pressed = true;
    // Belt and braces if the hover never fired (keyboard-driven pointer,
    // pointer warped onto the chip).
    void arm();
    // Deliberately NO setPointerCapture: on a successful drag AppKit owns the
    // mouse, so the webview never sees pointerup — a captured pointer would
    // stay captured and swallow clicks meant for the panel's other buttons.
    // Rust's own monitor stands the drag down on the real mouse-up.
  }

  function onChipUp() {
    pressed = false;
  }

  function onChipLeave() {
    // A drag in flight is AppKit's now, and its monitor disarms itself on
    // mouse-up; only an un-pressed pointer leaving means "not dragging after
    // all".
    if (!pressed) disarm();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void dismiss();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div
  class="guide"
  class:entered
  tabindex="-1"
  role="dialog"
  aria-modal="true"
  aria-labelledby="guide-title"
>
  <header class="guide-head">
    <span class="eyebrow">Screen Recording</span>
    <button class="close" type="button" onclick={dismiss} aria-label="Close">×</button>
  </header>

  <h1 id="guide-title">Let HQ see your screen</h1>
  <p class="lede">
    Capture needs macOS Screen Recording access. It takes one drag — HQ picks your capture back up
    the moment it lands.
  </p>

  {#if !willReprompt}
    <p class="no-reprompt" data-testid="no-reprompt">
      macOS only asks once, and it already has — so it will not ask again. Adding HQ to the list
      yourself is the only way through.
    </p>
  {/if}

  <ol class="steps">
    <li>
      <span class="step-n">1</span>
      <div>
        <p class="step-t">Open the Screen Recording list</p>
        <button class="action" type="button" onclick={openSettings}>Open System Settings</button>
        {#if openFailed}
          <p class="err" data-testid="open-failed">
            Could not open System Settings. Open it manually: Privacy &amp; Security › Screen
            Recording.
          </p>
        {/if}
      </div>
    </li>
    <li>
      <span class="step-n">2</span>
      <div>
        <p class="step-t">Drag {grantName} into that list</p>
        <p class="step-sub stale" data-testid="stale-entry">
          If {grantName} is <em>already</em> in that list, select it and press the &minus; (remove)
          button first, then drag it back in. macOS remembers the exact copy each entry was added
          from; once that no longer matches, dropping a newer copy onto the existing entry changes
          nothing — the switch keeps reading on while access stays denied.
        </p>
        <div
          class="chip"
          data-testid="drag-source"
          role="button"
          tabindex="0"
          aria-label={`Drag ${grantName} into the Screen Recording list, or press Enter to copy its path`}
          onpointerenter={onChipEnter}
          onpointerdown={onChipDown}
          onpointerup={onChipUp}
          onpointercancel={onChipUp}
          onpointerleave={onChipLeave}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void copyPath();
            }
          }}
        >
          <span class="chip-icon" aria-hidden="true">◧</span>
          <span class="chip-name">{grantName}</span>
        </div>
        {#if dragFailed}
          <p class="err" data-testid="drag-failed">
            Dragging isn't available right now — use the path below instead.
          </p>
        {/if}
        <div class="fallback">
          <button class="link" type="button" onclick={copyPath} data-testid="copy-path">
            {copied ? 'Path copied' : "Can't drag? Copy the path"}
          </button>
          {#if grantPath}
            <code class="path" data-testid="grant-path">{grantPath}</code>
          {/if}
          {#if copyFailed}
            <p class="err" data-testid="copy-failed">
              Clipboard was blocked — select the path above and copy it manually.
            </p>
          {/if}
        </div>
      </div>
    </li>
    <li>
      <span class="step-n">3</span>
      <div>
        <p class="step-t">That's it</p>
        <p class="step-sub">
          HQ is watching for the switch. The capture you just tried resumes on its own — no second
          chord.
        </p>
      </div>
    </li>
  </ol>

  <footer>
    <button class="link quiet" type="button" onclick={dismiss}>Not now</button>
    <span class="hint">Esc to close</span>
  </footer>
</div>

<style>
  :global(html[data-window='permission-guide']),
  :global(html[data-window='permission-guide'] body) {
    margin: 0;
    background: transparent !important;
    overflow: hidden;
  }

  .guide {
    width: 356px;
    box-sizing: border-box;
    padding: 16px 18px 14px;
    background: #141419;
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 22px 54px rgba(0, 0, 0, 0.6);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #fff;
    outline: none;
    /* Purposeful entrance: the panel arrives from the edge it is anchored to,
       once, then holds still. No looping animation. */
    opacity: 0;
    transform: translateY(-6px);
    transition:
      opacity 180ms ease-out,
      transform 180ms ease-out;
  }

  .guide.entered {
    opacity: 1;
    transform: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .guide {
      transition: none;
      opacity: 1;
      transform: none;
    }
  }

  .guide-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .eyebrow {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.5);
  }

  .close {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.5);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 4px;
  }

  .close:hover,
  .close:focus-visible {
    color: #fff;
  }

  h1 {
    font-size: 15px;
    font-weight: 600;
    margin: 10px 0 6px;
  }

  .lede {
    font-size: 12px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.68);
    margin: 0;
  }

  .no-reprompt {
    font-size: 11.5px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.72);
    margin: 10px 0 0;
    padding: 8px 10px;
    border-left: 2px solid #818cf8;
    background: rgba(129, 140, 248, 0.09);
  }

  .steps {
    list-style: none;
    margin: 14px 0 12px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .steps li {
    display: flex;
    gap: 10px;
  }

  .step-n {
    flex: none;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    display: grid;
    place-items: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    color: #818cf8;
    border: 1px solid rgba(129, 140, 248, 0.45);
  }

  .step-t {
    font-size: 12.5px;
    margin: 0 0 6px;
  }

  .step-sub {
    font-size: 11.5px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.6);
    margin: 0;
  }

  /* Must follow .step-sub and carry higher specificity: .step-sub sets
     `margin: 0`, and an equal-specificity `.stale` would be overridden. */
  .step-sub.stale {
    margin-bottom: 10px;
  }

  .action {
    font-size: 11.5px;
    color: #fff;
    background: rgba(129, 140, 248, 0.18);
    border: 1px solid rgba(129, 140, 248, 0.5);
    padding: 5px 10px;
    cursor: pointer;
  }

  .action:hover,
  .action:focus-visible {
    background: rgba(129, 140, 248, 0.3);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 11px;
    background: linear-gradient(140deg, #23202e, #191a22);
    border: 1px solid rgba(129, 140, 248, 0.42);
    cursor: grab;
    user-select: none;
  }

  .chip:focus-visible {
    outline: 2px solid #818cf8;
    outline-offset: 2px;
  }

  .chip-icon {
    font-size: 15px;
    color: #818cf8;
  }

  .chip-name {
    font-size: 12px;
  }

  .fallback {
    margin-top: 8px;
  }

  .link {
    background: none;
    border: none;
    padding: 0;
    font-size: 11px;
    color: #818cf8;
    cursor: pointer;
    text-align: left;
  }

  .link:hover,
  .link:focus-visible {
    text-decoration: underline;
  }

  .link.quiet {
    color: rgba(255, 255, 255, 0.5);
  }

  .path {
    display: block;
    margin-top: 5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.55);
    word-break: break-all;
    user-select: text;
  }

  .err {
    font-size: 11px;
    line-height: 1.45;
    color: #f87171;
    margin: 6px 0 0;
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .hint {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.38);
  }
</style>
