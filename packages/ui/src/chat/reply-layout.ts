/** Slack-like: below 900px total width the pane overlays instead of crushing the conversation. */
export const REPLY_OVERLAY_MAX_PX = 900;

export function replyColumnLayout(widthPx: number): "overlay" | "column" {
  return widthPx <= REPLY_OVERLAY_MAX_PX ? "overlay" : "column";
}
