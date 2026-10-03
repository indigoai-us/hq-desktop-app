/**
 * Console-rail button icon registry (OWNER-007 / OWNER-008).
 *
 * Every labelled console-rail button names one icon from this registry. Line
 * icons are 16×16 viewBox paths drawn at 14px with a 1.5 stroke; brand marks
 * (Claude Code, Codex, Grok Build) are filled glyphs on the same box.
 * `iconForLabel` maps a button's visible label to its icon so the guard test
 * can fail on any labelled button that renders without one.
 */

export type LineIconName =
  | "plus"
  | "download"
  | "x"
  | "check"
  | "folder"
  | "refresh"
  | "pencil"
  | "trash"
  | "external"
  | "search"
  | "filter"
  | "settings"
  | "link"
  | "copy"
  | "upload"
  | "play"
  | "stop"
  | "arrow-right"
  | "arrow-left"
  | "user-plus"
  | "send"
  | "file"
  | "plug"
  | "eye"
  | "chevron-down"
  | "circle-dot"
  | "logout"
  | "key"
  | "save";

export type BrandIconName = "claude-code" | "codex" | "grok";

export type RailIconName = LineIconName | BrandIconName;

/** Stroked line icons, 16×16 viewBox. */
export const LINE_ICONS: Record<LineIconName, string> = {
  plus: "M8 3v10M3 8h10",
  download: "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10",
  upload: "M8 10.5v-8M4.5 6 8 2.5 11.5 6M3 13.5h10",
  x: "M4 4l8 8M12 4l-8 8",
  check: "M3.5 8.5 6.5 11.5 12.5 4.5",
  save: "M3.5 8.5 6.5 11.5 12.5 4.5",
  folder: "M2 4.5A1 1 0 0 1 3 3.5h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z",
  refresh: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5",
  pencil: "M10.5 3 13 5.5 6 12.5H3.5V10z",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5",
  external: "M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13H3V4.5h3.5",
  search: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.5 10.5 14 14",
  filter: "M2.5 3.5h11L9.5 8.5V13l-3-1.5v-3z",
  settings: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  link: "M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1",
  copy: "M5.5 5.5h7v7h-7zM10.5 5.5v-2h-7v7h2",
  play: "M5 3.5v9l7-4.5z",
  stop: "M4.5 4.5h7v7h-7z",
  "arrow-right": "M3 8h10M9 4l4 4-4 4",
  "arrow-left": "M13 8H3M7 4 3 8l4 4",
  "user-plus": "M6.5 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 13.5a4.5 4.5 0 0 1 9 0M12.5 5.5v4M10.5 7.5h4",
  send: "M2.5 8 13.5 2.5 10.5 13.5 7.5 9z",
  file: "M4 2h5l3 3v9H4zM9 2v3h3",
  plug: "M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3",
  eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  "chevron-down": "M4 6l4 4 4-4",
  "circle-dot": "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  logout: "M6 13.5H3v-11h3M10 5l3 3-3 3M13 8H6",
  key: "M5.5 10.5a3 3 0 1 1 2.6-1.5L14 15M11 12l1.5-1.5",
};

/** Filled brand marks, 16×16 viewBox. Simplified glyphs, not trademark art. */
export const BRAND_ICONS: Record<BrandIconName, string> = {
  // Claude Code: the eight-ray Claude burst.
  "claude-code":
    "M8 1.5l.9 4.2 3.7-2.2-2.2 3.7 4.1.8-4.1.8 2.2 3.7-3.7-2.2L8 14.5l-.9-4.2-3.7 2.2 2.2-3.7L1.5 8l4.1-.8-2.2-3.7 3.7 2.2z",
  // Codex: rounded terminal block with a prompt chevron.
  codex:
    "M3 2h10a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 3 2zm1.6 3.4-.9.9L5.4 8 3.7 9.7l.9.9L7.2 8zM8 9.6v1.2h4.3V9.6z",
  // Grok: slashed ring.
  grok:
    "M8 2a6 6 0 0 1 5.3 3.2l-1.1.6A4.8 4.8 0 1 0 12.8 8H14A6 6 0 1 1 8 2zm4.6.5.9.9-9.1 10.1-.9-.9z",
};

export function isBrandIcon(name: RailIconName): name is BrandIconName {
  return name in BRAND_ICONS;
}

/**
 * Visible label → icon. Matched on the normalised label (lower case, trailing
 * ellipsis dropped). Prefix rules cover families such as "New …".
 */
const EXACT: Record<string, RailIconName> = {
  export: "download",
  "export csv": "download",
  download: "download",
  cancel: "x",
  close: "x",
  dismiss: "x",
  "clear search": "x",
  "clear filters": "x",
  clear: "x",
  create: "check",
  save: "check",
  done: "check",
  confirm: "check",
  apply: "check",
  vault: "folder",
  "open vault": "folder",
  "check again": "refresh",
  "try again": "refresh",
  retry: "refresh",
  refresh: "refresh",
  change: "pencil",
  edit: "pencil",
  rename: "pencil",
  delete: "trash",
  remove: "trash",
  "open in claude code": "claude-code",
  "open in codex": "codex",
  "grok build": "grok",
  "open in grok build": "grok",
  invite: "user-plus",
  "invite member": "user-plus",
  "add integration": "plug",
  connect: "plug",
  copy: "copy",
  "copy link": "link",
  open: "external",
  view: "eye",
  upload: "upload",
  send: "send",
  start: "play",
  stop: "stop",
  back: "arrow-left",
  continue: "arrow-right",
  next: "arrow-right",
  "sign out": "logout",
};

const PREFIX: Array<[string, RailIconName]> = [
  ["new ", "plus"],
  ["add ", "plus"],
  ["create ", "check"],
  ["save ", "check"],
  ["export ", "download"],
  ["open in claude", "claude-code"],
  ["open in codex", "codex"],
  ["open ", "external"],
  ["clear ", "x"],
  ["delete ", "trash"],
  ["remove ", "trash"],
  ["invite ", "user-plus"],
  ["connect ", "plug"],
  ["edit ", "pencil"],
  ["change ", "pencil"],
];

export function normaliseLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[.…]+$/u, "").replace(/\s+/gu, " ");
}

export function iconForLabel(label: string): RailIconName | null {
  const key = normaliseLabel(label);
  if (key in EXACT) return EXACT[key];
  for (const [prefix, icon] of PREFIX) if (key.startsWith(prefix)) return icon;
  return null;
}
