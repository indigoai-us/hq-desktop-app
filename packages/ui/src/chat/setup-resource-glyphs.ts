import type { RailIconName } from "../common/button/rail-icons.js";
import type { SetupResourceKind } from "./setup-channel";

/**
 * Phosphor Regular icon per "Learn HQ" resource kind (no emoji in product
 * UI). Shared by the #welcome hero (`SetupChannelIntro`) and the setup
 * finale (`SetupFinale`) so the two rows stay identical. Rendered with
 * `<RailIcon name={SETUP_RESOURCE_GLYPHS[kind]} size={16} />`.
 */
export const SETUP_RESOURCE_GLYPHS: Record<SetupResourceKind, RailIconName> = {
  guide: "compass",
  book: "book-open",
  training: "calendar-blank",
  docs: "file-text",
};
