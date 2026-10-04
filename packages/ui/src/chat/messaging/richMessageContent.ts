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
 * schema) and owner sign-off. It is not supported: the parser drops every
 * `genui` block, so no agent markup can render.
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

/**
 * The setup bot's "setup is finished" signal. Carries no data: the host sees
 * it in the setup bot's conversation and shows the finish card (open in a
 * coding tool, the HQ console, a Slack bot) under the last message. Renders
 * nothing by itself and adds nothing to the text fallback.
 */
export interface SetupDoneBlock {
  kind: "setupDone";
  /**
   * The finish card offers to put the bot in Slack. The bot sets it only for
   * someone who started their own company; absent = no offer.
   */
  slackAgent?: boolean;
}

/**
 * Suggested replies: two to four short answers or next questions the agent
 * writes for its own message, so the person always has an easy way to carry
 * on. Like `setupDone` it renders nothing inline; the host decides where (and
 * whether) to show them, and a click sends the chosen text as the person's
 * reply. Items are sanitized plain text.
 */
export interface SuggestionsBlock {
  kind: "suggestions";
  items: string[];
}

/**
 * The built-in cards a {@link ConnectItem} can name. A closed list. `tools`
 * is legacy: old messages still draw the generic tools card, but it is no
 * longer advertised to a bot.
 */
export type ConnectTarget = "slack" | "tools";

/** One card a bot asks for in a {@link ConnectBlock}. Exactly one of `app` or `domain` is set. */
export interface ConnectItem {
  /** A built-in card: "slack" (or "tools", legacy only). */
  app?: ConnectTarget;
  /** An integration named by its website domain, e.g. "linear.app". Normalized. */
  domain?: string;
  /** The bot's short reason, sanitized text, at most 80 characters. */
  why?: string;
  /**
   * The connection this card is for. Set by the app alone, on the cards it
   * chooses itself from the company's list (`appChosenItems`), so such a card
   * is tied to that one connection and not to whichever one shares its
   * domain. Never read from a bot's block: the parser takes `app`, `domain`
   * and `why` and nothing else.
   */
  connectionId?: string;
}

/**
 * A bot's offer to connect apps, drawn as one card per item inside the
 * message. Data-only and deliberately bare: an item carries a built-in card
 * name or a website domain, and an optional sanitized reason. The bot never
 * supplies a link, a label, a logo or a style. The app writes every sentence
 * a card states, builds every link itself and draws every logo from its own
 * bundled marks, so nothing an agent emits can send a person, or the app, to
 * an address of the agent's choosing. The reason is shown under the app's
 * own sentence with the bot's name on it, never in its place. A press does NOT
 * run agent code; it goes to the host through {@link RichMessageContent}'s
 * `connections.onaction`. The old form `targets: ["slack", "tools"]` is still
 * read and becomes items.
 */
export interface ConnectBlock {
  kind: "connect";
  items: ConnectItem[];
}

export type RichBlock =
  | SetupDoneBlock
  | SuggestionsBlock
  | ConnectBlock
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

