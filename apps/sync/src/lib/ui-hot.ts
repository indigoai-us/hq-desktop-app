// UI hot updates, interface side (native side: src-tauri/src/ui_hot_update.rs;
// design: docs/RELEASE.md "UI hot updates").
//
// - Boot beacon: once a window has mounted, tell the native side this UI
//   booted, so a freshly applied hot bundle is confirmed good. A bundle that
//   never sends it (or reports a fatal boot error) is rolled back.
// - "Interface updated" toast: when a verified bundle has been applied in the
//   background, offer a reload. Reload automatically only when nothing would
//   be lost: no composer holds unsent text and no call is active.

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

/** A fatal error this soon after page load counts as a failed boot. */
export const BOOT_WINDOW_MS = 30_000;

export function signalUiBoot(invoke: Invoke): void {
  void invoke('ui_hot_boot_ok').catch(() => undefined);
}

export function reportUiBootFailure(
  invoke: Invoke,
  reason: string,
  sinceLoadMs: number = typeof performance !== 'undefined' ? performance.now() : 0,
): boolean {
  if (sinceLoadMs > BOOT_WINDOW_MS) return false;
  void invoke('ui_hot_boot_failed', { reason: reason.slice(0, 200) }).catch(() => undefined);
  return true;
}

/** True when any text field or editable region in `doc` holds unsent text. */
export function hasUnsentComposerText(doc: Document): boolean {
  for (const el of Array.from(doc.querySelectorAll('textarea, input[type="text"], input:not([type])'))) {
    const field = el as HTMLTextAreaElement | HTMLInputElement;
    if (field.value && field.value.trim().length > 0 && field.closest('[data-composer], form, .composer')) {
      return true;
    }
    if (el.tagName === 'TEXTAREA' && field.value.trim().length > 0) return true;
  }
  for (const el of Array.from(doc.querySelectorAll('[contenteditable="true"], [contenteditable=""]'))) {
    if ((el.textContent ?? '').trim().length > 0) return true;
  }
  return false;
}

export interface UiHotStatus {
  mode: 'off' | 'beta' | 'stable';
  appVersion: string;
  uiVersion: string;
  source: 'hot' | 'builtin';
  shellKey: string | null;
  pendingVersion: string | null;
}

export async function readUiHotStatus(invoke: Invoke): Promise<UiHotStatus | null> {
  try {
    return await invoke<UiHotStatus>('get_ui_hot_status');
  } catch {
    return null;
  }
}

const TOAST_ID = 'hq-ui-hot-toast';

function showToast(doc: Document, version: string, onReload: () => void): void {
  doc.getElementById(TOAST_ID)?.remove();
  const toast = doc.createElement('div');
  toast.id = TOAST_ID;
  toast.setAttribute('role', 'status');
  toast.dataset.uiVersion = version;
  toast.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483000',
    'display:flex', 'gap:12px', 'align-items:center', 'padding:10px 14px',
    'border-radius:10px', 'font:13px/1.3 system-ui,sans-serif',
    'background:rgba(30,30,34,.92)', 'color:#fff', 'box-shadow:0 6px 24px rgba(0,0,0,.25)',
  ].join(';');
  const label = doc.createElement('span');
  label.textContent = 'Interface updated';
  const reload = doc.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload';
  reload.style.cssText = 'background:none;border:0;color:#9cc3ff;font:inherit;cursor:pointer;padding:0';
  reload.addEventListener('click', onReload);
  const dismiss = doc.createElement('button');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  dismiss.style.cssText = 'background:none;border:0;color:#aaa;font:inherit;cursor:pointer;padding:0';
  dismiss.addEventListener('click', () => toast.remove());
  toast.append(label, reload, dismiss);
  doc.body.appendChild(toast);
}

/**
 * Listen for background-applied UI bundles. Auto-reloads when safe,
 * otherwise shows the quiet toast.
 */
export async function installUiHotUpdates(
  invoke: Invoke,
  listen: Listen,
  doc: Document = document,
): Promise<() => void> {
  const reload = () => void invoke('ui_hot_reload').catch(() => undefined);
  return listen<{ uiVersion: string }>('ui-hot:updated', async ({ payload }) => {
    const callActive = await invoke<boolean>('ui_hot_call_active').catch(() => true);
    if (!callActive && !hasUnsentComposerText(doc)) {
      reload();
      return;
    }
    showToast(doc, payload.uiVersion, reload);
  });
}
