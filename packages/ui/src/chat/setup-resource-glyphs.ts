import type { RailIconName } from "../common/button/rail-icons.js";
import type { SetupResourceKind } from "./setup-channel";

/**
 * The Phosphor icon per "Learn HQ" resource kind (no emoji in product UI).
 * Shared by the #welcome hero (`SetupChannelIntro`) and the setup finale
 * (`SetupFinale`) so the two rows stay identical.
 *
 * These were raw path strings dropped into an <svg> with `{@html}`. Svelte
 * parses `{@html}` content as HTML, not SVG, so the paths never painted and
 * every card showed an empty tile (owner, 2026-10-22).
 */
export const SETUP_RESOURCE_ICONS: Record<SetupResourceKind, RailIconName> = {
  guide: "compass",
  book: "book-open",
  training: "calendar-blank",
  docs: "file-text",
};
