/**
 * Rich structured message content (rich-agent-message-content).
 *
 * WHY THIS EXISTS. Fleet-agent replies default to terse plain text, but a
 * genuinely data-heavy answer (a metric read, a comparison table, a small
 * trend chart) reads far better as structure than as a wall of prose. Because
 * HQ owns the desktop chat surface, an agent can emit that structure as DATA
 * and a TRUSTED client component renders it — the agent never authors markup or
 * script.
 *
 * SECURITY MODEL. An agent's output is only semi-trusted: its text can be
 * steered by inputs it reads. So this contract carries **data, never markup**:
 * `stat`, `table`, and `chart` blocks are plain strings and numbers. The Svelte
 * renderers bind them through text interpolation (auto-escaped) and numeric SVG
 * attributes — there is no `{@html}` path for agent-supplied block content, so a
 * payload can never inject executable content. The `markdown` block is the one
 * exception, and it is routed through the existing CSP-safe `renderMarkdown`
 * (no raw-HTML passthrough, no scripts, validated hrefs only) — the same
 * renderer already trusted for every message body today.
 *
 * ARBITRARY GENUI IS NOT SHIPPED HERE. A `genui` block (arbitrary
 * agent-authored HTML/JS or a free component tree) is a distinct security
 * surface that needs a sandbox (iframe + strict CSP or a constrained component
 * schema) and owner sign-off. It is DESIGNED (see docs) but gated behind
 * {@link GENUI_ENABLED}, which is `false`. While the flag is off the parser
 * drops any `genui` block, so no agent markup can render.
 *
 * PLAIN-TEXT FALLBACK GUARANTEE. Rich content is always ADDITIVE to a message
 * `body`. Old clients (and notifications, and any non-desktop surface) ignore
 * the structured field and show `body`. Every rich message therefore MUST carry
 * a human-readable `body` — the renderer never replaces the text fallback with
 * a block-only bubble.
 *
 * Pure (no Svelte runes, no host imports) so it is trivially unit-testable.
 */

/** Envelope version. A present, non-1 version is rejected (unknown). */
export const RICH_CONTENT_VERSION = 1;

/**
 * GenUI (arbitrary agent-authored markup / free component tree) feature flag.
 *
 * DISABLED. Enabling it ships a security surface — semi-trusted agent output
 * rendered as UI — and MUST NOT be turned on without the owner's security
 * sign-off on the sandbox design (iframe + strict CSP, or a constrained,
 * allow-listed component schema). While this is `false` the parser drops every
 * `genui` block and nothing agent-authored is rendered as markup.
 */
export const GENUI_ENABLED = false as boolean;

/** The fenced-code language an agent uses to emit a block inside a body. */
export const HQ_BLOCK_FENCE_LANG = "hq-block";

export type BlockAlign = "left" | "center" | "right";

/** A single metric tile: label + value, with an optional delta/trend. */
export interface StatItem {
  label: string;
  value: string;
  /** Optional change caption, e.g. "+12%" or "-3.4k". Rendered verbatim text. */
  delta?: string;
  /** Optional direction used only to pick an accent color, never markup. */
  trend?: "up" | "down" | "flat";
}

export interface StatBlock {
  kind: "stat";
  items: StatItem[];
}

export interface TableBlock {
  kind: "table";
  columns: string[];
  rows: string[][];
  /** Per-column alignment; missing entries default to left. */
  align?: BlockAlign[];
  caption?: string;
}

export interface ChartSeries {
  name: string;
  data: number[];
}

export interface ChartBlock {
  kind: "chart";
  chartType: "line" | "bar";
  series: ChartSeries[];
  /** X-axis category labels (optional; falls back to indices). */
  categories?: string[];
  caption?: string;
}

/** Prose interleaved between structured blocks; rendered via the safe renderer. */
export interface MarkdownBlock {
  kind: "markdown";
  text: string;
}

/**
 * Closed tone enum shared by `badge` and `progress`. The agent may only pick
 * one of these names; the renderer maps the name to one of its OWN CSS classes,
 * so an agent never supplies a raw color/style. An unknown value collapses to
 * `neutral` (see {@link parseBadgeTone}).
 */
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "accent";

/**
 * Closed tone enum for `callout`. Same rule as {@link BadgeTone}: name → class,
 * never a raw value; unknown collapses to `info`.
 */
export type CalloutTone = "info" | "success" | "warning" | "danger";

/** A small inline status pill: a text label + a closed-enum tone. */
export interface BadgeBlock {
  kind: "badge";
  label: string;
  /** Closed enum → CSS class only; never a raw color/style. */
  tone: BadgeTone;
}

