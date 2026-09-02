/**
 * Start a Tauri window drag from overlay chrome (titlebar / sub-page header).
 *
 * `data-tauri-drag-region` is the native path; this invoke covers WKWebView
 * hosts that swallow the region. Interactive controls must not start a drag.
 */

export function isWindowDragBlocker(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest("button, a, input, textarea, select, [data-no-drag]"),
    )
  );
}

export function startWindowDrag(event: PointerEvent): void {
  if (event.button !== 0 || isWindowDragBlocker(event.target)) return;
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: {
        invoke?: (
          cmd: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
        metadata?: { currentWindow?: { label?: string } };
      };
    }
  ).__TAURI_INTERNALS__;
  const label = internals?.metadata?.currentWindow?.label ?? "main";
  void internals?.invoke?.("plugin:window|start_dragging", { label });
}
