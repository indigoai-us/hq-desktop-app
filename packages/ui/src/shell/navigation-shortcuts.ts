/**
 * Shared in-app Back/Forward keyboard resolver (US-003).
 *
 * macOS: Cmd+[ / Cmd+]
 * Windows: Alt+Left / Alt+Right
 *
 * This is not `window.history` and not browser-native Backspace. Shortcuts
 * are never stolen from text editing, IME composition, or a focused
 * embedded web editor that handles them.
 */

export type NavigationShortcut = "back" | "forward";

export type NavigationShortcutPlatform = "macos" | "windows";

export interface NavigationShortcutEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
  defaultPrevented: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target: EventTarget | null;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

const EMBEDDED_EDITOR_SELECTOR = [
  "iframe",
  "webview",
  "[data-embedded-editor]",
  ".monaco-editor",
  ".cm-editor",
  ".cm-content",
  ".ProseMirror",
  "[data-slate-editor]",
].join(", ");

export function detectNavigationShortcutPlatform(
  hint?: string | null,
): NavigationShortcutPlatform {
  const sources = [
    hint,
    typeof document !== "undefined"
      ? document.documentElement.getAttribute("data-platform")
      : null,
    typeof navigator !== "undefined"
      ? `${navigator.platform} ${navigator.userAgent}`
      : null,
  ];
  const blob = sources.filter(Boolean).join(" ").toLowerCase();
  if (/\bwin/.test(blob)) return "windows";
  return "macos";
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return Boolean(
    el.closest(
      "input, textarea, select, [contenteditable='true'], [contenteditable=''], [role='textbox']",
    ),
  );
}

export function isEmbeddedEditorTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false;
  return Boolean(target.closest(EMBEDDED_EDITOR_SELECTOR));
}

export function isNavigationShortcutBlocked(
  event: NavigationShortcutEvent,
): boolean {
  if (event.defaultPrevented) return true;
  if (event.isComposing || event.key === "Process" || event.keyCode === 229) {
    return true;
  }
  if (isEditableKeyboardTarget(event.target)) return true;
  if (isEmbeddedEditorTarget(event.target)) return true;
  return false;
}

function isBracket(event: NavigationShortcutEvent, side: "left" | "right"): boolean {
  if (side === "left") {
    return event.key === "[" || event.code === "BracketLeft";
  }
  return event.key === "]" || event.code === "BracketRight";
}

export function resolveNavigationShortcut(
  event: NavigationShortcutEvent,
  platform: NavigationShortcutPlatform = detectNavigationShortcutPlatform(),
): NavigationShortcut | null {
  if (isNavigationShortcutBlocked(event)) return null;
  if (event.shiftKey) return null;

  if (platform === "macos") {
    if (!event.metaKey || event.ctrlKey || event.altKey) return null;
    if (isBracket(event, "left")) return "back";
    if (isBracket(event, "right")) return "forward";
    return null;
  }

  if (!event.altKey || event.metaKey || event.ctrlKey) return null;
  if (event.key === "ArrowLeft") return "back";
  if (event.key === "ArrowRight") return "forward";
  return null;
}

/**
 * Consume a matching Back/Forward shortcut: preventDefault so the webview
 * does not use `window.history`, then invoke the handler.
 */
export function consumeNavigationShortcut(
  event: NavigationShortcutEvent,
  handlers: {
    platform?: NavigationShortcutPlatform;
    onBack: () => void;
    onForward: () => void;
  },
): boolean {
  const shortcut = resolveNavigationShortcut(
    event,
    handlers.platform ?? detectNavigationShortcutPlatform(),
  );
  if (!shortcut) return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  if (shortcut === "back") handlers.onBack();
  else handlers.onForward();
  return true;
}
