/**
 * The message hover menu opens this many pixels under the message it
 * belongs to (owner, #772: the bar hangs below the message, right-aligned,
 * on the line its reactions use).
 */
export const HOVER_MENU_GAP_PX = 4;

/**
 * True when a menu hung `gapPx` under its message would run past the bottom
 * of the scrollport and be clipped. The menu then opens above the message
 * instead.
 */
export function hoverMenuClippedBelow(
  anchorBottom: number,
  menuHeight: number,
  scrollportBottom: number,
  gapPx: number = HOVER_MENU_GAP_PX,
): boolean {
  return anchorBottom + gapPx + menuHeight > scrollportBottom + 0.5;
}
