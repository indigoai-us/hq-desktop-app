// Files area (ported from desktop-alt) — file explorer, preview, Claude Code
// drill-in. Pure UI: platform access arrives via `@hq/platform` props.
export { default as FilePreviewPane } from "./FilePreviewPane.svelte";
export { default as CompanyFileTree } from "./CompanyFileTree.svelte";
export { default as OpenFileInClaudeCode } from "./OpenFileInClaudeCode.svelte";
export { default as FilesModeSidebar } from "./FilesModeSidebar.svelte";
export * from "./file-tree.js";
export * from "./file-preview-kind.js";
export * from "./claude-code-link.js";