/** One row of a key→value definition list; both sides are sanitized text. */
export interface KeyValueRow {
  key: string;
  value: string;
}

/** An aligned two-column definition list (label → value). */
export interface KeyValueBlock {
  kind: "keyValue";
  items: KeyValueRow[];
}

/** A meter/bar with a numeric percentage (0..100, clamped) rendered as text. */
export interface ProgressBlock {
  kind: "progress";
  label?: string;
  /** Percentage in [0, 100]; the parser clamps out-of-range/NaN values. */
  value: number;
  /** Optional closed-enum tone → CSS class; omitted when absent. */
  tone?: BadgeTone;
}

/**
 * A bordered/tinted note banner. `body` is the ONLY markup path here and it is
 * routed through the same CSP-safe markdown renderer the message body uses
 * (no raw-HTML passthrough, validated hrefs only) — it is never agent-authored
 * HTML. `tone` is a closed enum the renderer maps to a class + icon. The parser
 * also accepts a `text` alias for `body` (see `parseCalloutBlock`) to tolerate
 * emitters that use the markdown block's field name; the alias feeds this same
 * `body` field and no additional markup path.
 */
export interface CalloutBlock {
  kind: "callout";
  tone: CalloutTone;
  title?: string;
  body: string;
}

/**
 * One selectable option in a {@link DecisionBlock}. Data-only: `id` and
 * `label` are sanitized text, `recommended` is a bool the renderer maps to its
 * OWN "primary" styling (never an agent-supplied style). Clicking an option
 * does NOT run agent code — it composes a plain-text reply (the `label`) in the
 * thread; see {@link RichMessageContent}'s `ondecision` callback.
 */
export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

/**
 * An interactive Q&A prompt: a question plus a closed list of options rendered
 * as buttons in HQ DMs, with an optional free-text "Other". This is the one
 * interactive block kind; its interactivity is confined to the host `ondecision`
 * callback (a reply send), not agent-authored markup or handlers. `questionId`
 * correlates the answer back to the agent's pending clarify; the transport is
 * still plain text (the reply body is the chosen `label`).
 */
export interface DecisionBlock {
  kind: "decision";
  question: string;
  options: DecisionOption[];
  /** Whether a free-text "Other…" affordance is offered (default true). */
  allowOther: boolean;
  /** Opaque id echoed back for correlation; never rendered. */
  questionId?: string;
}

export type RichBlock =
  | StatBlock
  | TableBlock
  | ChartBlock
  | MarkdownBlock
  | BadgeBlock
  | KeyValueBlock
  | ProgressBlock
  | CalloutBlock
  | DecisionBlock;

export interface RichContentModel {
  blocks: RichBlock[];
}

/** Block-type names the schema knows about (informational; genui is gated). */
export const KNOWN_BLOCK_KINDS = new Set<string>([
  "stat",
  "table",
  "chart",
  "markdown",
  "badge",
  "keyValue",
  "progress",
  "callout",
  "decision",
]);

/** Hard caps so a hostile/oversized payload cannot freeze the render loop. */
const MAX_BLOCKS = 20;
const MAX_STAT_ITEMS = 12;
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_ROWS = 100;
const MAX_CHART_SERIES = 8;
const MAX_CHART_POINTS = 200;
const MAX_TEXT_LEN = 4_000;
const MAX_CELL_LEN = 500;
const MAX_LABEL_LEN = 200;
const MAX_KV_ITEMS = 50;
const MAX_DECISION_OPTIONS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce any scalar into a bounded, control-char-stripped plain string. This is
 * the sanitizer that makes the contract safe: everything an agent supplies for
 * a stat/table/chart becomes inert text. It never escapes HTML (the Svelte
 * renderers do that at bind time) — it only removes control characters and caps
 * length so the value cannot smuggle terminal/format tricks or blow the layout.
 */
export function toSafeText(value: unknown, maxLen = MAX_CELL_LEN): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" && Number.isFinite(value))
    text = String(value);
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else text = "";
  // Strip C0/C1 control characters (except normal whitespace) so nothing can
  // inject escape sequences into the render path.
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  if (text.length > maxLen) text = `${text.slice(0, maxLen)}…`;
  return text;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseAlign(value: unknown): BlockAlign | null {
  return value === "left" || value === "center" || value === "right"
    ? value
    : null;
}

/** Coerce any agent value to a valid {@link BadgeTone}; unknown → `neutral`. */
function parseBadgeTone(value: unknown): BadgeTone {
  return value === "success" ||
    value === "warning" ||
    value === "danger" ||
    value === "accent" ||
    value === "neutral"
    ? value
    : "neutral";
}

