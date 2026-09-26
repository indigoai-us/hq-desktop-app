// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  BOOT_WINDOW_MS,
  hasUnsentComposerText,
  installUiHotUpdates,
  reportUiBootFailure,
  signalUiBoot,
} from './ui-hot';

function makeInvoke(responses: Record<string, unknown> = {}) {
  return vi.fn(async (cmd: string) => responses[cmd] as never);
}

describe('ui-hot', () => {
  it('sends the boot beacon', () => {
    const invoke = makeInvoke();
    signalUiBoot(invoke);
    expect(invoke).toHaveBeenCalledWith('ui_hot_boot_ok');
  });

  it('reports a fatal error inside the boot window only', () => {
    const invoke = makeInvoke();
    expect(reportUiBootFailure(invoke, 'boom', 100)).toBe(true);
    expect(invoke).toHaveBeenCalledWith('ui_hot_boot_failed', { reason: 'boom' });
    invoke.mockClear();
    expect(reportUiBootFailure(invoke, 'late', BOOT_WINDOW_MS + 1)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('detects unsent composer text', () => {
    document.body.innerHTML = '<textarea></textarea><div contenteditable="true"></div>';
    expect(hasUnsentComposerText(document)).toBe(false);
    (document.querySelector('textarea') as HTMLTextAreaElement).value = 'draft';
    expect(hasUnsentComposerText(document)).toBe(true);
    (document.querySelector('textarea') as HTMLTextAreaElement).value = '';
    document.querySelector('[contenteditable]')!.textContent = 'typing';
    expect(hasUnsentComposerText(document)).toBe(true);
  });

  async function fire(callActive: boolean, draft: string) {
    document.body.innerHTML = `<textarea>${draft}</textarea>`;
    let handler: ((e: { payload: { uiVersion: string } }) => Promise<void> | void) | null = null;
    const listen = vi.fn(async (_event: string, h: never) => {
      handler = h;
      return () => undefined;
    });
    const invoke = makeInvoke({ ui_hot_call_active: callActive });
    await installUiHotUpdates(invoke, listen as never, document);
    expect(listen).toHaveBeenCalledWith('ui-hot:updated', expect.any(Function));
    await handler!({ payload: { uiVersion: '0.10.330+ui.2' } });
    return invoke;
  }

  it('auto-reloads when idle', async () => {
    const invoke = await fire(false, '');
    expect(invoke).toHaveBeenCalledWith('ui_hot_reload');
    expect(document.getElementById('hq-ui-hot-toast')).toBeNull();
  });

  it('shows the toast instead of reloading while a draft exists', async () => {
    const invoke = await fire(false, 'unsent');
    expect(invoke).not.toHaveBeenCalledWith('ui_hot_reload');
    const toast = document.getElementById('hq-ui-hot-toast')!;
    expect(toast.textContent).toContain('Interface updated');
    (toast.querySelector('button') as HTMLButtonElement).click();
    expect(invoke).toHaveBeenCalledWith('ui_hot_reload');
  });

  it('shows the toast instead of reloading during a call', async () => {
    const invoke = await fire(true, '');
    expect(invoke).not.toHaveBeenCalledWith('ui_hot_reload');
    expect(document.getElementById('hq-ui-hot-toast')).not.toBeNull();
  });
});