/** Block-type names the schema knows about (informational; genui is unsupported). */
export const KNOWN_BLOCK_KINDS = new Set<string>([
  "setupDone",
  "suggestions",
  "connect",
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
/** How many suggested replies one message may carry, across every `suggestions` block and envelope. */
const MAX_SUGGESTIONS = 4;
const MAX_SUGGESTION_LEN = 80;

/**
 * Block kinds the host places itself (a finish card, reply buttons) rather
 * than drawing inside the message bubble. They add nothing to the bubble and
 * a message carrying only these has no visible content of its own.
 */
export const HOST_PLACED_BLOCK_KINDS: ReadonlySet<RichBlock["kind"]> = new Set([
  "setupDone",
  "suggestions",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unicode format characters (category Cf: the bidi overrides, embeddings and
 * isolates, the zero-width marks, the BOM, the soft hyphen) and the whole tag
 * block U+E0000 to U+E007F. None of them draws anything, and each can make a
 * label read as something other than what it says: a bidi override reverses
 * it, a zero-width mark hides a second word in it, a run of tag characters
 * carries text nobody sees.
 */
const INVISIBLE_FORMAT_RE = /[\p{Cf}\u{E0000}-\u{E007F}]/gu;

/**
 * The first `max` code points of a string, or null when it has no more than
 * that. Counted in code points, so the cut never lands inside a surrogate
 * pair and leaves half a character.
 */
function firstCodePoints(text: string, max: number): string | null {
  // A string has at most as many code points as UTF-16 units.
  if (text.length <= max) return null;
  let count = 0;
  let i = 0;
  while (i < text.length) {
    if (count === max) return text.slice(0, i);
    const point = text.codePointAt(i) ?? 0;
    i += point > 0xffff ? 2 : 1;
    count += 1;
  }
  return null;
}

/**
 * Coerce any scalar into a bounded, control-char-stripped plain string. This is
 * the sanitizer that makes the contract safe: everything an agent supplies for
 * a stat/table/chart becomes inert text. It never escapes HTML (the Svelte
 * renderers do that at bind time) — it only removes control characters and caps
 * length so the value cannot smuggle terminal/format tricks or blow the layout.
 *
 * The cap counts code points. `stripFormat` also removes the invisible format
 * characters ({@link INVISIBLE_FORMAT_RE}); it is on for the short labels a
 * person presses or reads on a card (a suggested reply, a connect reason),
 * where what is drawn must be all there is.
 */
export function toSafeText(value: unknown, maxLen = MAX_CELL_LEN, options: { stripFormat?: boolean } = {}): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" && Number.isFinite(value))
    text = String(value);
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else text = "";
  // Strip C0/C1 control characters (except normal whitespace) so nothing can
  // inject escape sequences into the render path.
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  if (options.stripFormat) text = text.replace(INVISIBLE_FORMAT_RE, "");
  const head = firstCodePoints(text, maxLen);
  if (head !== null) text = `${head}…`;
  return text;
}

/**
 * A short label a person presses or reads on a card: one line, no control
 * and no invisible format characters, single spaces, at most `maxLen` code
 * points with the ellipsis counted in.
 */
function toSafeLabel(value: unknown, maxLen: number): string {
  // Collapse the spaces first, so the cap is spent on what is drawn; room is
  // left for the ellipsis toSafeText adds, so a label never exceeds the cap.
  const flat = toSafeText(value, Number.MAX_SAFE_INTEGER, { stripFormat: true }).replace(/\s+/g, " ").trim();
  return toSafeText(flat, maxLen - 1).trim();
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

function parseSuggestionsBlock(raw: Record<string, unknown>): SuggestionsBlock | null {
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const items: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawItems) {
    if (items.length >= MAX_SUGGESTIONS) break;
    const source = isRecord(entry) ? entry.label : entry;
    const label = toSafeLabel(source, MAX_SUGGESTION_LEN);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    items.push(label);
  }
  return items.length > 0 ? { kind: "suggestions", items } : null;
}

/** The built-in cards the old `targets` form may name. */
const CONNECT_TARGETS: readonly ConnectTarget[] = ["slack", "tools"];
/**
 * How many cards one message may ask for, across every `connect` block and
 * every envelope it carries. More than three is decision overload.
 */
export const MAX_CONNECT_ITEMS = 3;
const MAX_CONNECT_WHY_LEN = 80;
const MAX_CONNECT_DOMAIN_LEN = 80;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Last labels that never name a public website: the reserved and the private
 * names (RFC 2606, RFC 6761, RFC 6762, and the `.internal` private-use name).
 */
const NON_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set(["localhost", "local", "internal", "test", "invalid", "example"]);

/**
 * A website domain as a `connect` item names it: lower-cased, trimmed, the
 * `www.` and `mcp.` prefixes removed, letters, digits, dots and hyphens only,
 * at least one dot, at most 80 characters. Anything else is null. The same
 * rule normalizes a connection's domain, so the two compare as equals.
 *
 * A name that is not a public website is null too: an address written in
 * numbers (a last label of digits, or a `0x` one, is how a URL parser reads
 * an IPv4 address), `localhost` and names under it, names under `.local`,
 * `.internal`, `.test`, `.invalid` and `.example`, and any punycode label
 * (`xn--`), which can draw as letters that look like another brand's.
 */
export function normalizeConnectDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let domain = value.trim().toLowerCase();
  // A pasted address is still a domain: keep its host.
  domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "");
  while (/^(www|mcp)\./.test(domain)) domain = domain.replace(/^(www|mcp)\./, "");
  if (!domain || domain.length > MAX_CONNECT_DOMAIN_LEN || !HOSTNAME.test(domain)) return null;
  const labels = domain.split(".");
  const last = labels[labels.length - 1] ?? "";
  if (/^(\d+|0x[0-9a-f]*)$/.test(last)) return null;
  if (NON_PUBLIC_SUFFIXES.has(last)) return null;
  if (labels.some((label) => label.startsWith("xn--"))) return null;
  return domain;
}

function parseConnectItem(entry: unknown): ConnectItem | null {
  if (typeof entry === "string") {
    // The old form: a bare target name.
    const target = CONNECT_TARGETS.find((known) => known === entry);
    return target ? { app: target } : null;
  }
  if (!isRecord(entry)) return null;
  // Only `app`, `domain` and `why` are read. A url, label, logo or style the
  // agent adds is ignored: the app builds every link and writes every word.
  const why = toSafeLabel(entry.why, MAX_CONNECT_WHY_LEN);
  const withWhy = (item: ConnectItem): ConnectItem => (why ? { ...item, why } : item);
  if (entry.app !== undefined) {
    // Only Slack is a built-in a bot may name in the new form.
    return entry.app === "slack" ? withWhy({ app: "slack" }) : null;
  }
  const domain = normalizeConnectDomain(entry.domain);
  return domain ? withWhy({ domain }) : null;
}

function parseConnectBlock(raw: Record<string, unknown>): ConnectBlock | null {
  // `items` is the form a bot is told about; `targets` is the old form. When
  // a block carries `items`, that is what is read.
  const source = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.targets) ? raw.targets : [];
  const items: ConnectItem[] = [];
  const seen = new Set<string>();
  for (const entry of source) {
    if (items.length >= MAX_CONNECT_ITEMS) break;
    const item = parseConnectItem(entry);
    if (!item) continue;
    const key = connectItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items.length > 0 ? { kind: "connect", items } : null;
}

function connectItemKey(item: ConnectItem): string {
  return item.app ? `app:${item.app}` : `domain:${item.domain}`;
}

/**
 * Apply the per-message caps. A message draws one row of cards and one row
 * of suggested replies, however many blocks or envelopes it was written as:
 * every `connect` block is merged into the first one (each app once, at most
 * {@link MAX_CONNECT_ITEMS} cards), and every `suggestions` block into the
 * first one (each reply once, at most {@link MAX_SUGGESTIONS}). Other blocks
 * keep their place. Hands back the same array when there is nothing to merge.
 */
function withMessageCaps(blocks: RichBlock[]): RichBlock[] {
  const connects = blocks.filter((block): block is ConnectBlock => block.kind === "connect");
  const suggestions = blocks.filter((block): block is SuggestionsBlock => block.kind === "suggestions");
  if (connects.length <= 1 && suggestions.length <= 1) return blocks;
  const items: ConnectItem[] = [];
  const seenItems = new Set<string>();
  for (const item of connects.flatMap((block) => block.items)) {
    if (items.length >= MAX_CONNECT_ITEMS) break;
    const key = connectItemKey(item);
    if (seenItems.has(key)) continue;
    seenItems.add(key);
    items.push(item);
  }
  const replies: string[] = [];
  const seenReplies = new Set<string>();
  for (const reply of suggestions.flatMap((block) => block.items)) {
    if (replies.length >= MAX_SUGGESTIONS) break;
    const key = reply.toLowerCase();
    if (seenReplies.has(key)) continue;
    seenReplies.add(key);
    replies.push(reply);
  }
  const out: RichBlock[] = [];
  let connectPlaced = false;
  let suggestionsPlaced = false;
  for (const block of blocks) {
    if (block.kind === "connect") {
      if (!connectPlaced) out.push({ kind: "connect", items });
      connectPlaced = true;
    } else if (block.kind === "suggestions") {
      if (!suggestionsPlaced) out.push({ kind: "suggestions", items: replies });
      suggestionsPlaced = true;
    } else {
      out.push(block);
    }
  }
  return out;
}

/** The name a `connect` item reads as in plain text: "Slack", "your tools", "Linear". */
export function connectItemLabel(item: ConnectItem): string {
  if (item.app === "slack") return "Slack";
  if (item.app === "tools") return "your tools";
  const first = (item.domain ?? "").split(".")[0] ?? "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "an app";
}

/** "Linear, Notion or Slack": a short list in prose. */
function proseList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

function parseBlock(raw: unknown): RichBlock | null {
  if (!isRecord(raw)) return null;
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  switch (kind) {
    case "setupDone":
      return raw.slackAgent === true ? { kind: "setupDone", slackAgent: true } : { kind: "setupDone" };
    case "suggestions":
      return parseSuggestionsBlock(raw);
    case "connect":
      return parseConnectBlock(raw);
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
    // `genui` (and any future arbitrary-markup kind) is unsupported and drops.
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
 * - several `connect` or `suggestions` blocks become one of each, under the
 *   per-message caps
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
  return blocks.length > 0 ? { blocks: withMessageCaps(blocks) } : null;
}

export interface ExtractedRichContent {
  /** The message body with any hq-block fence removed — the text fallback. */
  text: string;
  /** Parsed structured content, or null when there is none / it is invalid. */
  rich: RichContentModel | null;
}

/**
 * Which envelopes in a body are lifted, and what each may carry.
 *
 * The envelope is machine text, and a person must never see it. Bots on
 * older runtimes write it in every shape: in an ```hq-block fence, in a fence
 * labelled `json` or not labelled at all, on a bare line, pretty-printed, in
 * the middle of a message or at its end. So an envelope is FOUND wherever it
 * is, exactly as the app has always found it: the body is scanned for a
 * balanced JSON object that parses as an envelope, and that object (with the
 * fence around it) is cut from the text. Every block kind the app drew before
 * the connection cards (a table, a chart, a decision, suggested replies, the
 * setup finish marker and the rest) is lifted from any of those places.
 *
 * A `connect` block is held to a stricter place ({@link STRICT_PLACEMENT_KINDS}),
 * because it draws live buttons that give a bot access to an app. It is kept
 * only from where a bot writes its own envelope on purpose:
 *
 * 1. a top-level code fence labelled `hq-block` whose whole content is the
 *    envelope, anywhere in the body; or
 * 2. the last thing in the message: one envelope on its own after the prose,
 *    or one fence (any label, or none) whose whole content is the envelope.
 *
 * Anywhere else (an example in a ```json fence with more of the message after
 * it, an envelope inside a larger JSON object, an array or a quoted string,
 * one in the middle of a sentence, an `hq-block` fence inside another fence)
 * the `connect` block is dropped and no card is drawn. The text is left
 * exactly as it was before connection cards existed, when `connect` was a
 * kind the app did not know: the envelope is cut when it is a versioned
 * envelope or carries another block the app draws, and stays otherwise.
 *
 * Whose message it is cannot be told here. The cards are drawn only under a
 * message the bot of the direct message sent (connection-card-model.ts,
 * `messageMayDrawCards`).
 */
interface EnvelopeSpan {
  /** Index of the first character to cut. */
  start: number;
  /** Index after the last character to cut. */
  end: number;
  /**
   * The envelope itself, or null for a well-formed envelope whose blocks this
   * version does not know (a newer kind). That envelope is still cut from the
   * text, so a newer agent never shows raw machine text to an older app.
   */
  rich: RichContentModel | null;
}

/**
 * The block kinds lifted only from a strict place (see {@link EnvelopeSpan}).
 * Every other kind is lifted wherever its envelope is found.
 */
const STRICT_PLACEMENT_KINDS: ReadonlySet<RichBlock["kind"]> = new Set<RichBlock["kind"]>(["connect"]);

/**
 * How much scanning one body may cost, in characters read. The scan below
 * starts over at every `{` that looks like the start of an envelope, so a
 * body made of thousands of those costs its length squared (2.8 s at 100 KB).
 * A message the server accepts (4,000 characters) cannot cost more than this,
 * so every real message is scanned in full. A body that runs out is finished
 * by one linear pass ({@link strictEnvelopeSpans}).
 */
const MAX_ENVELOPE_SCAN_WORK = 20_000_000;

interface ScanBudget {
  left: number;
  exhausted: boolean;
}

/** End index of the JSON object starting at `open`, or -1. String-aware, so a
 *  brace inside a quoted value cannot end it early. Never reads past `limit`,
 *  nor past what is left of `budget`. */
function jsonObjectEnd(body: string, open: number, limit = body.length, budget?: ScanBudget): number {
  const stop = budget ? Math.min(limit, open + Math.max(0, budget.left)) : limit;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < stop; i += 1) {
    const ch = body[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        if (budget) budget.left -= i + 1 - open;
        return i + 1;
      }
    }
  }
  if (budget) {
    budget.left -= stop - open;
    if (stop < limit) budget.exhausted = true;
  }
  return -1;
}

