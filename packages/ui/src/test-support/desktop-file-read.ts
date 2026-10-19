// A fake of the desktop `get_company_file_content` command as the renderer
// sees it through the sync adapter (`failure("invoke", message)`). Paths are
// checked the way `validate_hq_relative_path` in
// crates/hq-desktop-core/src/desktop_alt.rs checks them: a leading slash, a
// backslash, a NUL, an empty or ".." segment, or any segment with a colon is
// rejected with `invalid HQ-relative path: "<path>"`. A valid path that does
// not exist fails the way `canonical_hq_relative_path` does.

export type DesktopFileResult =
  | { ok: true; data: string }
  | { ok: false; reason: "error"; code: "invoke"; message: string };

const rust = (path: string) => JSON.stringify(path);

/** Null when the path passes validation, else the Rust error message. */
export function desktopPathError(path: string): string | null {
  const invalid = `invalid HQ-relative path: ${rust(path)}`;
  const value = path.trim();
  if (!value) return "invalid HQ-relative path: path is required";
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return invalid;
  for (const segment of value.split("/")) {
    if (segment === ".") continue;
    if (segment === "" || segment === "..") return invalid;
    if (segment.includes(":")) return invalid;
  }
  return null;
}

/**
 * A `getFileContent` over `files` (HQ-relative path to contents). `reads`
 * records every path asked for and `served` every path whose contents were
 * returned.
 */
export function desktopFileReader(files: Record<string, string>) {
  const reads: string[] = [];
  const served: string[] = [];
  const fail = (message: string): DesktopFileResult => ({ ok: false, reason: "error", code: "invoke", message });
  const getFileContent = async (requested: string): Promise<DesktopFileResult> => {
    reads.push(requested);
    const bad = desktopPathError(requested);
    if (bad) return fail(bad);
    if (!(requested in files)) return fail(`could not resolve ${rust(requested)}: No such file or directory (os error 2)`);
    served.push(requested);
    return { ok: true, data: files[requested]! };
  };
  return { getFileContent, reads, served };
}
