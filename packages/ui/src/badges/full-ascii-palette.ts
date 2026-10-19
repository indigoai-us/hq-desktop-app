/**
 * The alphabet that maps a cell's color character to its palette index in
 * full-ascii-data.ts. It lives apart from the art so the badge renderer
 * (full-badge.ts) can use it without pulling the art into the app shell; the
 * art loads with import() when a card or share image needs it.
 */
export const PALETTE_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-";