/** Widen a span over a code fence that wraps it, so no empty fence is left. */
function withSurroundingFence(body: string, start: number, end: number): [number, number] {
  const before = body.slice(0, start);
  const openFence = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*[A-Za-z0-9_-]*[ \t]*\n[ \t]*$/.exec(before);
  if (!openFence) return [start, end];
  const rest = body.slice(end);
  const closeFence = new RegExp("^[ \\t]*\\n?[ \\t]*" + openFence[2] + "[ \\t]*").exec(rest);
  if (!closeFence) return [start, end];
  return [start - (openFence[0].length - openFence[1].length), end + closeFence[0].length];
}

/**
 * A versioned envelope (`{"v": 1, "blocks": [{"kind": …}, …]}`) in which every
 * block names a kind, none of which this version parses. Recognised as ours so
 * it can be lifted out of the text instead of shown as JSON.
 */
function isUnknownEnvelope(raw: unknown): boolean {
  if (!isRecord(raw) || raw.v !== RICH_CONTENT_VERSION || !Array.isArray(raw.blocks)) return false;
  return raw.blocks.length > 0 && raw.blocks.every((b) => isRecord(b) && typeof b.kind === "string");
}

/**
 * Read text that should be exactly one envelope. `undefined` when it is not
 * one (not JSON, not an object, or JSON that is not an envelope); else the
 * model, or null for an envelope of blocks this version does not know.
 */
