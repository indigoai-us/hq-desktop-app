/**
 * External-link handoff for the desktop shell and message bodies.
 *
 * Only credential-free http(s) and mailto URLs leave the webview. Relative
 * hrefs, javascript:/data:/file: schemes, and credentialed URLs are ignored
 * so a message or shell anchor cannot navigate the webview or launch a
 * local app.
 */
import { safeHref } from "./markdown.js";

export type LinkMenuAnchor = { href: string; x: number; y: number };

export type LinkActivateMode = "message" | "shell";

const MENU_WIDTH_PX = 180;
const MENU_HEIGHT_PX = 88;

/** True when the native copy/paste menu must stay available. */
export function isNativeEditingTarget(node: EventTarget | null): boolean {
  const el =
    node instanceof Element
      ? node
      : node instanceof Node
        ? node.parentElement
        : null;
  return Boolean(
    el?.closest("input, textarea, select, [contenteditable='true']"),
  );
}

export function closestHrefAnchor(
  node: EventTarget | null,
): HTMLAnchorElement | null {
  const el =
    node instanceof Element
      ? node
      : node instanceof Node
        ? node.parentElement
        : null;
  return el?.closest("a[href]") ?? null;
}

/**
 * Return a URL that may be handed to the host opener, or null.
 * Relative links stay in-document; only http(s)/mailto leave the app.
 */
export function externalHref(raw: string | null | undefined): string | null {
  const href = safeHref((raw ?? "").trim());
  if (!href) return null;
  if (!/^(https?:|mailto:)/i.test(href)) return null;
  try {
    const parsed = new URL(href);
    if (parsed.username || parsed.password) return null;
    return href;
  } catch {
    return null;
  }
}

export function openExternalHref(
  raw: string,
  onopenurl?: (url: string) => void,
): boolean {
  const href = externalHref(raw);
  if (!href) return false;
  if (onopenurl) onopenurl(href);
  else if (typeof window !== "undefined") {
    window.open(href, "_blank", "noopener,noreferrer");
  }
  return true;
}

export async function copyLinkHref(href: string): Promise<void> {
  await navigator.clipboard.writeText(href);
}

function clampMenuPosition(x: number, y: number): { x: number; y: number } {
  const width =
    typeof window === "undefined" ? MENU_WIDTH_PX : window.innerWidth;
  const height =
    typeof window === "undefined" ? MENU_HEIGHT_PX : window.innerHeight;
  return {
    x: Math.max(0, Math.min(x, width - MENU_WIDTH_PX)),
    y: Math.max(0, Math.min(y, height - MENU_HEIGHT_PX)),
  };
}

function hasNamedScheme(raw: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(raw.trim());
}

/**
 * Handle click / auxclick / contextmenu / keyboard activate on an `<a href>`.
 *
 * `message` mode opens on every non-right click (existing bubble behavior).
 * `shell` mode only intercepts middle-click, cmd/ctrl-click, and the custom
 * context menu so in-app anchors keep working.
 *
 * Returns true when the event was consumed.
 */
export function handleLinkActivate(
  event: Event,
  opts: {
    onopenurl?: (url: string) => void;
    onmenu?: (menu: LinkMenuAnchor) => void;
    mode?: LinkActivateMode;
  } = {},
): boolean {
  if (event.defaultPrevented) return false;
  if (isNativeEditingTarget(event.target)) return false;
  const root = event.currentTarget;
  if (!(root instanceof Element)) return false;
  const anchor = closestHrefAnchor(event.target);
  if (!anchor || !root.contains(anchor)) return false;

  const raw = anchor.getAttribute("href") ?? "";
  const href = externalHref(raw);
  const mode = opts.mode ?? "message";

  if (event instanceof KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (href) openExternalHref(href, opts.onopenurl);
    return true;
  }

  if (!(event instanceof MouseEvent)) return false;

  if (event.type === "contextmenu") {
    if (href) {
      event.preventDefault();
      event.stopPropagation();
      const pos = clampMenuPosition(event.clientX, event.clientY);
      opts.onmenu?.({ href, ...pos });
      return true;
    }
    if (hasNamedScheme(raw)) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  }

  if (event.button === 2) return false;
  const middle = event.button === 1 || event.type === "auxclick";
  if (event.type === "auxclick" && event.button !== 1) return false;
  const modified = event.metaKey || event.ctrlKey;
  if (mode === "shell" && !middle && !modified) return false;

  event.preventDefault();
  event.stopPropagation();
  if (href) openExternalHref(href, opts.onopenurl);
  return true;
}
