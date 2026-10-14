/**
 * displayTitle — turn a frontmatter or heading title into a plain label.
 *
 * Knowledge titles are written for Obsidian-style readers and often carry
 * link syntax. Labels in lists and inspectors show the readable text only:
 *
 *   [[target|Alias]]  → Alias
 *   [[path/to/note]]  → last path segment, humanised ("note")
 *   [text](url)       → text
 *
 * Only for titles and labels. Document bodies render through the markdown
 * pipeline and must not be passed through here.
 */

function humaniseSegment(target: string): string {
  const withoutHeading = target.split("#")[0] ?? target;
  const segment = withoutHeading.split("/").filter(Boolean).pop() ?? withoutHeading;
  return segment.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
}

export function displayTitle(raw: string): string {
  return raw
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, (_m, target: string, alias: string) =>
      alias.trim() || humaniseSegment(target),
    )
    .replace(/\[\[([^\]]+)\]\]/g, (_m, target: string) => humaniseSegment(target))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