function envelopeFrom(source: string): RichContentModel | null | undefined {
  const text = source.trim();
  if (!text.startsWith("{") || !text.endsWith("}") || !text.includes('"blocks"')) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const rich = parseRichContent(raw);
  if (rich) return rich;
  return isUnknownEnvelope(raw) ? null : undefined;
}

/** One code fence at the top level of a body (never one inside another fence). */
interface CodeFence {
  /** Index of the first character of the opening line. */
  start: number;
  /** Index after the closing line (without its newline), or the body's end for a fence left open. */
  end: number;
  /** The first word after the opening marks, lower-cased; "" for none. */
  label: string;
  contentStart: number;
  contentEnd: number;
}

// A body can come with CRLF line endings. Lines are split at "\n", so each
// then ends in "\r": the closing line allows for it (the opening line's
// label stops at it, and the rest of that line takes it).
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\s`]*)([^\n]*)$/;
const FENCE_CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/;

/**
 * The top-level code fences of a body, in order. One pass over its lines, the
 * way markdown reads them: a fence opens on a line of three or more backticks
 * or tildes (with an optional label) and closes on a line of at least as many
 * of the same mark and nothing else. Every line in between is its content,
 * a line that looks like another fence included. A fence left open runs to
 * the end.
 */
function topLevelFences(body: string): CodeFence[] {
  const fences: CodeFence[] = [];
  let open: { start: number; mark: string; label: string; contentStart: number } | null = null;
  let lineStart = 0;
  while (lineStart <= body.length) {
    const newline = body.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? body.length : newline;
    const line = body.slice(lineStart, lineEnd);
    if (open) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1]![0] === open.mark[0] && close[1]!.length >= open.mark.length) {
        fences.push({
          start: open.start,
          end: lineEnd,
          label: open.label,
          contentStart: open.contentStart,
          contentEnd: Math.max(open.contentStart, lineStart - 1),
        });
        open = null;
      }
    } else if (line.includes("```") || line.includes("~~~")) {
      const opened = FENCE_OPEN_RE.exec(line);
      // A backtick fence's label line holds no backtick: one that does is inline code.
      if (opened && !(opened[1]![0] === "`" && opened[3]!.includes("`"))) {
        open = {
          start: lineStart,
          mark: opened[1]!,
          label: opened[2]!.toLowerCase(),
          contentStart: Math.min(body.length, lineEnd + 1),
        };
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (open) {
    fences.push({ start: open.start, end: body.length, label: open.label, contentStart: open.contentStart, contentEnd: body.length });
  }
  return fences;
}

