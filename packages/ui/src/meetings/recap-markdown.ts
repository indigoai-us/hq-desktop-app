/**
 * OWNER-R25: meeting recap text arrives as Markdown, sometimes flattened by
 * the server onto one line ("**Participants:** a, b **Purpose:** x
 * **Major Outcomes:** - one - two"). These helpers put the structure back
 * before the shared renderer (common/markdown.ts) draws it. They only split
 * on unambiguous patterns: a bold label that ends in a colon, and " - " item
 * separators directly after such a label. Pure: no Svelte.
 */

/** A bold label such as `**Next Steps:**` (1 to 5 words, colon inside or after). */
const LABEL = /\*\*([A-Z][A-Za-z0-9'&/ ]{0,40}?):\*\*|\*\*([A-Z][A-Za-z0-9'&/ ]{0,40}?)\*\*:/g;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a flattened label body into list items when it starts with "- " and
 * holds at least two " - " separated items. Otherwise leave it as written.
 */
function listify(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("- ")) return trimmed;
  const items = trimmed
    .slice(2)
    .split(/\s+-\s+(?=\S)/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length < 2) return trimmed;
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * Restore paragraphs and lists in a recap summary. Text that already has
 * line structure is returned as is (only the title line is dropped).
 */
export function normalizeRecapMarkdown(text: string, meetingTitle = ""): string {
  let source = text.replace(/\r/g, "").trim();
  if (!source) return "";

  // A leading line that only repeats the meeting title (and date) adds nothing.
  const title = meetingTitle.trim();
  if (title) {
    const firstBreak = source.search(/\n|\*\*[A-Z][^*]{0,40}:\*\*/);
    const lead = (firstBreak < 0 ? source : source.slice(0, firstBreak)).trim();
    const bare = lead.replace(/^#+\s*/, "").replace(/[*_]/g, "").trim();
    if (bare && bare.length <= title.length + 40 && new RegExp(`^${escapeRegex(title)}\\b`, "i").test(bare) && firstBreak > 0) {
      source = source.slice(firstBreak).trim();
    }
  }

  // Already structured: leave the author's lines alone.
  if (source.includes("\n")) return source;

  const labels = [...source.matchAll(LABEL)];
  if (labels.length === 0) return source;

  const parts: string[] = [];
  const head = source.slice(0, labels[0]!.index).trim();
  if (head) parts.push(head);
  labels.forEach((match, i) => {
    const start = match.index! + match[0].length;
    const end = i + 1 < labels.length ? labels[i + 1]!.index! : source.length;
    const label = (match[1] ?? match[2] ?? "").trim();
    const body = source.slice(start, end).trim();
    const list = listify(body);
    if (list.startsWith("- ") && list.includes("\n")) parts.push(`**${label}:**\n\n${list}`);
    else parts.push(body ? `**${label}:** ${list}` : `**${label}:**`);
  });
  return parts.join("\n\n");
}

export interface DecisionParts {
  title: string;
  decidedBy: string;
  reasoning: string;
}

function stripLabel(text: string): string {
  return text.replace(/^\s*(?:\*\*)?\s*Decision\s*:\s*(?:\*\*)?\s*/i, "").trim();
}

/**
 * A decision row's text, e.g. "Decision: Ship X **Decided by:** Ana
 * **Reasoning:** because …", as a title with labeled lines beneath. The
 * repeated "Decision:" prefix is dropped.
 */
export function decisionParts(text: string): DecisionParts {
  const source = text.replace(/\r/g, "").trim();
  const by = /\*\*\s*Decided by\s*:\s*\*\*|\*\*\s*Decided by\s*\*\*\s*:|(?:^|\n)\s*Decided by\s*:/i;
  const why = /\*\*\s*Reasoning\s*:\s*\*\*|\*\*\s*Reasoning\s*\*\*\s*:|(?:^|\n)\s*Reasoning\s*:/i;
  const byMatch = by.exec(source);
  const whyMatch = why.exec(source);
  const cuts = [byMatch?.index, whyMatch?.index].filter((n): n is number => typeof n === "number");
  const titleEnd = cuts.length ? Math.min(...cuts) : source.length;
  const title = stripLabel(source.slice(0, titleEnd));
  const slice = (m: RegExpExecArray | null, other: RegExpExecArray | null) => {
    if (!m) return "";
    const start = m.index + m[0].length;
    const end = other && other.index > m.index ? other.index : source.length;
    return source.slice(start, end).trim();
  };
  return { title, decidedBy: slice(byMatch, whyMatch), reasoning: slice(whyMatch, byMatch) };
}
