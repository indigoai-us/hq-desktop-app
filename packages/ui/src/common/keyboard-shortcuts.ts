/**
 * App-wide keyboard-shortcut registry.
 *
 * One capture-phase `keydown` listener on `window` is attached by the first
 * `registerShortcuts` call and detached by the last unregister. Bindings use a
 * small "Mod+Shift+]" grammar: `Mod` is ⌘ on macOS and Ctrl elsewhere; the
 * modifier set must match EXACTLY (so "Mod+K" does not fire on ⌘⇧K).
 *
 * Bindings skip editable targets (inputs, textareas, selects, contenteditable)
 * unless `allowInInput` is set, honour `event.defaultPrevented`, and call
 * `preventDefault()` when they match. Native menu accelerators route through
 * `runShortcut(id)` so a menu item and its key binding share one handler.
 */

import { isMac } from "./platform";

export interface ShortcutBinding {
  /** Stable id, e.g. "conversation.next". Also the native-menu payload id. */
  id: string;
  /** "Mod+Shift+]" grammar. Segments: Mod | Ctrl | Alt | Shift | Meta + key. */
  keys: string;
  /** Human label for the cheat sheet and menus. */
  label: string;
  /** Cheat-sheet group heading, e.g. "Navigation". */
  group: string;
  /** Fire even when focus is in an editable field. Default false. */
  allowInInput?: boolean;
  /**
   * Return `false` to decline the event (it propagates untouched). Any other
   * result — including `undefined` — counts as handled.
   */
  run: (event: KeyboardEvent | null) => void | boolean;
}

interface ParsedKeys {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

/** True when focus sits in a field that should keep plain keystrokes. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return Boolean(el.closest("[contenteditable='true']"));
}

/** `event.code` → the key our grammar uses, for keys WebKit reports shifted. */
const CODE_TO_KEY: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Slash: "/",
  Comma: ",",
  Period: ".",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

function normalizeKeyName(key: string): string {
  const k = key.trim();
  if (k.length === 1) return k.toLowerCase();
  const lower = k.toLowerCase();
  if (lower === "esc") return "escape";
  if (lower === "space") return " ";
  if (lower === "return") return "enter";
  return lower;
}

export function parseKeys(keys: string): ParsedKeys {
  const parts = keys.split("+").map((p) => p.trim());
  const parsed: ParsedKeys = {
    mod: false,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key: "",
  };
  // "Mod++" (a literal plus) is not needed today; keep the grammar simple.
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const last = i === parts.length - 1;
    const lower = part.toLowerCase();
    if (!last && lower === "mod") parsed.mod = true;
    else if (!last && (lower === "ctrl" || lower === "control")) parsed.ctrl = true;
    else if (!last && (lower === "alt" || lower === "option")) parsed.alt = true;
    else if (!last && lower === "shift") parsed.shift = true;
    else if (!last && (lower === "meta" || lower === "cmd" || lower === "command"))
      parsed.meta = true;
    else parsed.key = normalizeKeyName(part);
  }
  return parsed;
}

/** Effective (platform-resolved) modifier flags for a parsed binding. */
function resolvedModifiers(
  parsed: ParsedKeys,
  mac: boolean,
): { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean } {
  return {
    ctrl: parsed.ctrl || (parsed.mod && !mac),
    alt: parsed.alt,
    shift: parsed.shift,
    meta: parsed.meta || (parsed.mod && mac),
  };
}

/** Key name derived from the event, preferring `code` for punctuation. */
function eventKeyName(event: KeyboardEvent): string {
  const fromCode = event.code ? CODE_TO_KEY[event.code] : undefined;
  if (fromCode) return fromCode;
  // Digit1..Digit9 keep working with Shift/Alt held (e.g. Alt+3 → "£").
  if (event.code && /^Digit\d$/.test(event.code)) return event.code.slice(5);
  return normalizeKeyName(event.key ?? "");
}

