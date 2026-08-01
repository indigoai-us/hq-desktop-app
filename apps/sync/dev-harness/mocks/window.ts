// Mock of @tauri-apps/api/window for the preview harness.
// The window label is selectable via `?window=<label>` so design work can
// preview any window (e.g. `?window=messages`) — defaults to the popover.
const previewLabel =
  (typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('window')) ||
  'main';

export class LogicalSize {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

export async function currentMonitor() {
  return {
    size: { width: 1440, height: 900 },
    scaleFactor: 1,
    position: { x: 0, y: 0 },
  };
}

export function getCurrentWindow() {
  return {
    label: previewLabel,
    async setSize() {},
    async listen() {
      return () => {};
    },
    async onFocusChanged() {
      return () => {};
    },
    async show() {},
    async hide() {},
    async setFocus() {},
    async close() {},
    async isVisible() {
      return true;
    },
  };
}