/** Coerce any agent value to a valid {@link CalloutTone}; unknown → `info`. */
function parseCalloutTone(value: unknown): CalloutTone {
  return value === "success" || value === "warning" || value === "danger" || value === "info"
    ? value
    : "info";
}

function parseStatBlock(raw: Record<string, unknown>): StatBlock | null {
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const items: StatItem[] = [];
  for (const entry of rawItems.slice(0, MAX_STAT_ITEMS)) {
    if (!isRecord(entry)) continue;
    const label = toSafeText(entry.label, MAX_LABEL_LEN);
    const value = toSafeText(entry.value, MAX_LABEL_LEN);
    if (!label && !value) continue;
    const trend =
      entry.trend === "up" || entry.trend === "down" || entry.trend === "flat"
        ? entry.trend
        : undefined;
    const deltaText = toSafeText(entry.delta, MAX_LABEL_LEN);
    items.push({
      label,
      value,
      ...(deltaText ? { delta: deltaText } : {}),
      ...(trend ? { trend } : {}),
    });
  }
  return items.length > 0 ? { kind: "stat", items } : null;
}

function parseTableBlock(raw: Record<string, unknown>): TableBlock | null {
  const columns = (Array.isArray(raw.columns) ? raw.columns : [])
    .slice(0, MAX_TABLE_COLUMNS)
    .map((c) => toSafeText(c, MAX_LABEL_LEN));
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
  const width = Math.max(
    columns.length,
    ...rawRows.map((r) => (Array.isArray(r) ? r.length : 0)),
    0,
  );
  if (width === 0) return null;
  const rows: string[][] = [];
  for (const rawRow of rawRows.slice(0, MAX_TABLE_ROWS)) {
    const cells = Array.isArray(rawRow) ? rawRow : [rawRow];
    const row: string[] = [];
    for (let i = 0; i < width; i += 1) row.push(toSafeText(cells[i]));
    rows.push(row);
  }
  if (columns.length === 0 && rows.length === 0) return null;
  const align = (Array.isArray(raw.align) ? raw.align : [])
    .slice(0, width)
    .map((a) => parseAlign(a) ?? "left");
  const caption = toSafeText(raw.caption, MAX_LABEL_LEN);
  return {
    kind: "table",
    columns,
    rows,
    ...(align.length > 0 ? { align } : {}),
    ...(caption ? { caption } : {}),
  };
}

function parseChartBlock(raw: Record<string, unknown>): ChartBlock | null {
  const chartType = raw.chartType === "bar" ? "bar" : "line";
  const rawSeries = Array.isArray(raw.series) ? raw.series : [];
  const series: ChartSeries[] = [];
  for (const entry of rawSeries.slice(0, MAX_CHART_SERIES)) {
    if (!isRecord(entry)) continue;
    const data = (Array.isArray(entry.data) ? entry.data : [])
      .slice(0, MAX_CHART_POINTS)
      .map((n) => toFiniteNumber(n))
      .filter((n): n is number => n !== null);
    if (data.length === 0) continue;
    series.push({ name: toSafeText(entry.name, MAX_LABEL_LEN), data });
  }
  if (series.length === 0) return null;
  const categories = (Array.isArray(raw.categories) ? raw.categories : [])
    .slice(0, MAX_CHART_POINTS)
    .map((c) => toSafeText(c, MAX_LABEL_LEN));
  const caption = toSafeText(raw.caption, MAX_LABEL_LEN);
  return {
    kind: "chart",
    chartType,
    series,
    ...(categories.length > 0 ? { categories } : {}),
    ...(caption ? { caption } : {}),
  };
}

function parseMarkdownBlock(raw: Record<string, unknown>): MarkdownBlock | null {
  // Mirror the callout tolerance: accept a `body` alias for prose that arrived
  // under the callout's field name. `text` still wins when both are present.
  // Data-only — routed through the same CSP-safe renderer via `toSafeText`.
  const text = toSafeText(raw.text ?? raw.body, MAX_TEXT_LEN);
  return text ? { kind: "markdown", text } : null;
}

function parseBadgeBlock(raw: Record<string, unknown>): BadgeBlock | null {
  const label = toSafeText(raw.label, MAX_LABEL_LEN);
  if (!label) return null;
  return { kind: "badge", label, tone: parseBadgeTone(raw.tone) };
}

function parseKeyValueBlock(raw: Record<string, unknown>): KeyValueBlock | null {
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const items: KeyValueRow[] = [];
  for (const entry of rawItems.slice(0, MAX_KV_ITEMS)) {
    if (!isRecord(entry)) continue;
    const key = toSafeText(entry.key, MAX_LABEL_LEN);
    const value = toSafeText(entry.value, MAX_CELL_LEN);
    if (!key && !value) continue;
    items.push({ key, value });
  }
  return items.length > 0 ? { kind: "keyValue", items } : null;
}

