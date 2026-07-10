import { describe, expect, it } from 'vitest';
import {
  WIDGET_ROW_TIMEOUT_MS,
  WIDGET_STACK_MAX,
  addItem,
  bannerToStackItem,
  emptyWidgetStack,
  setOccluded,
  type WidgetStackItem,
} from '../../src/stores/widgetNotifications';
import { readRepoFile } from './harness';

/**
 * US-006 — Widget core lifecycle (source contracts + pure stack reducers).
 *
 * Locks the rendered/runtime contracts that headless e2e cannot drive on a
 * real NSWindow:
 *  1. Widget appears on launch, default ON (setup in main.rs `.setup()`,
 *     `widget_enabled()` defaults true, capabilities grant the window).
 *  2. Notification takeover suppresses the native banner and every native
 *     notify path checks `takeover_active`.
 *  3. One-line stack: queue-on-occlusion, flush on return with refreshed
 *     `expiresAt`, max-trim (behavioral via pure reducers) + Rust occlusion
 *     / emit plumbing markers.
 *  4. Queued superscript is a plain count (no badge chrome).
 *  5. Toggle-off closes the window; `takeover_active` re-reads menubar.json
 *     so the next notification goes native.
 */

function item(overrides: Partial<WidgetStackItem> & Pick<WidgetStackItem, 'id'>): WidgetStackItem {
  return {
    type: 'system',
    text: 'hello',
    ts: 1_000,
    kind: 'update',
    clickActionId: 'open',
    data: null,
    expiresAt: 1_000 + WIDGET_ROW_TIMEOUT_MS,
    ...overrides,
  };
}

describe('US-006: widget lifecycle — appears on launch, default ON', () => {
  const main = readRepoFile('src-tauri/src/main.rs');
  const widget = readRepoFile('src-tauri/src/commands/widget.rs');
  const capabilities = readRepoFile('src-tauri/capabilities/widget.json');

  it('main.rs .setup() creates the widget window', () => {
    expect(main).toContain('commands::widget::setup_widget_window(app.handle())');
  });

  it('widget_enabled reads widgetEnabled from menubar.json and defaults true', () => {
    expect(widget).toContain('fn widget_enabled() -> bool');
    expect(widget).toContain('widgetEnabled');
    expect(widget).toContain('.unwrap_or(true)');
  });

  it('WINDOW_LABEL is "widget" and setup no-ops when disabled', () => {
    expect(widget).toContain('pub const WINDOW_LABEL: &str = "widget"');
    expect(widget).toContain('pub fn setup_widget_window(app: &AppHandle)');
    expect(widget).toContain('if !widget_enabled()');
    expect(widget).toContain('setup: widgetEnabled=false — skipping');
  });

  it('capabilities/widget.json exists and grants the widget window core permissions', () => {
    expect(capabilities).toContain('"identifier": "widget"');
    expect(capabilities).toContain('"windows": ["widget"]');
    expect(capabilities).toContain('core:default');
    expect(capabilities).toContain('core:event:default');
  });
});

describe('US-006: notification takeover — no native banner', () => {
  const banner = readRepoFile('src-tauri/src/commands/banner.rs');
  const widget = readRepoFile('src-tauri/src/commands/widget.rs');
  const dm = readRepoFile('src-tauri/src/commands/dm_notify.rs');
  const share = readRepoFile('src-tauri/src/commands/share_notify.rs');
  const meetings = readRepoFile('src-tauri/src/commands/meetings.rs');
  const updater = readRepoFile('src-tauri/src/updater.rs');

  it('show_banner routes to the widget stack when takeover_active', () => {
    expect(banner).toContain('if crate::commands::widget::takeover_active(&app)');
    expect(banner).toContain(
      'return crate::commands::widget::show_widget_notification(app, payload).await',
    );
  });

  it('takeover_active is widget_enabled && widget window exists (fresh menubar read)', () => {
    expect(widget).toContain('pub fn takeover_active(app: &AppHandle) -> bool');
    expect(widget).toContain(
      'widget_enabled() && app.get_webview_window(WINDOW_LABEL).is_some()',
    );
    // Fresh menubar.json each call so disable instantly restores native.
    expect(widget).toContain('Reads menubar.json');
    expect(widget).toContain('FRESH each call');
    expect(widget).toContain('instantly restores native notifications');
  });

  it('native notify paths gate on takeover_active', () => {
    expect(dm).toContain('|| crate::commands::widget::takeover_active(app)');
    expect(share).toContain('|| crate::commands::widget::takeover_active(app)');
    expect(meetings).toContain('|| crate::commands::widget::takeover_active(&app)');
    expect(updater).toContain('|| crate::commands::widget::takeover_active(&app)');
    expect(updater).toContain('|| crate::commands::widget::takeover_active(&handle)');
  });
});