/** How many envelopes one body is lifted for: a bound on the work, never reached by a real message. */
const MAX_ENVELOPES = MAX_BLOCKS;
/**
 * A body longer than this is not scanned for envelopes at all: it is shown as
 * text. It is far past anything the server accepts as one message.
 */
export const MAX_ENVELOPE_SCAN_CHARS = 256_000;
/** How far back from the end of a body an envelope written with no fence may start. */
const MAX_BARE_ENVELOPE_CHARS = 64_000;
/** How many unbalanced `{` are tried before the search for a bare envelope stops. */
const MAX_BARE_ENVELOPE_TRIES = 16;

/** Where a body's fences are and where its last character that is not a space is. Worked out once per body, when asked. */
interface BodyLayout {
  fences: CodeFence[];
  tailEnd: number;
}

/**
 * Where the object at `[start, end)` sits: the top-level fence whose whole
 * content it is (or null), and whether that is a strict place (see
 * {@link EnvelopeSpan}).
 */
function placementOf(body: string, layout: BodyLayout, start: number, end: number): { strict: boolean; wholeFence: CodeFence | null } {
  const fence = layout.fences.find((f) => start >= f.contentStart && start < Math.max(f.contentEnd, f.end));
  if (!fence) return { strict: end === layout.tailEnd, wholeFence: null };
  const whole =
    end <= fence.contentEnd &&
    body.slice(fence.contentStart, start).trim() === "" &&
    body.slice(end, fence.contentEnd).trim() === "";
  if (!whole) return { strict: false, wholeFence: null };
  return { strict: fence.label === HQ_BLOCK_FENCE_LANG || fence.end >= layout.tailEnd, wholeFence: fence };
}

