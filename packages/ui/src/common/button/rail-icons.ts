/**
 * Console-rail button icon registry (OWNER-007 / OWNER-008).
 *
 * Every labelled console-rail button names one icon from this registry. Line
 * icons are 16×16 viewBox paths drawn at 14px with a 1.5 stroke; brand marks
 * (Claude Code, Codex, Grok Build) are filled glyphs with their own viewBox.
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
  | "save"
  | "archive"
  | "ban"
  | "check-circle"
  | "bell"
  | "door"
  | "sliders"
  | "cloud"
  | "laptop";

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
  archive: "M2.5 3.5h11v3h-11zM3.5 6.5V13h9V6.5M6.5 9h3",
  ban: "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM4.1 4.1l7.8 7.8",
  "check-circle": "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM5.5 8.2l1.7 1.7 3.3-3.6",
  bell: "M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.5 14h3",
  door: "M4 14V2.5h8V14M2.5 14h11M9.5 8.5v.5",
  sliders: "M2.5 5h11M2.5 11h11M6 3.5v3M10 9.5v3",
  cloud: "M4.75 12.5h6.5a2.75 2.75 0 0 0 .3-5.48 3.75 3.75 0 0 0-7.2-.52A3 3 0 0 0 4.75 12.5Z",
  laptop: "M3.5 4h9v6.5h-9zM1.5 12.5h13",
};

/**
 * Brand marks. Claude Code and Codex use the vendors' published SVGs unaltered
 * (path data copied verbatim, viewBox cropped to the glyph); sources and terms
 * are in docs/brand-marks.md. Grok keeps a simplified glyph because xAI's
 * asset download could not be retrieved.
 *
 * `fill`: "clay" is the official Claude Spark colour, "mono" renders the
 * official Black or White Blossom by colour scheme (OpenAI forbids adding
 * colours), "current" follows the text colour.
 */
export interface BrandMark {
  viewBox: string;
  d: string;
  fill: "clay" | "mono" | "current";
}