function parseProgressBlock(raw: Record<string, unknown>): ProgressBlock | null {
  const value = toFiniteNumber(raw.value);
  if (value === null) return null;
  const clamped = Math.min(100, Math.max(0, value));
  const label = toSafeText(raw.label, MAX_LABEL_LEN);
  // Only carry a tone when the agent supplied one; an unknown value collapses
  // to `neutral` rather than a raw pass-through.
  const tone = raw.tone != null ? parseBadgeTone(raw.tone) : undefined;
  return {
    kind: "progress",
    ...(label ? { label } : {}),
    value: clamped,
    ...(tone ? { tone } : {}),
  };
}

function parseCalloutBlock(raw: Record<string, unknown>): CalloutBlock | null {
  // Tolerate the common emitter mix-up where a callout's prose arrives under
  // `text` (the `markdown` block's field name) instead of the documented
  // `body`. The alias is data-only: it feeds the SAME CSP-safe markdown
  // renderer via `toSafeText`, adding no new markup path. `body` still wins
  // when both are present.
  const body = toSafeText(raw.body ?? raw.text, MAX_TEXT_LEN);
  if (!body) return null;
  const title = toSafeText(raw.title, MAX_LABEL_LEN);
  return {
    kind: "callout",
    tone: parseCalloutTone(raw.tone),
    ...(title ? { title } : {}),
    body,
  };
}

function parseDecisionBlock(raw: Record<string, unknown>): DecisionBlock | null {
  const question = toSafeText(raw.question, MAX_TEXT_LEN);
  if (!question) return null;
  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  const options: DecisionOption[] = [];
  let sawRecommended = false;
  for (const [i, entry] of rawOptions.slice(0, MAX_DECISION_OPTIONS).entries()) {
    // Tolerate a bare string option (label only).
    if (typeof entry === "string") {
      const label = toSafeText(entry, MAX_LABEL_LEN);
      if (!label) continue;
      options.push({ id: String(i + 1), label });
      continue;
    }
    if (!isRecord(entry)) continue;
    const label = toSafeText(entry.label, MAX_LABEL_LEN);
    if (!label) continue;
    const id = toSafeText(entry.id, MAX_LABEL_LEN) || String(i + 1);
    const description = toSafeText(entry.description, MAX_CELL_LEN);
    // At most one option is styled recommended (first wins).
    const recommended = entry.recommended === true && !sawRecommended;
    if (recommended) sawRecommended = true;
    options.push({
      id,
      label,
      ...(description ? { description } : {}),
      ...(recommended ? { recommended: true } : {}),
    });
  }
  if (options.length === 0) return null;
  const questionId = toSafeText(raw.questionId, MAX_LABEL_LEN);
  return {
    kind: "decision",
    question,
    options,
    // Free-text "Other" is offered unless explicitly disabled.
    allowOther: raw.allowOther !== false,
    ...(questionId ? { questionId } : {}),
  };
}

function parseBlock(raw: unknown): RichBlock | null {
  if (!isRecord(raw)) return null;
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  switch (kind) {
    case "stat":
      return parseStatBlock(raw);
    case "table":
      return parseTableBlock(raw);
    case "chart":
      return parseChartBlock(raw);
    case "markdown":
      return parseMarkdownBlock(raw);
    case "badge":
      return parseBadgeBlock(raw);
    case "keyValue":
      return parseKeyValueBlock(raw);
    case "progress":
      return parseProgressBlock(raw);
    case "callout":
      return parseCalloutBlock(raw);
    case "decision":
      return parseDecisionBlock(raw);
    // `genui` (and any future arbitrary-markup kind) is DESIGN-ONLY and gated.
    // While GENUI_ENABLED is false it is dropped here so nothing renders.
    case "genui":
      return null;
    default:
      return null;
  }
}

/**
 * Parse a rich-content envelope into a render model.
 *
 * Absent-safe rules (mirrors `parseSystemEvent`):
 * - null / non-object → null
 * - `v` present and not 1 → null (unknown version)
 * - `blocks` not an array, or no block parses → null (render the text fallback)
 * - unknown / gated block kinds are dropped, not fatal
 */
