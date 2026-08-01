// Mock of @tauri-apps/api/app for the preview harness.
export async function getVersion(): Promise<string> {
  return __APP_VERSION__;
}

export async function getName(): Promise<string> {
  return 'HQ';
}

export async function setTheme(_theme: 'light' | 'dark' | null): Promise<void> {
  // Browser previews have no native window theme to update. Keeping this mock
  // aligned with Tauri lets appearance-aware desktop routes render in QA.
}