export const BRAND_ICONS: Record<BrandIconName, BrandMark> = {
  // Claude Spark (Clay), Anthropic press kit.
  "claude-code": {
    viewBox: "0 0 94 94",
    fill: "clay",
    d: "M18.7657 62.4437L37.1822 52.1167L37.4857 51.2122L37.1822 50.7085H36.2715L33.1852 50.5208L22.6615 50.2391L13.5545 49.8636L4.70044 49.3942L2.47428 48.9248L0.399902 46.1553L0.602281 44.794L2.47428 43.5266L5.15579 43.7613L11.0754 44.1837L19.98 44.794L26.4055 45.1695L35.9679 46.1553H37.4857L37.6881 45.545L37.1822 45.1695L36.7774 44.794L27.5692 38.5508L17.6021 31.9791L12.3908 28.1769L9.60812 26.2524L8.19147 24.4686L7.58433 20.5256L10.1141 17.7091L13.5545 17.9438L14.4146 18.1785L17.9056 20.8542L25.343 26.6279L35.0572 33.7629L36.4739 34.9364L37.0443 34.5514L37.1316 34.2792L36.4739 33.1996L31.212 23.6706L25.596 13.9539L23.0663 9.91695L22.4086 7.52296C22.1538 6.51831 22.0038 5.68714 22.0038 4.65957L24.8877 0.716544L26.5067 0.200195L30.4025 0.716544L32.0215 2.12477L34.4501 7.66379L38.3458 16.3478L44.4172 28.1769L46.188 31.6975L47.1493 34.9364L47.5035 35.9222H48.1106V35.3589L48.6166 28.6933L49.5273 20.5256L50.438 10.0108L50.7415 7.05356L52.2088 3.48605L55.1433 1.56148L57.42 2.64112L59.292 5.31674L59.039 7.05356L57.926 14.2824L55.7504 25.5952L54.3337 33.1996H55.1433L56.1046 32.2138L59.9497 27.1442L66.3752 19.0704L69.2085 15.8784L72.5478 12.3579L74.6728 10.668H78.7203L81.6548 15.0804L80.3394 19.6337L76.1906 24.8911L72.7502 29.3504L67.8172 35.9595L64.7562 41.2734L65.0307 41.7118L65.7681 41.6489L76.8989 39.255L82.9197 38.1753L90.1041 36.9549L93.3422 38.457L93.6963 40.006L92.4315 43.151L84.7411 45.0287L75.7353 46.8594L62.3244 50.0164L62.1759 50.1358L62.3512 50.3958L68.399 50.9432L70.9794 51.084H77.3037L89.0922 51.9759L92.1785 53.9944L93.9999 56.4822L93.6963 58.4068L88.9404 60.8008L82.5655 59.2987L67.6401 55.7312L62.5301 54.4638H61.8217V54.8862L66.0717 59.064L73.9139 66.1051L83.6786 75.2116L84.1845 77.4648L82.9197 79.2485L81.6042 79.0608L73.0032 72.5829L69.6639 69.6726L62.1759 63.3356H61.67V63.9928L63.3902 66.5276L72.5478 80.2812L73.0032 84.5059L72.3454 85.8672L69.9675 86.7121L67.3871 86.2427L61.9735 78.6852L56.4587 70.2359L52.0064 62.6315L51.4687 62.971L48.8189 91.2654L47.6047 92.7206L44.7714 93.8002L42.3934 92.0164L41.1286 89.1061L42.3934 83.3324L43.9113 75.8219L45.1255 69.8604L46.2386 62.4437L46.9184 59.9661L46.8583 59.8003L46.3153 59.8916L40.7238 67.5603L32.2239 79.0608L25.4948 86.2427L23.8758 86.8999L21.0931 85.4447L21.3461 82.863L22.9145 80.5629L32.2239 68.7338L37.8399 61.3641L41.4594 57.1337L41.4242 56.5218L41.2244 56.5048L16.489 72.6299L12.0873 73.1932L10.1647 71.4094L10.4176 68.4991L11.3283 67.5603L18.7657 62.4437Z",
  },
  // OpenAI Blossom, openai.com/brand logo pack.
  codex: {
    viewBox: "176 176 364 364",
    fill: "mono",
    d: "M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z",
  },
  // Grok: hand-drawn slashed ring (official asset unavailable).
  grok: {
    viewBox: "0 0 16 16",
    fill: "current",
    d: "M8 2a6 6 0 0 1 5.3 3.2l-1.1.6A4.8 4.8 0 1 0 12.8 8H14A6 6 0 1 1 8 2zm4.6.5.9.9-9.1 10.1-.9-.9z",
  },
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
  archive: "archive",
  unarchive: "archive",
  reject: "ban",
  choose: "check-circle",
  "select all": "check-circle",
  knock: "bell",
  enable: "bell",
  manage: "sliders",
  "more options": "sliders",
  "check for updates": "refresh",
  "check all updates": "refresh",
  "restart to update": "refresh",
  install: "download",
  "download & install": "download",
  reply: "send",
  share: "link",
  "sign in": "key",
};

const PREFIX: Array<[string, RailIconName]> = [
  ["new ", "plus"],
  ["add ", "plus"],
  ["create ", "check"],
  ["save ", "check"],
  ["export ", "download"],
  ["open in claude", "claude-code"],
  ["open in codex", "codex"],
  ["open the door", "door"],
  ["open my door", "door"],
  ["open ", "external"],
  ["clear ", "x"],
  ["delete ", "trash"],
  ["remove ", "trash"],
  ["invite ", "user-plus"],
  ["connect ", "plug"],
  ["edit ", "pencil"],
  ["change ", "pencil"],
  ["manage ", "sliders"],
  ["show in ", "folder"],
  ["attach ", "link"],
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
