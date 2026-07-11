/**
 * Classify a file path for the company file preview pane.
 * Used by Files mode + Knowledge tab (shared FilePreviewPane).
 */

export type FilePreviewKind = 'markdown' | 'image' | 'text' | 'pdf' | 'unknown';

const IMAGE_EXT =
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif|tiff?|heic|heif)$/i;
const MARKDOWN_EXT = /\.(md|markdown)$/i;
const PDF_EXT = /\.pdf$/i;
/** Extensions we treat as UTF-8 text for the monospace preview path. */
const TEXT_EXT =
  /\.(txt|text|csv|tsv|json|jsonc|ya?ml|toml|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|svelte|vue|rs|go|py|rb|sh|bash|zsh|fish|env|ini|cfg|conf|log|sql|graphql|gql|mdx|rst|adoc|tex|r|jl|swift|kt|kts|java|c|cc|cpp|h|hpp|cs|php|pl|lua|zig|nim|ex|exs|erl|hs|clj|edn|proto|dockerfile|makefile|cmake|lock|sum|mod|gitignore|gitattributes|editorconfig|npmrc|prettierrc|eslintrc)$/i;

export function filePreviewKind(path: string): FilePreviewKind {
  const p = path.trim();
  if (!p) return 'unknown';
  if (MARKDOWN_EXT.test(p)) return 'markdown';
  if (IMAGE_EXT.test(p)) return 'image';
  if (PDF_EXT.test(p)) return 'pdf';
  // Extensionless or known text — try text path (UTF-8 read may still fail for binary)
  const base = p.split('/').pop() ?? p;
  if (base.startsWith('.') && !base.includes('.', 1)) {
    // Dotfiles like `.env`, `.gitignore` without further extension
    return 'text';
  }
  if (TEXT_EXT.test(p) || !base.includes('.')) return 'text';
  // Unknown extension: still attempt text; binary reject → unsupported UI
  return 'text';
}

export function isImagePreviewPath(path: string): boolean {
  return filePreviewKind(path) === 'image';
}

export function isPdfPreviewPath(path: string): boolean {
  return filePreviewKind(path) === 'pdf';
}
