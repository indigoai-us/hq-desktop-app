/**
 * Shortcode → emoji helpers for the legacy popover conversation surface. The
 * table and the logic live once in the shared UI workspace; this mirrors the
 * `lib/markdown.ts` re-export pattern so both message renderers convert
 * identically.
 */
export {
  isJumboEmojiBody,
  replaceEmojiShortcodesInHtml,
} from '@hq/ui/emoji-shortcodes';
