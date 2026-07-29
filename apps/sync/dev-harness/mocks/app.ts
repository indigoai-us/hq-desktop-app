// Mock of @tauri-apps/api/app for the preview harness.
export async function getVersion(): Promise<string> {
  return __APP_VERSION__;
}

export async function getName(): Promise<string> {
  return 'HQ';
}