/**
 * The first envelope in a body, found the way the app has always found one: a
 * balanced JSON object, anywhere, that parses as an envelope. Blocks of a
 * strict kind are kept only from a strict place; an object left with nothing
 * the app draws, and that is not a versioned envelope, is no envelope here
 * and stays in the text.
 */
function findEnvelopeSpan(body: string, budget: ScanBudget): EnvelopeSpan | null {
  if (!body.includes('"blocks"')) return null;
  let layout: BodyLayout | null = null;
  for (let i = body.indexOf("{"); i !== -1; i = body.indexOf("{", i + 1)) {
    if (budget.exhausted || budget.left <= 0) {
      budget.exhausted = true;
      return null;
    }
    // Cheap gate: an envelope names its version or its blocks up front.
    const head = body.slice(i, i + 64);
    if (!head.includes('"v"') && !head.includes('"blocks"')) continue;
    const end = jsonObjectEnd(body, i, body.length, budget);
    if (end === -1) continue;
    budget.left -= end - i;
    let raw: unknown = null;
    try {
      raw = JSON.parse(body.slice(i, end));
    } catch {
      continue;
    }
    let rich = parseRichContent(raw);
    if (!rich && !isUnknownEnvelope(raw)) continue;
    layout ??= { fences: topLevelFences(body), tailEnd: body.trimEnd().length };
    const placement = placementOf(body, layout, i, end);
    if (rich && !placement.strict && rich.blocks.some((block) => STRICT_PLACEMENT_KINDS.has(block.kind))) {
      const kept = rich.blocks.filter((block) => !STRICT_PLACEMENT_KINDS.has(block.kind));
      rich = kept.length > 0 ? { blocks: kept } : null;
      if (!rich && !isUnknownEnvelope(raw)) continue;
    }
    let [from, to] = withSurroundingFence(body, i, end);
    // A fence that holds nothing but the envelope goes with it, also where
    // the widening above does not reach (a blank line inside the fence, a
    // fence left open at the end), so no empty fence is left behind.
    if (placement.wholeFence) {
      from = Math.min(from, placement.wholeFence.start);
      to = Math.max(to, placement.wholeFence.end);
    }
    return { start: from, end: to, rich };
  }
  return null;
}

/**
 * The envelope written with no fence at the very end of a body: a JSON object
 * that starts outside every code fence and ends on the body's last character
 * that is not a space. An object that ends earlier is skipped whole, so an
 * envelope nested in a larger object, an array or a quoted string is never
 * found: something always follows it.
 */
function bareTrailingEnvelope(body: string, fences: readonly CodeFence[], tailEnd: number): EnvelopeSpan | null {
  if (body[tailEnd - 1] !== "}") return null;
  const lastFence = fences[fences.length - 1];
  // The end of the body is inside a fence: that is the fenced case, not this one.
  if (lastFence && lastFence.end >= tailEnd) return null;
  const from = Math.max(lastFence ? lastFence.end : 0, tailEnd - MAX_BARE_ENVELOPE_CHARS);
  let tries = 0;
  for (let i = body.indexOf("{", from); i !== -1 && i < tailEnd; ) {
    const end = jsonObjectEnd(body, i, tailEnd);
    if (end === -1) {
      tries += 1;
      if (tries >= MAX_BARE_ENVELOPE_TRIES) return null;
      i = body.indexOf("{", i + 1);
      continue;
    }
    if (end < tailEnd) {
      // A whole object that is not the last thing: nothing inside it is either.
      i = body.indexOf("{", end);
      continue;
    }
    const rich = envelopeFrom(body.slice(i, end));
    return rich === undefined ? null : { start: i, end, rich };
  }
  return null;
}

/**
 * The envelopes in the strict places only, in document order, in one linear
 * pass: every top-level `hq-block` fence whose whole content is an envelope,
 * and the one envelope that is the last thing in the body. Used to finish a
 * body the open-ended scan ran out of budget on, so a bot's own envelope is
 * still lifted from a body built to be slow to scan.
 */
function strictEnvelopeSpans(body: string, max: number): EnvelopeSpan[] {
  if (max <= 0 || !body.includes('"blocks"')) return [];
  const fences = topLevelFences(body);
  const spans: EnvelopeSpan[] = [];
  const tailEnd = body.trimEnd().length;
  for (const fence of fences) {
    if (spans.length >= max) return spans;
    // A fence with another label, or none, counts only as the last thing in the message.
    if (fence.label !== HQ_BLOCK_FENCE_LANG && fence.end < tailEnd) continue;
    const rich = envelopeFrom(body.slice(fence.contentStart, fence.contentEnd));
    if (rich === undefined) continue;
    spans.push({ start: fence.start, end: fence.end, rich });
  }
  const bare = spans.length < max ? bareTrailingEnvelope(body, fences, tailEnd) : null;
  if (bare) spans.push(bare);
  return spans;
}

