export function pickerBounds(anchor: { left: number; top: number }, viewport: { width: number; height: number }, wide: boolean) {
  const gutter = 12;
  const width = Math.max(0, Math.min(wide ? 560 : 320, viewport.width - gutter * 2));
  return {
    width,
    left: Math.max(gutter, Math.min(anchor.left, viewport.width - width - gutter)),
    bottom: Math.max(gutter, viewport.height - anchor.top + 6),
    maxHeight: Math.max(0, Math.min(wide ? 480 : 360, anchor.top - gutter - 6)),
  };
}

/** Place against the trigger, not an unconstrained offset inside the composer. */
export function positionPicker(node: HTMLElement, wide: boolean) {
  const anchor = node.parentElement!;
  // Fixed positioning alone is still relative to a filtered/transformed
  // ancestor. The top layer keeps viewport coordinates truly viewport-bound
  // while retaining DOM ancestry for Svelte events and outside-click handling.
  const topLayer = typeof node.showPopover === 'function';
  if (topLayer) {
    node.setAttribute('popover', 'manual');
    node.showPopover();
  }
  function position() {
    const bounds = pickerBounds(anchor.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, wide);
    Object.assign(node.style, { position: 'fixed', margin: '0', top: 'auto', right: 'auto', width: `${bounds.width}px`, minWidth: '0', left: `${bounds.left}px`, bottom: `${bounds.bottom}px`, maxHeight: `${bounds.maxHeight}px` });
  }
  position();
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  return {
    update(next: boolean) { wide = next; position(); },
    destroy() { if (topLayer && node.isConnected) node.hidePopover(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); },
  };
}
