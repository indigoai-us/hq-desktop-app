/**
 * Viewport-aware placement for portaled rail menus.
 *
 * Same idea as the titlebar Launch menu (bottom-start with a viewport flip):
 * prefer the requested alignment, then shift so the panel stays inside the
 * window with an 8px margin. Filter popovers also cap width to the rail.
 */

export const VIEWPORT_MARGIN_PX = 8;
export const ANCHOR_GAP_PX = 4;
export const FILTER_POPOVER_MAX_PX = 360;
export const FILTER_POPOVER_RAIL_OVERHANG_PX = 40;

export type MenuPlacement = "bottom-start" | "bottom-end" | "top-stretch";

export type AnchorRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

export type ViewportSize = {
  width: number;
  height: number;
};

export type PlaceAnchoredPopoverInput = {
  anchor: AnchorRect;
  viewport: ViewportSize;
  placement: MenuPlacement;
  popoverWidth: number;
  popoverHeight?: number;
  margin?: number;
  gap?: number;
  /** Hard cap besides the viewport (filter menu: 360). */
  maxWidth?: number;
  /** Conversation-rail width; popover must not exceed rail + overhang. */
  railWidth?: number;
  railOverhang?: number;
};

export type PlaceAnchoredPopoverResult = {
  top: number;
  left: number;
  width: number;
  /** Set for top-stretch so the menu grows upward from the anchor. */
  bottom?: number;
};

export function clampPopoverWidth(input: {
  preferred: number;
  viewportWidth: number;
  margin?: number;
  maxWidth?: number;
  railWidth?: number;
  railOverhang?: number;
}): number {
  const margin = input.margin ?? VIEWPORT_MARGIN_PX;
  const viewportCap = Math.max(0, input.viewportWidth - margin * 2);
  let cap = viewportCap;
  if (input.maxWidth != null) cap = Math.min(cap, input.maxWidth);
  if (input.railWidth != null) {
    cap = Math.min(cap, input.railWidth + (input.railOverhang ?? 0));
  }
  const preferred =
    input.preferred > 0 ? input.preferred : (input.maxWidth ?? 0);
  return Math.max(0, Math.min(preferred, cap));
}

/**
 * Prefer the requested alignment, then shift so `left` stays ≥ margin and
 * `left + width` stays ≤ viewport − margin. `bottom-end` right-aligns to the
 * anchor and only shifts right when that would overflow the left edge.
 */
export function placeAnchoredPopover(
  input: PlaceAnchoredPopoverInput,
): PlaceAnchoredPopoverResult {
  const margin = input.margin ?? VIEWPORT_MARGIN_PX;
  const gap = input.gap ?? ANCHOR_GAP_PX;
  const width = clampPopoverWidth({
    preferred: input.popoverWidth,
    viewportWidth: input.viewport.width,
    margin,
    maxWidth: input.maxWidth,
    railWidth: input.railWidth,
    railOverhang: input.railOverhang,
  });

  let left: number;
  if (input.placement === "bottom-end") {
    left = input.anchor.right - width;
  } else if (input.placement === "top-stretch") {
    left = input.anchor.left + margin;
  } else {
    left = input.anchor.left;
  }

  const maxLeft = input.viewport.width - margin - width;
  left = Math.min(Math.max(left, margin), Math.max(margin, maxLeft));

  if (input.placement === "top-stretch") {
    return {
      top: 0,
      left,
      width,
      bottom: input.viewport.height - input.anchor.top + gap,
    };
  }

  let top = input.anchor.bottom + gap;
  const height = input.popoverHeight ?? 0;
  if (height > 0 && top + height > input.viewport.height - margin) {
    const above = input.anchor.top - gap - height;
    top =
      above >= margin
        ? above
        : Math.max(margin, input.viewport.height - margin - height);
  }

  return { top, left, width };
}
