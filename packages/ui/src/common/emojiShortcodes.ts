/**
 * `:shortcode:` → Unicode emoji rendering for message bodies, plus the
 * emoji-only ("jumbo") detection Slack-style bubbles use.
 *
 * WHY THIS EXISTS. Messages reach HQ carrying shortcodes — every Slack-relayed
 * body uses `:name:` form, and people type `:tada:` directly — and the
 * hand-written message renderer passed them through as literal text, so a
 * bubble read `:stuck_out_tongue_winking_eye:` instead of 😜.
 *
 * RENDER-TIME ONLY. Conversion happens on display; the stored body keeps the
 * raw shortcode. That keeps the wire text intact for Slack and every other
 * client (and for search), and means old messages fix themselves.
 *
 * SAFE BY CONSTRUCTION. Replacement happens in the ALREADY-ESCAPED HTML the
 * CSP-safe renderer produced, in text runs only: `<code>`, `<pre>` and `<a>`
 * contents are skipped (so code spans, fences, link text and URLs are never
 * touched) and tags themselves are copied verbatim, so no attribute or href can
 * be rewritten. The substituted value is a bare Unicode character — never
 * markup — so nothing new is injected into the `{@html}` payload.
 */
import { EMOJI_SHORTCODES } from "./emoji-shortcodes.data.js";

export { EMOJI_SHORTCODES };

/**
 * A shortcode token. The name charset matches gemoji/Slack spelling (letters,
 * digits, `_`, `+`, `-`), so `:+1:` and `:e-mail:` resolve while `12:30:45`
 * cannot (no digit-only entry exists in the table).
 */
const SHORTCODE_RE = /:([a-zA-Z0-9_+-]+):/g;

/** Resolve one shortcode name (with or without colons); null when unknown. */
export function emojiForShortcode(name: string): string | null {
  const key = name.replace(/^:|:$/g, "").toLowerCase();
  return EMOJI_SHORTCODES.get(key) ?? null;
}

/**
 * Convert every KNOWN `:shortcode:` in a plain-text run. Unknown names are left
 * exactly as typed, so `:not_an_emoji:` still reads as literal text.
 */
export function replaceEmojiShortcodes(text: string): string {
  if (!text.includes(":")) return text;
  return text.replace(SHORTCODE_RE, (match, name: string) => {
    return emojiForShortcode(name) ?? match;
  });
}

function tagName(tag: string): { name: string; closing: boolean } | null {
  const match = tag.match(/^<\/?([A-Za-z][A-Za-z0-9]*)/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), closing: tag.startsWith("</") };
}

/**
 * Convert shortcodes in already-rendered HTML. Only text outside tags is
 * scanned, and `<code>` / `<pre>` / `<a>` contents are skipped so code spans,
 * fenced blocks, link labels and autolinked URLs keep their literal text.
 */
export function replaceEmojiShortcodesInHtml(html: string): string {
  if (!html.includes(":")) return html;

  let out = "";
  let cursor = 0;
  let codeDepth = 0;
  let preDepth = 0;
  let aDepth = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    const textEnd = tagStart === -1 ? html.length : tagStart;
    const text = html.slice(cursor, textEnd);
    const skip = codeDepth > 0 || preDepth > 0 || aDepth > 0;
    out += skip ? text : replaceEmojiShortcodes(text);
    if (tagStart === -1) break;

    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd === -1) {
      out += html.slice(tagStart);
      break;
    }

    const tag = html.slice(tagStart, tagEnd + 1);
    const parsed = tagName(tag);
    out += tag;
    if (
      parsed &&
      (parsed.name === "code" || parsed.name === "pre" || parsed.name === "a")
    ) {
      const selfClosing = /\/\s*>$/.test(tag);
      if (!selfClosing) {
        const delta = parsed.closing ? -1 : 1;
        if (parsed.name === "code") codeDepth = Math.max(0, codeDepth + delta);
        else if (parsed.name === "pre") preDepth = Math.max(0, preDepth + delta);
        else aDepth = Math.max(0, aDepth + delta);
      }
    }
    cursor = tagEnd + 1;
  }

  return out;
}

/**
 * Most emoji a lone-emoji bubble may hold and still render jumbo. Slack draws a
 * short emoji-only message large; past a handful it reads as content, not a
 * reaction, so it stays inline-sized.
 */
export const JUMBO_EMOJI_MAX = 3;

/** One emoji grapheme cluster: flags, keycaps, ZWJ sequences, skin tones. */
function emojiClusterRe(): RegExp {
  return new RegExp(
    "(?:" +
      "\\p{RI}\\p{RI}" +
      "|[#*0-9]\\uFE0F?\\u20E3" +
      "|\\p{Extended_Pictographic}[\\u{1F3FB}-\\u{1F3FF}]?\\uFE0F?" +
      "(?:\\u200D\\p{Extended_Pictographic}[\\u{1F3FB}-\\u{1F3FF}]?\\uFE0F?)*" +
    ")",
    "gu",
  );
}

/**
 * Count the emoji in a body that contains NOTHING but emoji and whitespace
 * (shortcodes resolved first). Returns 0 for an empty body or any body carrying
 * other text, so mixed text+emoji stays inline at normal size.
 */
export function emojiOnlyCount(body: string): number {
  const stripped = replaceEmojiShortcodes(body ?? "").replace(/\s+/gu, "");
  if (stripped.length === 0) return 0;
  const pattern = emojiClusterRe();
  let count = 0;
  let index = 0;
  for (;;) {
    pattern.lastIndex = index;
    const match = pattern.exec(stripped);
    // Any non-emoji character between clusters disqualifies the body.
    if (!match || match.index !== index) return 0;
    count += 1;
    index = match.index + match[0].length;
    if (index >= stripped.length) return count;
  }
}

/**
 * True when a body should render at jumbo size: emoji (and whitespace) only,
 * at most {@link JUMBO_EMOJI_MAX} of them.
 */
export function isJumboEmojiBody(body: string): boolean {
  const count = emojiOnlyCount(body);
  return count > 0 && count <= JUMBO_EMOJI_MAX;
}
