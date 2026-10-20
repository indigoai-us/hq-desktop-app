/**
 * The hover menu overlaps its message row by this many pixels so the pointer
 * can move from the row into the menu without crossing another row.
 * The overlap sits in the row's padding, not on the text.
 */
export const HOVER_MENU_OVERLAP_PX = 3;

/**
 * True when a menu anchored above the row, overlapping it by `overlapPx`,
 * would start above the scrollport and be clipped.
 */
export function hoverMenuClippedAbove(
  rowTop: number,
  menuHeight: number,
  scrollportTop: number,
  overlapPx: number = HOVER_MENU_OVERLAP_PX,
): boolean {
  return rowTop - (menuHeight - overlapPx) < scrollportTop - 0.5;
}
