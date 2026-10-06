/**
 * OWNER-R29: usage by exact model. `/v1/telemetry/me` reports
 * `totals.tokensByModel` keyed by the exact model id with input, output,
 * cache-write and cache-read counts for each, so every model is listed as the
 * telemetry names it, grouped into honest provider families.
 *
 * One table maps ids to readable names; an id it does not know keeps its raw
 * id as the name under "Other". Nothing is dropped.
 */
import { LIST_RATES, type ModelId } from "./telemetry-model.js";
import { modelFamilyOf } from "./telemetry-colors.js";

export interface ExactModelUsage {
  id: string;
  name: string;
  provider: string;
  family: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
  /** List-price estimate for Claude models (the existing rule); null otherwise. */
  costUsd: number | null;
}

export interface ModelFamilyUsage {
  family: string;
  provider: string;
  models: ExactModelUsage[];
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
  costUsd: number | null;
}

interface Naming {
  name: string;
  provider: string;
  family: string;
  claude?: ModelId;
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const words = (parts: string[]) => parts.filter(Boolean).map(cap).join(" ");

/** The one id → readable name table (rules, in order). */
const RULES: { test: RegExp; name: (m: RegExpMatchArray, id: string) => Naming }[] = [
  {
    // <synthetic> and other bracketed internal ids.
    test: /^<.*>$|^synthetic$/,
    name: () => ({ name: "System", provider: "HQ", family: "System" }),
  },
  {
    // claude-opus-4-5-20251101, claude-opus-5-5, claude-sonnet-4-6, claude-fable-5-1
    test: /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/,
    name: (m) => {
      const family = cap(m[1]!);
      const version = m[3] ? `${m[2]}.${m[3]}` : m[2]!;
      const claude = (["opus", "sonnet", "haiku"] as const).find((f) => f === m[1]);
      return { name: `${family} ${version}`, provider: "Anthropic", family, ...(claude ? { claude } : {}) };
    },
  },
  {
    // claude-3-5-sonnet-20241022, claude-3-opus-20240229
    test: /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?$/,
    name: (m) => {
      const family = cap(m[3]!);
      const version = m[2] ? `${m[1]}.${m[2]}` : m[1]!;
      return { name: `${family} ${version}`, provider: "Anthropic", family, claude: m[3] as ModelId };
    },
  },
  {
    // gpt-5.5-codex, gpt-5.1-codex-max, codex-mini-latest
    test: /^(gpt-[\w.]+-)?codex[\w.-]*$|^gpt-[\w.]+-codex[\w.-]*$/,
    name: (_m, id) => {
      const parts = id.split("-");
      const gpt = parts[0] === "gpt" ? `GPT-${parts[1]}` : "";
      const rest = parts.slice(parts[0] === "gpt" ? 2 : 0);
      return { name: [gpt, words(rest)].filter(Boolean).join(" "), provider: "OpenAI", family: "OpenAI" };
    },
  },
  {
    // gpt-5.6-sol, gpt-4o, o3, o4-mini
    test: /^gpt-[\w.]+(-[\w.]+)*$|^o\d+(-[\w.]+)*$/,
    name: (_m, id) => {
      const parts = id.split("-");
      const head = parts[0] === "gpt" ? `GPT-${parts[1]}` : parts[0]!;
      const rest = parts.slice(parts[0] === "gpt" ? 2 : 1);
      return { name: [head, words(rest)].filter(Boolean).join(" "), provider: "OpenAI", family: "OpenAI" };
    },
  },
  {
    // grok-4.7, grok-code-fast-1, grok-4-fast-reasoning
    test: /^grok(-[\w.]+)*$/,
    name: (_m, id) => ({ name: words(id.split("-")), provider: "xAI", family: "Grok" }),
  },
];

export function nameModel(rawId: string): Naming {
  const id = rawId.trim();
  const lower = id.toLowerCase();
  for (const rule of RULES) {
    const m = lower.match(rule.test);
    if (m) return { ...rule.name(m, lower), family: modelFamilyOf(lower).label };
  }
  return { name: id, provider: "", family: modelFamilyOf(lower).label };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function listCost(claude: ModelId | undefined, t: { input: number; output: number; cacheWrite: number; cacheRead: number }): number | null {
  if (!claude) return null;
  const rate = LIST_RATES[claude];
  return (t.input * rate.input + t.output * rate.output + t.cacheWrite * rate.cacheWrite + t.cacheRead * rate.cacheRead) / 1_000_000;
}

/** Exact models from a `tokensByModel` record, largest first. */
export function exactModels(tokensByModel: unknown): ExactModelUsage[] {
  const rec = tokensByModel && typeof tokensByModel === "object" && !Array.isArray(tokensByModel) ? (tokensByModel as Record<string, unknown>) : {};
  const out: ExactModelUsage[] = [];
  for (const [id, raw] of Object.entries(rec)) {
    const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const t = {
      input: num(b.inputTokens),
      output: num(b.outputTokens),
      cacheWrite: num(b.cacheCreationTokens),
      cacheRead: num(b.cacheReadTokens),
    };
    const total = t.input + t.output + t.cacheWrite + t.cacheRead;
    if (total <= 0) continue;
    const naming = nameModel(id);
    out.push({ id, name: naming.name, provider: naming.provider, family: naming.family, ...t, total, costUsd: listCost(naming.claude, t) });
  }
  return out.sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
}

/** Families with their exact models inside, largest family first. */
export function modelFamilies(models: readonly ExactModelUsage[]): ModelFamilyUsage[] {
  const map = new Map<string, ModelFamilyUsage>();
  for (const m of models) {
    const f = map.get(m.family) ?? {
      family: m.family,
      provider: m.provider,
      models: [],
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      total: 0,
      costUsd: null,
    };
    f.models.push(m);
    f.input += m.input;
    f.output += m.output;
    f.cacheWrite += m.cacheWrite;
    f.cacheRead += m.cacheRead;
    f.total += m.total;
    if (m.costUsd != null) f.costUsd = (f.costUsd ?? 0) + m.costUsd;
    map.set(m.family, f);
  }
  return [...map.values()].sort((a, b) => b.total - a.total || a.family.localeCompare(b.family));
}

/** "$87,079.38"; "" when there is no cost. */
export function formatMoney(usd: number | null): string {
  if (usd == null || !Number.isFinite(usd)) return "";
  return usd.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
