import type { SetupResourceKind } from "./setup-channel";

/**
 * Inline stroke glyphs per "Learn HQ" resource kind (no emoji in product
 * UI). Shared by the #welcome hero (`SetupChannelIntro`) and the setup
 * finale (`SetupFinale`) so the two rows stay identical. Rendered inside a
 * 16x16 `stroke="currentColor"` SVG via `{@html}`.
 */
export const SETUP_RESOURCE_GLYPHS: Record<SetupResourceKind, string> = {
  guide:
    '<circle cx="8" cy="8" r="6.25"/><path d="M10.6 5.4 9.2 9.2 5.4 10.6 6.8 6.8z"/>',
  book: '<path d="M2.75 3.25h4.1c.9 0 1.65.55 1.9 1.35.25-.8 1-1.35 1.9-1.35h4.1v9.5h-4.35c-.75 0-1.4.45-1.65 1.1-.25-.65-.9-1.1-1.65-1.1H2.75z"/><path d="M8.75 4.6v9.15"/>',
  training:
    '<rect x="2.25" y="3.25" width="11.5" height="10.5"/><path d="M2.25 6.75h11.5M5.25 1.75v3M10.75 1.75v3"/>',
  docs: '<path d="M4 1.75h5.25L12.5 5v9.25H4z"/><path d="M9 1.75V5h3.5M6 8.25h4M6 10.75h4"/>',
};