/** True when `event` matches the binding's key + exact modifier set. */
export function matchesShortcut(
  keys: string,
  event: KeyboardEvent,
  mac: boolean = isMac(),
): boolean {
  const parsed = parseKeys(keys);
  if (!parsed.key) return false;
  const want = resolvedModifiers(parsed, mac);
  if (
    Boolean(event.metaKey) !== want.meta ||
    Boolean(event.ctrlKey) !== want.ctrl ||
    Boolean(event.altKey) !== want.alt ||
    Boolean(event.shiftKey) !== want.shift
  )
    return false;
  if (eventKeyName(event) === parsed.key) return true;
  // WebKit may report "{" / "}" for shifted brackets; `code` already covers
  // that above, but fall back to the raw key for synthetic events.
  const raw = normalizeKeyName(event.key ?? "");
  if (raw === "{" && parsed.key === "[") return true;
  if (raw === "}" && parsed.key === "]") return true;
  return false;
}

const MAC_GLYPHS: Record<string, string> = {
  mod: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};

const KEY_GLYPHS: Record<string, string> = {
  escape: "Esc",
  enter: "↩",
  backspace: "⌫",
  delete: "⌦",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  tab: "⇥",
  " ": "Space",
};

/** "Mod+Shift+]" → "⌘⇧]" on macOS, "Ctrl+Shift+]" elsewhere. */
export function formatShortcut(keys: string, mac: boolean = isMac()): string {
  const parsed = parseKeys(keys);
  const keyLabel =
    KEY_GLYPHS[parsed.key] ??
    (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  if (mac) {
    let out = "";
    // House order: ⌃⌥⌘⇧ — the command glyph leads the shift glyph so palette
    // and cheat-sheet labels read "⌘⇧]" (matches the existing "⌘K" rows).
    if (parsed.ctrl) out += MAC_GLYPHS.ctrl;
    if (parsed.alt) out += MAC_GLYPHS.alt;
    if (parsed.mod || parsed.meta) out += MAC_GLYPHS.mod;
    if (parsed.shift) out += MAC_GLYPHS.shift;
    return out + keyLabel;
  }
  const parts: string[] = [];
  if (parsed.mod || parsed.ctrl) parts.push("Ctrl");
  if (parsed.meta) parts.push("Win");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(keyLabel);
  return parts.join("+");
}

// ── Registry ────────────────────────────────────────────────────────────────

const registrations: ShortcutBinding[][] = [];
let listening = false;

function allBindings(): ShortcutBinding[] {
  const out: ShortcutBinding[] = [];
  for (const group of registrations) out.push(...group);
  return out;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  const editable = isEditableTarget(event.target ?? null);
  // Later registrations win so a modal can shadow a shell binding.
  for (let g = registrations.length - 1; g >= 0; g -= 1) {
    for (const binding of registrations[g]) {
      if (editable && !binding.allowInInput) continue;
      if (!matchesShortcut(binding.keys, event)) continue;
      const result = binding.run(event);
      if (result === false) continue;
      event.preventDefault();
      return;
    }
  }
}

function attach(): void {
  if (listening || typeof window === "undefined") return;
  window.addEventListener("keydown", onKeydown, true);
  listening = true;
}

function detach(): void {
  if (!listening || typeof window === "undefined") return;
  window.removeEventListener("keydown", onKeydown, true);
  listening = false;
}

/**
 * Register a group of bindings. The first registration attaches the single
 * window listener; the returned function removes the group and detaches the
 * listener once no groups remain.
 */
export function registerShortcuts(bindings: ShortcutBinding[]): () => void {
  const group = [...bindings];
  registrations.push(group);
  attach();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = registrations.indexOf(group);
    if (index >= 0) registrations.splice(index, 1);
    if (registrations.length === 0) detach();
  };
}

/** Current bindings in registration order (for the cheat sheet). */
export function listShortcuts(): ShortcutBinding[] {
  return allBindings();
}

/**
 * Invoke a binding by id (native menu accelerators, tests). Later
 * registrations win, matching keyboard dispatch. Returns true when a binding
 * ran and did not decline.
 */
export function runShortcut(id: string): boolean {
  for (let g = registrations.length - 1; g >= 0; g -= 1) {
    for (const binding of registrations[g]) {
      if (binding.id !== id) continue;
      if (binding.run(null) === false) continue;
      return true;
    }
  }
  return false;
}

/** True while the shared listener is attached (test helper). */
export function hasShortcutListener(): boolean {
  return listening;
}