/**
 * Extract the envelopes from a message body.
 *
 * This is the mechanism a fleet agent can reliably produce with no server
 * support: it emits a plain-text answer AND one or more ```hq-block fenced
 * JSON envelopes. The client lifts each into structured content and shows the
 * surrounding prose as the plain-text fallback. If there is none, or the JSON
 * is invalid, the body is returned untouched so it degrades to ordinary
 * markdown (never a crash).
 *
 * The first envelope is found, cut and read exactly as it always was (see
 * {@link EnvelopeSpan} for where, and for the one kind held to a stricter
 * place). A bot told to end with "a suggestions block, then a connect block"
 * writes two envelopes, and lifting only the first left the second in the
 * text as a code block of JSON. So the scan then goes on: every further
 * envelope is lifted the same way, in document order, their blocks merged
 * into one model under the per-message caps, and every span cut from the
 * text. An envelope whose blocks this version does not know is still cut.
 *
 * Prefers an explicit `richContent` wire field over the fence when both exist;
 * see `richContentForMessage`.
 */
export function extractRichContentFromBody(body: string): ExtractedRichContent {
  if (!body) return { text: "", rich: null };
  if (body.length > MAX_ENVELOPE_SCAN_CHARS) return { text: body, rich: null };
  let text = body;
  const blocks: RichBlock[] = [];
  const budget: ScanBudget = { left: MAX_ENVELOPE_SCAN_WORK, exhausted: false };
  let found = 0;
  for (; found < MAX_ENVELOPES; found += 1) {
    const span = findEnvelopeSpan(text, budget);
    if (!span) break;
    if (span.rich) blocks.push(...span.rich.blocks);
    text = text.slice(0, span.start) + text.slice(span.end);
  }
  if (budget.exhausted) {
    // What is left was too slow to scan openly. One linear pass still lifts
    // the envelopes in the strict places.
    const spans = strictEnvelopeSpans(text, MAX_ENVELOPES - found);
    let rest = "";
    let at = 0;
    for (const span of spans) {
      rest += text.slice(at, span.start);
      at = span.end;
      if (span.rich) blocks.push(...span.rich.blocks);
    }
    text = rest + text.slice(at);
    found += spans.length;
  }
  if (found === 0) return { text: body, rich: null };
  // The prose around what was cut is joined with one blank line, whichever
  // line ending the body uses.
  text = text.replace(/(?:\r?\n){3,}/g, "\n\n").trim();
  return { text, rich: blocks.length > 0 ? { blocks: withMessageCaps(blocks).slice(0, MAX_BLOCKS) } : null };
}

/** How many messages' parsed content is remembered. A long conversation on screen is a few hundred rows. */
const RICH_CONTENT_MEMO_MAX = 600;
/** A body this short is remembered by its own text when the row has no event id. */
const RICH_CONTENT_MEMO_BODY_KEY_MAX = 2_000;

interface RichContentMemoEntry {
  body: string;
  richContent: unknown;
  result: ExtractedRichContent;
}

/**
 * What {@link richContentForMessage} answered, by message. The conversation
 * asks for the same message's content many times per draw (the bubble, the
 * cards, the suggested replies, "is anything visible"), and on every redraw.
 * Parsing a body is a pass over all of it, so the answer is kept: by event
 * id, checked against the body and the wire field it was computed from, so
 * an edited message is parsed again. Oldest out past {@link RICH_CONTENT_MEMO_MAX}.
 */
const richContentMemo = new Map<string, RichContentMemoEntry>();

function memoKey(message: { eventId?: string | null; body?: string | null }, body: string): string | null {
  const eventId = typeof message.eventId === "string" ? message.eventId.trim() : "";
  if (eventId) return `id:${eventId}`;
  return body.length <= RICH_CONTENT_MEMO_BODY_KEY_MAX ? `body:${body}` : null;
}

/** For tests: how many answers are remembered, and a way to forget them. */
export function richContentMemoSize(): number {
  return richContentMemo.size;
}
export function clearRichContentMemo(): void {
  richContentMemo.clear();
}

/**
 * Resolve the structured content + text fallback for a message row.
 *
 * Precedence: an explicit `richContent` wire field (server passthrough) wins;
 * otherwise fall back to lifting an `hq-block` fence out of the body. The
 * returned `text` is ALWAYS a valid plain-text fallback for the bubble.
 *
 * The answer is remembered per message (see {@link richContentMemo}), so
 * callers ask as often as they like. Treat it as read-only: the same object
 * is handed to every caller.
 */
