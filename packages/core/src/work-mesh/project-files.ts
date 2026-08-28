/**
 * Project-directory artifacts for the channel Files tab.
 * Repos stay on Status; this list is brainstorms, PRDs, runbooks, journals.
 */

const SKIP_NAMES = new Set(["fabric-genesis.json", ".ds_store", "thumbs.db"]);

const ARTIFACT_EXT = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".html",
]);

export function isProjectArtifactPath(path: string): boolean {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.endsWith("/")) return false;
  const name = trimmed.split("/").filter(Boolean).pop() ?? "";
  if (!name || name.startsWith(".")) return false;
  if (SKIP_NAMES.has(name.toLowerCase())) return false;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return ARTIFACT_EXT.has(name.slice(dot).toLowerCase());
}

export function iconKindForPath(
  path: string,
): "image" | "pdf" | "markdown" | "text" | "file" {
  const lower = path.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(lower)) return "image";
  if (lower.endsWith(".pdf")) return "pdf";
  if (/\.(md|markdown)$/.test(lower)) return "markdown";
  if (/\.(txt|csv|ya?ml|json|html)$/.test(lower)) return "text";
  return "file";
}

export function fileNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

export function vaultKeyForProjectFile(
  projectId: string,
  relativePath: string,
): string {
  const rel = relativePath.replace(/^\/+/, "");
  if (rel.startsWith("projects/")) return rel;
  return `projects/${projectId}/${rel}`;
}
