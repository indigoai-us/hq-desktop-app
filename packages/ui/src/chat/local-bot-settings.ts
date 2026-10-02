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
  /** Specific model versions offered for new picks, newest first. */
  models: LocalBotModelChoice[];
  /**
   * Older values a bot may still have saved but that are no longer offered.
   * Shown with a friendly label when a bot has one; never offered for a new pick.
   */
  legacyModels?: LocalBotModelChoice[];
  efforts: string[];
  defaultModelLabel: string;
  /** How the picker names the tool a person may need to update. */
  toolLabel: string;
}

export const LOCAL_BOT_SETTINGS: Record<LocalBotRow["runtime"], LocalBotRuntimeSettings> = {
  claude: {
    defaultModelLabel: "Claude Code's default",
    toolLabel: "Claude Code",
    // Full model ids, not the opus/sonnet/haiku aliases: an alias resolves per
    // Claude Code version, so "opus" can mean an older Opus on an older install.
    models: [
      { value: "claude-opus-5-5", label: "Opus 5.5" },
      { value: "claude-opus-5", label: "Opus 5" },
      { value: "claude-sonnet-5", label: "Sonnet 5" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    ],
    legacyModels: [
      { value: "opus", label: "Opus (latest in Claude Code)" },
      { value: "sonnet", label: "Sonnet (latest in Claude Code)" },
      { value: "haiku", label: "Haiku (latest in Claude Code)" },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    defaultModelLabel: "Codex's default",
    toolLabel: "Codex",
    models: [
      { value: "gpt-6-astra", label: "GPT-6 Astra" },
      { value: "gpt-5.5", label: "GPT-5.5" },
    ],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
  grok: {
    defaultModelLabel: "Grok's default",
    toolLabel: "Grok",
    models: [
      { value: "grok-4.7", label: "Grok 4.7" },
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

/**
 * The model choices for a bot, keeping a model it already uses: a saved legacy
 * alias gets its friendly label, anything else shows as the raw id.
 */
export function modelChoicesFor(bot: Pick<LocalBotRow, "runtime" | "model">): LocalBotModelChoice[] {
  const settings = LOCAL_BOT_SETTINGS[bot.runtime];
  const choices: LocalBotModelChoice[] = [{ value: "", label: settings.defaultModelLabel }, ...settings.models];
  const current = bot.model?.trim();
  if (current && !choices.some((c) => c.value === current)) {
    const legacy = settings.legacyModels?.find((c) => c.value === current);
    choices.push(legacy ?? { value: current, label: current });
  }
  return choices;
}

/**
 * Help line under the picker when a specific model is chosen. A model newer
 * than the installed CLI fails at the bot's first turn, and updating the CLI
 * is the fix. Null for the tool's default.
 */
export function modelUpdateHint(runtime: LocalBotRow["runtime"], model: string | null | undefined): string | null {
  if (!model?.trim()) return null;
  return `If a bot can't start with this model, update ${LOCAL_BOT_SETTINGS[runtime].toolLabel}.`;
}

/** One line for the profile: "Opus · thinking High" / "Claude Code's default · thinking Medium". */
export function thinksWithLine(bot: Pick<LocalBotRow, "runtime" | "model" | "effort">): string {
  const model = modelChoicesFor(bot).find((c) => c.value === (bot.model?.trim() ?? ""))?.label ?? bot.model ?? "";
  const effort = EFFORT_LABELS[bot.effort ?? DEFAULT_LOCAL_BOT_EFFORT] ?? bot.effort ?? "Medium";
  return `${model} · thinking ${effort}`;
}