export function richContentForMessage(message: {
  eventId?: string | null;
  body?: string | null;
  richContent?: unknown;
}): ExtractedRichContent {
  const body = message.body ?? "";
  const key = memoKey(message, body);
  if (key !== null) {
    const hit = richContentMemo.get(key);
    if (hit && hit.body === body && hit.richContent === message.richContent) {
      // Most recently used goes last, so the oldest is the first to leave.
      richContentMemo.delete(key);
      richContentMemo.set(key, hit);
      return hit.result;
    }
  }
  const fromField = parseRichContent(message.richContent);
  const result = fromField ? { text: body, rich: fromField } : extractRichContentFromBody(body);
  if (key !== null) {
    richContentMemo.delete(key);
    richContentMemo.set(key, { body, richContent: message.richContent, result });
    while (richContentMemo.size > RICH_CONTENT_MEMO_MAX) {
      const oldest = richContentMemo.keys().next().value;
      if (oldest === undefined) break;
      richContentMemo.delete(oldest);
    }
  }
  return result;
}

/**
 * Reduce a single block to a plain-text line. Every block kind must contribute
 * a sensible, human-readable projection so a text-only surface (notification,
 * old client, screen reader summary) still conveys the block's content. Values
 * are already sanitized by the parser, so this only joins them.
 */
function blockToPlainText(block: RichBlock): string {
  switch (block.kind) {
    case "setupDone":
    case "suggestions":
      return "";
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
    case "connect":
      return `Connect ${proseList(block.items.map(connectItemLabel))} from the HQ app.`;
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

/** True when this message carries the setup bot's "setup is finished" signal. */
export function messageOffersSlackAgent(message: { body?: string | null; richContent?: unknown }): boolean {
  return (
    richContentForMessage(message).rich?.blocks.some((block) => block.kind === "setupDone" && block.slackAgent === true) ?? false
  );
}

export function messageMarksSetupDone(message: { body?: string | null; richContent?: unknown }): boolean {
  return richContentForMessage(message).rich?.blocks.some((block) => block.kind === "setupDone") ?? false;
}

/**
 * Is there anything for a person to see in this message?
 *
 * A message whose whole body was the finish marker has no visible content once
 * the marker is lifted: rendering it anyway leaves an empty bubble with the
 * bot's name on it. Attachments, a prompt or details still count as content,
 * and so does any block other than the marker.
 */
export function messageHasVisibleContent(message: {
  body?: string | null;
  richContent?: unknown;
  prompt?: string | null;
  details?: string | null;
}): boolean {
  if (message.prompt?.trim() || message.details?.trim()) return true;
  const { text, rich } = richContentForMessage(message);
  if (text.trim()) return true;
  return rich?.blocks.some((block) => !HOST_PLACED_BLOCK_KINDS.has(block.kind)) ?? false;
}

/** The suggested replies a message carries, or an empty list. */
export function suggestionsForMessage(message: { body?: string | null; richContent?: unknown }): string[] {
  const block = richContentForMessage(message).rich?.blocks.find(
    (b): b is SuggestionsBlock => b.kind === "suggestions",
  );
  return block ? [...block.items] : [];
}

/**
 * What a suggested reply sends: the host's own text for that label when it
 * has one, else the label itself. The label is the bot's, so it is looked up
 * as an own key only: a label like "constructor" or "toString" is on every
 * object, and would otherwise send whatever the language keeps under that
 * name in place of the words the person pressed.
 */
export function replyForSuggestion(label: string, texts: Readonly<Record<string, string>> | null | undefined): string {
  if (!texts || !Object.prototype.hasOwnProperty.call(texts, label)) return label;
  const text = texts[label];
  return typeof text === "string" ? text : label;
}

/** True when this message carries a `connect` block of its own. */
export function messageHasConnectBlock(message: { body?: string | null; richContent?: unknown }): boolean {
  return richContentForMessage(message).rich?.blocks.some((block) => block.kind === "connect") ?? false;
}

/**
 * Add blocks the host attaches to a message that did not carry them (the
 * connection cards under a new bot's first message). The message's own blocks
 * come first; a message with none gets just the extra ones. Nothing to add
 * hands back the model it was given.
 */
export function withExtraBlocks(
  rich: RichContentModel | null,
  extra: readonly RichBlock[] | null | undefined,
): RichContentModel | null {
  if (!extra || extra.length === 0) return rich;
  return { blocks: [...(rich?.blocks ?? []), ...extra] };
}
