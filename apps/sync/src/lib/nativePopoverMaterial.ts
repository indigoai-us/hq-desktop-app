const MACOS_USER_AGENT = /Macintosh|Mac OS X/i;
const WINDOWS_USER_AGENT = /Windows/i;

/**
 * Native transparency is installed only on platforms with a corresponding
 * native material implementation. Linux Tauri windows retain the CSS
 * backdrop-filter fallback instead of becoming opaque.
 */
export function shouldUseNativePopoverMaterial(
  isTauriRuntime: boolean,
  userAgent: string,
): boolean {
  return (
    isTauriRuntime &&
    (MACOS_USER_AGENT.test(userAgent) || WINDOWS_USER_AGENT.test(userAgent))
  );
}
