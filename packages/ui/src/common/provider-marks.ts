/**
 * Small monochrome provider marks drawn before a model or family name in
 * charts and tables (My Telemetry). Each mark is one path filled with the
 * caller's color, so it can stand in for a colored series dot.
 *
 * Sources:
 * - Anthropic: the "A\" logomark from the `simple-icons` package (CC0 1.0),
 *   already a dependency of this package.
 * - OpenAI: the Blossom from the openai.com/brand logo pack, the same path the
 *   rail buttons use (button/rail-icons.ts, terms in docs/brand-marks.md).
 * - xAI: the simplified slashed-ring glyph the rail buttons use for Grok;
 *   simple-icons has no xAI mark and the official asset is not bundled.
 * - Unknown providers get a plain neutral disc, never a made-up logo.
 */
import { siAnthropic } from "simple-icons";
import { BRAND_ICONS } from "./button/rail-icons.js";
import type { VizProvider } from "../telemetry/telemetry-colors.js";

export interface ProviderMark {
  viewBox: string;
  d: string;
  /** Accessible name, e.g. "Anthropic". */
  label: string;
}

export const PROVIDER_MARKS: Record<VizProvider, ProviderMark> = {
  anthropic: { viewBox: "0 0 24 24", d: siAnthropic.path, label: "Anthropic" },
  openai: { viewBox: BRAND_ICONS.codex.viewBox, d: BRAND_ICONS.codex.d, label: "OpenAI" },
  xai: { viewBox: BRAND_ICONS.grok.viewBox, d: BRAND_ICONS.grok.d, label: "xAI" },
  neutral: { viewBox: "0 0 16 16", d: "M8 3a5 5 0 1 1 0 10A5 5 0 0 1 8 3z", label: "Other provider" },
};

/** The mark for a provider; anything not listed gets the neutral disc. */
export function providerMark(provider: string): ProviderMark {
  return PROVIDER_MARKS[provider as VizProvider] ?? PROVIDER_MARKS.neutral;
}