export function parseRichContent(raw: unknown): RichContentModel | null {
  if (!isRecord(raw)) return null;
  if ("v" in raw && raw.v !== RICH_CONTENT_VERSION && raw.v !== "1") return null;
  const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : null;
  if (!rawBlocks) return null;
  const blocks: RichBlock[] = [];
  for (const entry of rawBlocks.slice(0, MAX_BLOCKS)) {
    const block = parseBlock(entry);
    if (block) blocks.push(block);
  }
  return blocks.length > 0 ? { blocks } : null;
}

export interface ExtractedRichContent {
  /** The message body with any hq-block fence removed — the text fallback. */
  text: string;
  /** Parsed structured content, or null when there is none / it is invalid. */
  rich: RichContentModel | null;
}

const HQ_BLOCK_FENCE_RE = new RegExp(
  "(^|\\n)[ \\t]*(`{3,}|~{3,})[ \\t]*" +
    HQ_BLOCK_FENCE_LANG +
    "[ \\t]*\\n([\\s\\S]*?)\\n[ \\t]*\\2[ \\t]*(?=\\n|$)",
  "i",
);

/**
 * Extract a single ```hq-block fenced JSON envelope from a message body.
 *
 * This is the mechanism a fleet agent can reliably produce with no server
 * support: it emits a plain-text answer AND a fenced block. The client lifts
 * the fence into structured content and shows the surrounding prose as the
 * plain-text fallback. If the fence is missing or the JSON is invalid, the body
 * is returned untouched so it degrades to ordinary markdown (never a crash).
 *
 * Prefers an explicit `richContent` wire field over the fence when both exist;
 * see `richContentForMessage`.
 */
export function extractRichContentFromBody(body: string): ExtractedRichContent {
  if (!body || !body.includes(HQ_BLOCK_FENCE_LANG)) {
    return { text: body ?? "", rich: null };
  }
  const match = HQ_BLOCK_FENCE_RE.exec(body);
  if (!match) return { text: body, rich: null };
  let rich: RichContentModel | null = null;
  try {
    rich = parseRichContent(JSON.parse(match[3]));
  } catch {
    rich = null;
  }
  if (!rich) return { text: body, rich: null };
  const text = (body.slice(0, match.index) + body.slice(match.index + match[0].length))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, rich };
}

/**
 * Resolve the structured content + text fallback for a message row.
 *
 * Precedence: an explicit `richContent` wire field (server passthrough) wins;
 * otherwise fall back to lifting an `hq-block` fence out of the body. The
 * returned `text` is ALWAYS a valid plain-text fallback for the bubble.
 */
export function richContentForMessage(message: {
  body?: string | null;
  richContent?: unknown;
}): ExtractedRichContent {
  const body = message.body ?? "";
  const fromField = parseRichContent(message.richContent);
  if (fromField) return { text: body, rich: fromField };
  return extractRichContentFromBody(body);
}

/**
 * Reduce a single block to a plain-text line. Every block kind must contribute
 * a sensible, human-readable projection so a text-only surface (notification,
 * old client, screen reader summary) still conveys the block's content. Values
 * are already sanitized by the parser, so this only joins them.
 */
function blockToPlainText(block: RichBlock): string {
  switch (block.kind) {
    case "markdown":
      return block.text;
    case "stat":
      return block.items
        .map(
          (i) =>
            `${i.label}: ${i.value}${i.delta ? ` (${i.delta})` : ""}`.trim(),
        )
        .join("  ·  ");
    case "table": {
      const header = block.columns.length > 0 ? block.columns.join(" | ") : "";
      const rows = block.rows.map((r) => r.join(" | "));
      return [block.caption, header, ...rows].filter(Boolean).join("\n");
    }
    case "chart":
      return (
        block.caption ||
        `${block.chartType} chart: ${block.series.map((s) => s.name).filter(Boolean).join(", ")}`.trim()
      );
    case "badge":
      return block.label;
    case "keyValue":
      return block.items
        .map((row) => `${row.key}: ${row.value}`.trim().replace(/^:\s*/, ""))
        .join("\n");
    case "progress":
      return `${block.label ? `${block.label}: ` : ""}${block.value}%`;
    case "callout":
      return `${block.title ? `${block.title} — ` : ""}${block.body}`;
    case "decision":
      return [
        block.question,
        ...block.options.map(
          (o, i) =>
            `  ${i + 1}. ${o.label}${o.recommended ? " (Recommended)" : ""}`,
        ),
      ].join("\n");
    default:
      return "";
  }
}

/**
 * Project a parsed rich-content model down to a plain-text fallback. This backs
 * the "rich content is always additive" guarantee for surfaces that cannot
 * render blocks: each block contributes readable text, joined with blank lines.
 */
export function richContentToPlainText(model: RichContentModel): string {
  return model.blocks
    .map((block) => blockToPlainText(block))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
