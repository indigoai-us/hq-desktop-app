/**
 * Telemetry for the setup bot's "continue setup in your coding tool" offer.
 *
 * The chat UI (packages/ui) has no telemetry transport of its own, so it
 * dispatches a window event and the desktop shell (apps/sync App.svelte)
 * forwards it through the consent-gated `emitDesktopTelemetry` path, the
 * same bridge `post-ready-actions.ts` uses.
 *
 * Properties are the tool's id and booleans only: never a path, a prompt, a
 * message, or anything about the person's sessions.
 */

export const SETUP_TOOL_OFFER_EVENTS = {
  shown: "setup_tool_offer_shown",
  continued: "setup_tool_offer_continued",
  keptHere: "setup_tool_offer_kept_here",
} as const;

export type SetupToolOfferAction = keyof typeof SETUP_TOOL_OFFER_EVENTS;
export type SetupToolOfferTool = "claude" | "codex";

export const SETUP_TOOL_OFFER_EVENT = "hq:setup-tool-offer";

export interface SetupToolOfferTelemetry {
  eventName: (typeof SETUP_TOOL_OFFER_EVENTS)[SetupToolOfferAction];
  properties: { tool: SetupToolOfferTool; launched?: boolean };
}

/** The telemetry record for one action, or null for anything malformed. */
export function setupToolOfferTelemetry(detail: unknown): SetupToolOfferTelemetry | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { action, tool, launched } = detail as { action?: unknown; tool?: unknown; launched?: unknown };
  if (action !== "shown" && action !== "continued" && action !== "keptHere") return null;
  if (tool !== "claude" && tool !== "codex") return null;
  const properties: SetupToolOfferTelemetry["properties"] = { tool };
  if (action === "continued" && typeof launched === "boolean") properties.launched = launched;
  return { eventName: SETUP_TOOL_OFFER_EVENTS[action], properties };
}

export function dispatchSetupToolOffer(
  action: SetupToolOfferAction,
  tool: SetupToolOfferTool,
  flags: { launched?: boolean } = {},
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(SETUP_TOOL_OFFER_EVENT, {
      detail: { action, tool, ...(typeof flags.launched === "boolean" ? { launched: flags.launched } : {}) },
    }),
  );
}
