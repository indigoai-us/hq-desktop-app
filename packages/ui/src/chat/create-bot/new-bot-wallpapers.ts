import aurora from "./assets/new-bot-wallpapers/aurora.jpg";
import glassWhiteboard from "./assets/new-bot-wallpapers/glass-whiteboard.jpg";
import nodeConstellation from "./assets/new-bot-wallpapers/node-constellation.jpg";
import roadSunrise from "./assets/new-bot-wallpapers/road-sunrise.jpg";

/**
 * The New bot takeover's wallpapers. One list for every screen that wears
 * the takeover shell (the takeover itself and the "+" window's bot step
 * when it opens from the Cloud or Local choice), so both look the same.
 */
export const NEW_BOT_WALLPAPERS: readonly string[] = [glassWhiteboard, roadSunrise, nodeConstellation, aurora];

export function newBotWallpaper(index = 0): string {
  return NEW_BOT_WALLPAPERS[Math.abs(index) % NEW_BOT_WALLPAPERS.length] ?? glassWhiteboard;
}
