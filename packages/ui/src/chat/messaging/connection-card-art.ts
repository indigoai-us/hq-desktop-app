/**
 * The wallpaper behind each connection card, and behind the modal a card
 * opens. One place, so a card and its modal always show the same art.
 * The images are the ones already bundled for the New Bot takeover.
 */
import aurora from "../create-bot/assets/new-bot-wallpapers/aurora.jpg";
import nodeConstellation from "../create-bot/assets/new-bot-wallpapers/node-constellation.jpg";
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

export function connectionCardArt(target: ConnectTarget): ConnectionCardArt {
  return ART[target];
}
