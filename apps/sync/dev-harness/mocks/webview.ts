// Mock of @tauri-apps/api/webview for the browser-only visual harness.
export function getCurrentWebview() {
  return {
    async setZoom() {},
  };
}
