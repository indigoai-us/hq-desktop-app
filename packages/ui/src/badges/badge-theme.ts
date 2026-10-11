/**
 * Which palette the badges draw with. The app forces a theme through
 * `data-force-theme` on <html>; without it the system setting decides.
 */

export type BadgeTheme = "dark" | "light";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

export function badgeTheme(root: HTMLElement | null = globalThis.document?.documentElement ?? null): BadgeTheme {
  const forced = root?.getAttribute("data-force-theme");
  if (forced === "light" || forced === "dark") return forced;
  return globalThis.matchMedia?.(LIGHT_QUERY).matches ? "light" : "dark";
}

/** Calls `onchange` whenever the badge theme may have changed. Returns a stop function. */
export function watchBadgeTheme(
  onchange: (theme: BadgeTheme) => void,
  root: HTMLElement | null = globalThis.document?.documentElement ?? null,
): () => void {
  const notify = () => onchange(badgeTheme(root));
  const observer =
    root && typeof MutationObserver !== "undefined" ? new MutationObserver(notify) : null;
  observer?.observe(root as HTMLElement, { attributes: true, attributeFilter: ["data-force-theme"] });
  const media = globalThis.matchMedia?.(LIGHT_QUERY);
  media?.addEventListener?.("change", notify);
  return () => {
    observer?.disconnect();
    media?.removeEventListener?.("change", notify);
  };
}

/** Light mode has no glow to carry colour, so pastel inks are deepened to stay readable. */
export function inkForLight(hex: string): string {
  const [h, s, l] = toHsl(hex);
  return fromHsl(h, Math.min(1, s * 1.2 + 0.1), Math.min(l, 0.4));
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const hue = (((h % 360) + 360) % 360) / 360;
  const f = (n: number) => {
    const k = (n + hue * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
}
