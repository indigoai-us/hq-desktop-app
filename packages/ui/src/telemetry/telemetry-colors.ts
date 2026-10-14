/**
 * Provider colors for My Telemetry. One hue per provider, a shade step per
 * model family inside it, and a neutral for anything unknown. The values live
 * as CSS tokens in home/tokens.css (light and dark); this file only maps a
 * model or family label to its token and fixes the order stacks are drawn in.
 *
 * The order is fixed (provider, then shade) so the stacked chart, its legend
 * and the Models table always list entities the same way, and the adjacent
 * pairs the palette was validated on are the pairs the chart draws.
 */

export type VizProvider = "anthropic" | "openai" | "xai" | "neutral";

export interface VizSlot {
  /** Stable key for the family, e.g. "opus". */
  key: string;
  /** Display name for the family on every surface, e.g. "Opus", "OpenAI". */
  label: string;
  provider: VizProvider;
  /** CSS custom property holding the color, e.g. "--viz-anthropic-1". */
  token: string;
  /** Position in the fixed stack and legend order. */
  order: number;
}

export const VIZ_PROVIDER_LABEL: Record<VizProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  neutral: "Other",
};

/**
 * Fixed families: Anthropic shades, then OpenAI, then xAI, then neutral. One
 * family per provider outside Anthropic: Codex and GPT ids are both "OpenAI"
 * (blue), Grok and its fast/mini/code variants are both "Grok". Models inside
 * a family are told apart by `modelShadeOpacity`, not by a second hue.
 */
export const VIZ_SLOTS: readonly VizSlot[] = [
  { key: "opus", label: "Opus", provider: "anthropic", token: "--viz-anthropic-1", order: 0 },
  { key: "sonnet", label: "Sonnet", provider: "anthropic", token: "--viz-anthropic-2", order: 1 },
  { key: "fable", label: "Fable", provider: "anthropic", token: "--viz-anthropic-3", order: 2 },
  { key: "haiku", label: "Haiku", provider: "anthropic", token: "--viz-anthropic-4", order: 3 },
  { key: "openai", label: "OpenAI", provider: "openai", token: "--viz-openai", order: 4 },
  { key: "grok", label: "Grok", provider: "xai", token: "--viz-xai", order: 5 },
  { key: "system", label: "System", provider: "neutral", token: "--viz-neutral", order: 6 },
  { key: "other", label: "Other", provider: "neutral", token: "--viz-neutral", order: 7 },
];

const BY_KEY = new Map(VIZ_SLOTS.map((slot) => [slot.key, slot]));
const slot = (key: string): VizSlot => BY_KEY.get(key)!;

/**
 * The one resolver from a raw model id, family label or display name to its
 * family: "claude-opus-4-5", "Opus 4.5", "gpt-5.6-sol", "gpt-5.5-codex",
 * "OpenAI", "Codex", "grok-code-fast-1", "<synthetic>". The stat row, chart,
 * legend, Models table and By-model rows all name and color through this, so
 * one model id can never land in two families. Anything unknown is "other".
 */
export function vizSlotFor(label: string): VizSlot {
  const s = label.trim().toLowerCase();
  if (/^<.*>$|^synthetic$|^system$/.test(s)) return slot("system");
  if (/\bopus\b|claude-opus|-opus\b/.test(s)) return slot("opus");
  if (/\bsonnet\b|claude-sonnet|-sonnet\b/.test(s)) return slot("sonnet");
  if (/\bfable\b|claude-fable/.test(s)) return slot("fable");
  if (/\bhaiku\b|claude-haiku|-haiku\b/.test(s)) return slot("haiku");
  if (/codex|^openai\b|^gpt[-\s]|^o\d+(\b|-)/.test(s)) return slot("openai");
  if (/grok/.test(s)) return slot("grok");
  return slot("other");
}

/** Alias that reads better where a family, not a color, is wanted. */
export const modelFamilyOf = vizSlotFor;

/** `var(--viz-…)` for a label. */
export function vizColor(label: string): string {
  return `var(${vizSlotFor(label).token})`;
}

/** Labels in the fixed provider-then-shade order; ties keep their input order. */
export function vizOrder<T>(items: readonly T[], label: (item: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i, order: vizSlotFor(label(item)).order }))
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map((x) => x.item);
}

/**
 * Opacity for the nth model (0-based, largest first) inside one family in the
 * By model view: the family color at full strength, then lighter steps.
 */
export function modelShadeOpacity(rankInFamily: number): number {
  const steps = [1, 0.7, 0.5, 0.36];
  return steps[Math.min(Math.max(rankInFamily, 0), steps.length - 1)]!;
}

/** "Opus 38% · OpenAI 26%" (or "38% Opus · …") → labeled parts, in source order. */
export function mixParts(mix: string): { label: string; share: string }[] {
  return mix
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const tail = part.match(/^(.*?)\s+(\d+(?:\.\d+)?%)$/);
      if (tail) return { label: tail[1]!.trim(), share: tail[2]! };
      const head = part.match(/^(\d+(?:\.\d+)?%)\s+(.*)$/);
      if (head) return { label: head[2]!.trim(), share: head[1]! };
      return { label: part, share: "" };
    });
}