describe('US-006: one-line stack — queue-on-occlusion, flush on return (behavioral)', () => {
  const widget = readRepoFile('src-tauri/src/commands/widget.rs');

  it('notification arrives while visible → newest-first in visible', () => {
    let state = emptyWidgetStack();
    state = addItem(state, item({ id: 'a', text: 'a' }));
    state = addItem(state, item({ id: 'b', text: 'b' }));
    expect(state.occluded).toBe(false);
    expect(state.visible.map((v) => v.id)).toEqual(['b', 'a']);
    expect(state.queued).toEqual([]);
  });

  it('while occluded → queued newest-first; visible untouched', () => {
    let state = addItem(emptyWidgetStack(), item({ id: 'vis', text: 'already shown' }));
    state = setOccluded(state, true, 0);
    const visibleBefore = state.visible.map((v) => v.id);
    state = addItem(state, item({ id: 'q1', text: 'q1' }));
    state = addItem(state, item({ id: 'q2', text: 'q2' }));
    expect(state.visible.map((v) => v.id)).toEqual(visibleBefore);
    expect(state.queued.map((q) => q.id)).toEqual(['q2', 'q1']);
  });

  it('occluded→visible flush moves queued into visible newest-on-top, trims, refreshes expiresAt', () => {
    let state = setOccluded(emptyWidgetStack(), true, 0);
    // Seed more than max so flush must trim.
    for (let i = 0; i < WIDGET_STACK_MAX + 2; i += 1) {
      state = addItem(
        state,
        item({
          id: `q${i}`,
          text: `${i}`,
          expiresAt: 1, // stale — flush must refresh
        }),
      );
    }
    expect(state.visible).toEqual([]);
    expect(state.queued).toHaveLength(WIDGET_STACK_MAX + 2);

    const now = 50_000;
    state = setOccluded(state, false, now);
    expect(state.occluded).toBe(false);
    expect(state.queued).toEqual([]);
    // Newest-first among queued was q{MAX+1} … q0; flush keeps that order, trims to max.
    expect(state.visible.map((v) => v.id)).toEqual(
      Array.from({ length: WIDGET_STACK_MAX }, (_, i) => `q${WIDGET_STACK_MAX + 1 - i}`),
    );
    expect(state.visible.every((v) => v.expiresAt === now + WIDGET_ROW_TIMEOUT_MS)).toBe(true);
  });

  it('already-clear setOccluded(false) is a no-op flush (queued stays put)', () => {
    let state = addItem(emptyWidgetStack(), item({ id: 'v', text: 'v' }));
    state = {
      ...state,
      queued: [item({ id: 'stray', text: 'should not flush when already clear' })],
    };
    const next = setOccluded(state, false, 99_000);
    expect(next.occluded).toBe(false);
    expect(next.visible.map((v) => v.id)).toEqual(['v']);
    expect(next.queued.map((q) => q.id)).toEqual(['stray']);
    // expiresAt not refreshed on the already-clear path.
    expect(next.visible[0]?.expiresAt).toBe(state.visible[0]?.expiresAt);
  });

  it('bannerToStackItem maps payloads into stack rows with full display timeout', () => {
    const mapped = bannerToStackItem(
      {
        kind: 'dm',
        title: 'Corey',
        body: 'ship it',
        clickActionId: 'open',
        data: null,
      },
      5_000,
      'n1',
    );
    expect(mapped).toMatchObject({
      id: 'n1',
      type: 'message',
      actor: 'Corey',
      text: 'ship it',
      expiresAt: 5_000 + WIDGET_ROW_TIMEOUT_MS,
    });
  });

  it('Rust occlusion plumbing: NSWindow notification + widget:occlusion / widget:notification emits', () => {
    expect(widget).toContain('NSWindowDidChangeOcclusionStateNotification');
    expect(widget).toContain('"widget:occlusion"');
    expect(widget).toContain('app.emit_to(WINDOW_LABEL, "widget:notification"');
  });
});

describe('US-006: queued superscript indicator', () => {
  const widgetUi = readRepoFile('src/components/Widget.svelte');

  it('renders a plain superscript count with no badge chrome', () => {
    expect(widgetUi).toContain('<span class="qd">{queuedCount}</span>');
    expect(widgetUi).toContain('Plain superscript — no background, border, or border-radius');
  });
});

describe('US-006: toggle-off restores native + closes window', () => {
  const widget = readRepoFile('src-tauri/src/commands/widget.rs');
  const settings = readRepoFile('src/components/WidgetSettings.svelte');

  it('apply_widget_settings closes the widget window on disable', () => {
    expect(widget).toContain('pub async fn apply_widget_settings');
    expect(widget).toContain('fn apply_widget_settings_on_main');
    expect(widget).toContain('apply_widget_settings: disabled — window closed');
    expect(widget).toContain('match window.close()');
    // Instant restore contract: after close, takeover_active is false.
    expect(widget).toContain('After close, takeover_active() is false');
    expect(widget).toContain('next notification goes native');
  });

  it('WidgetSettings invokes apply_widget_settings after save', () => {
    expect(settings).toContain("invoke('apply_widget_settings')");
  });
});
