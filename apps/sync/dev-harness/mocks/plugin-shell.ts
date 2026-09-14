// Mock of @tauri-apps/plugin-shell for the preview harness.
//
// Every target is also recorded on `window.__harnessShellOpens`, so browser e2e
// can assert exactly what the app asked the OS to open.
export async function open(target: string): Promise<void> {
  console.debug('[harness] shell.open:', target);
  if (typeof window !== 'undefined') {
    const w = window as Window & { __harnessShellOpens?: string[] };
    (w.__harnessShellOpens ??= []).push(target);
  }
}
