import type { LocalBotRow } from "@hq/platform";

/**
 * What a Local bot thinks with, per runtime: the model (blank = the coding
 * tool's own default for the person's account) and the thinking level. The
 * levels are the ones each CLI accepts (`hq bot set` validates the same list);
 * every bot starts at medium, which keeps chat replies quick.
 */
export const DEFAULT_LOCAL_BOT_EFFORT = "medium";

export interface LocalBotModelChoice {
  /** "" = the coding tool's default. */
  value: string;
  label: string;
}

export interface LocalBotRuntimeSettings {
  models: LocalBotModelChoice[];
  efforts: string[];
  defaultModelLabel: string;
}

export const LOCAL_BOT_SETTINGS: Record<LocalBotRow["runtime"], LocalBotRuntimeSettings> = {
  claude: {
    defaultModelLabel: "Claude Code's default",
    models: [
      { value: "opus", label: "Opus" },
      { value: "sonnet", label: "Sonnet" },
      { value: "haiku", label: "Haiku" },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    defaultModelLabel: "Codex's default",
    models: [
      { value: "gpt-5.5", label: "GPT-5.5" },
    ],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
  grok: {
    defaultModelLabel: "Grok's default",
    models: [
      { value: "grok-4.6", label: "Grok 4.6" },
      { value: "grok-4.5", label: "Grok 4.5" },
    ],
    efforts: ["low", "medium", "high", "xhigh"],
  },
};

const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLabel(level: string, isDefault = level === DEFAULT_LOCAL_BOT_EFFORT): string {
  const label = EFFORT_LABELS[level] ?? level;
  return isDefault ? `${label} (default)` : label;
}

/** The model choices for a bot, keeping a custom model it already uses. */
export function modelChoicesFor(bot: Pick<LocalBotRow, "runtime" | "model">): LocalBotModelChoice[] {
  const settings = LOCAL_BOT_SETTINGS[bot.runtime];
  const choices: LocalBotModelChoice[] = [{ value: "", label: settings.defaultModelLabel }, ...settings.models];
  const current = bot.model?.trim();
  if (current && !choices.some((c) => c.value === current)) choices.push({ value: current, label: current });
  return choices;
}

/** One line for the profile: "Opus · thinking High" / "Claude Code's default · thinking Medium". */
export function thinksWithLine(bot: Pick<LocalBotRow, "runtime" | "model" | "effort">): string {
  const model = modelChoicesFor(bot).find((c) => c.value === (bot.model?.trim() ?? ""))?.label ?? bot.model ?? "";
  const effort = EFFORT_LABELS[bot.effort ?? DEFAULT_LOCAL_BOT_EFFORT] ?? bot.effort ?? "Medium";
  return `${model} · thinking ${effort}`;
}
