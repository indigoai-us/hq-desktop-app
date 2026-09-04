/**
 * Shortcode → emoji helpers for the legacy popover conversation surface. The
 * table and the logic live once in the shared UI workspace; this mirrors the
 * `lib/markdown.ts` re-export pattern so both message renderers convert
 * identically.
 */
export {
  EMOJI_SHORTCODES,
  JUMBO_EMOJI_MAX,
  emojiForShortcode,
  emojiOnlyCount,
  isJumboEmojiBody,
  replaceEmojiShortcodes,
  replaceEmojiShortcodesInHtml,
} from '@hq/ui/emoji-shortcodes';
