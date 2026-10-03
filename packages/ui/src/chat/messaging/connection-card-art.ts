/**
 * The wallpaper behind each connection card, and behind the modal a card
 * opens. One place, so a card and its modal always show the same art.
 * The images are the ones already bundled for the New Bot takeover.
 */
import aurora from "../create-bot/assets/new-bot-wallpapers/aurora.jpg";
import glassWhiteboard from "../create-bot/assets/new-bot-wallpapers/glass-whiteboard.jpg";
import nodeConstellation from "../create-bot/assets/new-bot-wallpapers/node-constellation.jpg";
import roadSunrise from "../create-bot/assets/new-bot-wallpapers/road-sunrise.jpg";
import type { ConnectTarget } from "./richMessageContent.js";

export interface ConnectionCardArt {
  /** The bundled image. */
  url: string;
  /** Which part of the image the card shows (a CSS background-position). */
  position: string;
}

const ART: Record<ConnectTarget, ConnectionCardArt> = {
  slack: { url: aurora, position: "center 14%" },
  tools: { url: nodeConstellation, position: "center 96%" },
};

/**
 * The wallpapers integration cards rotate through, by their place in the
 * row, so two neighbours never share one. Each is a different crop from the
 * built-in cards' so the row reads as one family without repeating.
 */
const INTEGRATION_ART: readonly ConnectionCardArt[] = [
  { url: nodeConstellation, position: "center 30%" },
  { url: roadSunrise, position: "center 60%" },
  { url: glassWhiteboard, position: "center 40%" },
  { url: aurora, position: "center 70%" },
];

export function connectionCardArt(target: ConnectTarget): ConnectionCardArt {
  return ART[target];
}

/** The art of the integration card at `index` in its row (0-based). */
export function integrationCardArt(index: number): ConnectionCardArt {
  const at = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return INTEGRATION_ART[at % INTEGRATION_ART.length]!;
}
