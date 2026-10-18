/**
 * The brief's sunrise card follows the page theme. Light is the round 11b warm
 * morning (cream sky warming to peach, dark ink cells); dark is the night sky.
 * The canvas cannot read CSS, so the card asks the DOM which theme it sits in.
 */
export type SunriseTone = "dark" | "light";

/** Light when the app forces light or a themed ancestor says so. */
export function sunriseTone(el: Element | null): SunriseTone {
  if (!el) return "dark";
  if (el.ownerDocument?.documentElement?.getAttribute("data-force-theme") === "light") return "light";
  const themed = el.closest("[data-theme]");
  return themed?.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export interface SunrisePalette {
  /** Sky gradient top, then low at elevation e (0..1). */
  skyTop: string;
  skyLow: (e: number) => string;
  /** Flat fill below the horizon. */
  ground: string;
  /** The pixel field's ink and its base alpha above and below the horizon. */
  cell: [number, number, number];
  skyAlpha: number;
  seaAlpha: number;
  /** Twinkling stars only make sense on the night sky. */
  stars: boolean;
}

export function sunrisePalette(tone: SunriseTone): SunrisePalette {
  if (tone === "light") {
    return {
      skyTop: "rgb(255,247,231)",
      skyLow: (e) => `rgb(${Math.round(255 - 5 * e)},${Math.round(232 - 12 * e)},${Math.round(212 - 20 * e)})`,
      ground: "#fffaf3",
      cell: [42, 28, 22],
      skyAlpha: 0.028,
      seaAlpha: 0.022,
      stars: false,
    };
  }
  return {
    skyTop: "rgba(20,20,30,1)",
    skyLow: (e) => `rgba(${60 + e * 60},${30 + e * 25},${45 + e * 10},1)`,
    ground: "#121216",
    cell: [255, 255, 255],
    skyAlpha: 0.022,
    seaAlpha: 0.018,
    stars: true,
  };
}
