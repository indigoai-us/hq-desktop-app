import { describe, expect, it } from 'vitest';
import { createDesktopAltHarness } from './live-driver';

describe('desktop-alt window lifecycle', () => {
  it('opens independently, closes without killing the popover or tray, and reopens', async () => {
    const app = await createDesktopAltHarness('qa@getindigo.ai');

    try {
      // The desktop window is only reachable for a signed-in user. In scripted
      // mode this mirrors the Rust gate; in live mode it IS the Rust gate,
      // asked of the running app — so a red here names the auth gate that
      // `openDesktopAltWindow` below would hit anyway, rather than a selector
      // that no longer exists in the product.
      expect((await app.bootApp()).desktopAltEnabled).toBe(true);

      const firstWindow = await app.openDesktopAltWindow();
      expect(firstWindow.created).toBe(true);
      expect(await app.snapshot()).toMatchObject({
        popoverAlive: true,
        trayAlive: true,
        desktopAltWindow: { id: firstWindow.id, focused: true },
      });

      await app.closeDesktopAltWindow();
      expect(await app.snapshot()).toEqual({
        popoverAlive: true,
        trayAlive: true,
        desktopAltWindow: null,
      });

      const reopenedWindow = await app.openDesktopAltWindow();
      expect(reopenedWindow.created).toBe(true);
      expect(reopenedWindow.id).not.toBe(firstWindow.id);
      expect(await app.snapshot()).toMatchObject({
        popoverAlive: true,
        trayAlive: true,
        desktopAltWindow: { id: reopenedWindow.id, focused: true },
      });
    } finally {
      await app.dispose?.();
    }
  });

  it('focuses an existing desktop-alt window when the toggle is clicked again', async () => {
    const app = await createDesktopAltHarness('qa@getindigo.ai');

    try {
      const firstWindow = await app.openDesktopAltWindow();
      const focusedWindow = await app.openDesktopAltWindow();

      expect(focusedWindow.created).toBe(false);
      expect(focusedWindow.id).toBe(firstWindow.id);
      expect(focusedWindow.focused).toBe(true);
    } finally {
      await app.dispose?.();
    }
  });
});
