/**
 * OWNER-R6: whether a shared Dropdown menu is open. A sheet that listens for
 * Escape on window (capture phase) checks this first, so Escape closes the
 * open menu and leaves the sheet in place.
 */
let openMenus = 0;

export function markDropdownOpen(open: boolean): void {
  openMenus = Math.max(0, openMenus + (open ? 1 : -1));
}

export function isDropdownOpen(): boolean {
  return openMenus > 0;
}
