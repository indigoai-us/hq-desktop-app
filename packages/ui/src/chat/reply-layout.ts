/** Narrow Chat tab: ReplyPanel overlays the timeline instead of a third column. */
export const REPLY_OVERLAY_MAX_PX = 720;

export function replyColumnLayout(widthPx: number): "overlay" | "column" {
  return widthPx <= REPLY_OVERLAY_MAX_PX ? "overlay" : "column";
}
