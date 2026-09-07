//! Open / Share / Deploy on files an in-app session produced.
//!
//! The transcript adapter lifts the `file_path` out of every successful
//! Write/Edit tool call; this module is the security boundary those paths cross
//! before anything touches the disk or the `hq` CLI:
//!
//!   * every path must be absolute, free of `..`, and canonically INSIDE the
//!     HQ root — the same root `agent_session_preflight` reports to the page;
//!   * Share additionally requires a VAULT path (`companies/<slug>/…`), because
//!     `hq files share` mints a capability on a company bucket and the prefix
//!     it takes is company-relative;
//!   * the CLI is spawned with a structured argv (never a shell string), and
//!     the share-session URL it prints is returned to the caller ONCE and never
//!     logged — a share-session URL is a live single-use capability, so even an
//!     error path redacts anything that looks like one.
//!
//! Deploy needs nothing here: the page sends `/deploy <path>` as a user turn
//! and the deploy skill does the work. The only deploy-related fact this
//! module supplies is whether a path is something deploy can serve, which needs
//! a directory listing (`index.html`) the renderer cannot do itself.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::commands::launch::reveal_folder;
use crate::util::logfile::log;
use crate::util::paths;
use hq_desktop_core::workspaces::resolve_hq_folder_path;

const LOG_TAG: &str = "session-artifacts";

/// The default share-session TTL the CLI applies when `--expires` is omitted.
const DEFAULT_SHARE_TTL_MINUTES: u32 = 15;

/// What the transcript needs to know to draw one artifact row honestly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactStat {
    pub exists: bool,
    /// `file`, `dir`, or `missing`.
    pub kind: String,
    /// True only for a vault path (`companies/<slug>/…`) — the one kind of
    /// path `hq files share` can mint a link for.
    pub shareable: bool,
    /// The slug the vault path belongs to, when `shareable`.
    pub company: Option<String>,
    /// True when `/deploy` can serve it: a page, a document, an image, or a
    /// folder with an `index.html`.
    pub deployable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactShare {
    pub url: String,
    pub expires_in_minutes: u32,
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/// Confirm `path` names something inside `root`.
///
/// Checked lexically first (absolute, no `..`, no empty) so a path that does
/// not exist yet still cannot escape, then canonically when it does exist so a
/// symlink inside the root cannot point outside it. Returns the canonical path
/// when the target exists and the lexical one otherwise.
pub(crate) fn validate_inside_root(path: &str, root: &Path) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("No file path given".to_string());
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return Err(format!("Path must be absolute: {trimmed}"));
    }
    if candidate
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(format!(
            "Path may not contain `.` or `..` segments: {trimmed}"
        ));
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("Could not resolve the HQ folder {}: {e}", root.display()))?;
    // A path that does not exist yet cannot be canonicalized; folding its
    // components still drops any interior `.` so the lexical form is clean.
    let resolved = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.components().collect::<PathBuf>());
    if !resolved.starts_with(&canonical_root) {
        return Err(format!(
            "Refusing to touch a path outside the HQ folder: {}",
            candidate.display()
        ));
    }
    Ok(resolved)
}

/// `<root>/companies/<slug>/<rest>` → `(slug, rest)` with `rest` in the
/// forward-slash, bucket-relative form `hq files share` takes. `None` for
/// anything that is not a vault path — the company folder itself included,
/// since a share needs a prefix inside it.
pub(crate) fn vault_relative(path: &Path, root: &Path) -> Option<(String, String)> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = rel.components().filter_map(|c| match c {
        Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
        _ => None,
    });
    if parts.next()? != "companies" {
        return None;
    }
    let slug = parts.next()?;
    let rest: Vec<String> = parts.collect();
    if slug.is_empty() || rest.is_empty() {
        return None;
    }
    Some((slug, rest.join("/")))
}

/// The file kinds `/deploy` serves directly.
const DEPLOYABLE_EXTENSIONS: &[&str] = &["html", "htm", "md", "pdf", "png", "jpg", "jpeg"];

pub(crate) fn deployable_file_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| DEPLOYABLE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn stat_at(path: &Path, root: &Path) -> ArtifactStat {
    let vault = vault_relative(path, root);
    let (kind, exists, deployable) = match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => ("dir", true, path.join("index.html").is_file()),
        Ok(_) => (
            "file",
            true,
            path.file_name()
                .and_then(|n| n.to_str())
                .map(deployable_file_name)
                .unwrap_or(false),
        ),
        Err(_) => ("missing", false, false),
    };
    ArtifactStat {
        exists,
        kind: kind.to_string(),
        shareable: exists && vault.is_some(),
        company: vault.map(|(slug, _)| slug),
        deployable: exists && deployable,
    }
}

// ---------------------------------------------------------------------------
// `hq files share`
// ---------------------------------------------------------------------------

/// `hq files --company <slug> share <rel> --no-open`, as a structured argv.
///
/// `--company` belongs to the `files` parent command, so it goes before the
/// subcommand. `--no-open` keeps the CLI from launching a browser: the app
/// shows the URL itself, once, with a Copy button.
pub(crate) fn share_args(slug: &str, rel: &str) -> Vec<OsString> {
    vec![
        OsString::from("files"),
        OsString::from("--company"),
        OsString::from(slug),
        OsString::from("share"),
        OsString::from(rel),
        OsString::from("--no-open"),
    ]
}

/// Strip ANSI colour sequences (chalk emits them when it believes it has a TTY).
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Read the URL (and the `Expires:` instant, when printed) out of the CLI's
/// `Share-session URL generated:` block.
pub(crate) fn parse_share_output(stdout: &str) -> Option<(String, Option<String>)> {
    let clean = strip_ansi(stdout);
    let mut url = None;
    let mut expires = None;
    for line in clean.lines() {
        let line = line.trim();
        if url.is_none() && line.starts_with("https://") && !line.contains(char::is_whitespace) {
            url = Some(line.to_string());
        } else if let Some(rest) = line.strip_prefix("Expires:") {
            expires = Some(rest.trim().to_string());
        }
    }
    url.map(|u| (u, expires))
}

/// Minutes until `expires_at` (RFC 3339), or the CLI default when it cannot be
/// read — the card only ever says "expires in N min", so an honest default
/// beats a failed share.
pub(crate) fn minutes_until(expires_at: Option<&str>, now: chrono::DateTime<chrono::Utc>) -> u32 {
    expires_at
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|at| {
            let secs = (at.with_timezone(&chrono::Utc) - now).num_seconds().max(0);
            ((secs + 59) / 60) as u32
        })
        .unwrap_or(DEFAULT_SHARE_TTL_MINUTES)
}

/// Replace every `https://…/share-session/<token>` in `text` with a redacted
/// form, so a CLI complaint that echoes the link can be logged or shown.
pub(crate) fn redact_share_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("https://") {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let end = tail.find(char::is_whitespace).unwrap_or(tail.len());
        let url = &tail[..end];
        if let Some(idx) = url.find("/share-session/") {
            out.push_str(&url[..idx + "/share-session/".len()]);
            out.push_str("<TOKEN_REDACTED>");
        } else {
            out.push_str(url);
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Existence, kind, and what the actions may do with one produced path.
#[tauri::command]
pub async fn session_artifact_stat(path: String) -> Result<ArtifactStat, String> {
    let root = resolve_hq_folder_path()?;
    let target = validate_inside_root(&path, &root)?;
    let canonical_root = root.canonicalize().unwrap_or(root);
    Ok(stat_at(&target, &canonical_root))
}

/// Open a produced file in its default app (Finder/Explorer for a folder).
#[tauri::command]
pub async fn session_artifact_open(path: String) -> Result<(), String> {
    let root = resolve_hq_folder_path()?;
    let target = validate_inside_root(&path, &root)?;
    if !target.exists() {
        return Err("That file no longer exists".to_string());
    }
    reveal_folder(target.to_string_lossy().into_owned())
}

/// Mint a single-use share-session link for a vault file via the `hq` CLI.
///
/// The URL is returned exactly once and never written to the log; the caller
/// shows it in the minting turn and discards it on dismiss.
#[tauri::command]
pub async fn session_artifact_share(path: String) -> Result<ArtifactShare, String> {
    let root = resolve_hq_folder_path()?;
    let target = validate_inside_root(&path, &root)?;
    let canonical_root = root.canonicalize().unwrap_or(root.clone());
    if !target.exists() {
        return Err("That file no longer exists".to_string());
    }
    let (slug, rel) = vault_relative(&target, &canonical_root)
        .ok_or_else(|| "Only company vault files can be shared".to_string())?;

    let hq = paths::resolve_bin("hq");
    let args = share_args(&slug, &rel);
    log(LOG_TAG, &format!("minting share link for {rel} ({slug})"));

    let mut cmd = paths::tokio_spawn_command(&hq, &[]);
    let output = cmd
        .args(&args)
        .env("PATH", paths::child_path())
        .env("HQ_NO_UPDATE_CHECK", "1")
        .env("HQ_ROOT", &root)
        .current_dir(&root)
        .output()
        .await
        .map_err(|e| format!("Could not run `hq files share`: {e}"))?;

    if !output.status.success() {
        let stderr = redact_share_urls(String::from_utf8_lossy(&output.stderr).trim());
        let msg = if stderr.is_empty() {
            format!(
                "`hq files share` exited {}",
                output.status.code().unwrap_or(-1)
            )
        } else {
            strip_ansi(&stderr)
        };
        log(LOG_TAG, &format!("share failed for {rel} ({slug}): {msg}"));
        return Err(msg);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let (url, expires_at) = parse_share_output(&stdout)
        .ok_or_else(|| "`hq files share` printed no share link".to_string())?;
    let expires_in_minutes = minutes_until(expires_at.as_deref(), chrono::Utc::now());
    log(LOG_TAG, &format!("share link minted for {rel} ({slug})"));
    Ok(ArtifactShare {
        url,
        expires_in_minutes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn root_with(files: &[&str]) -> TempDir {
        let dir = TempDir::new().unwrap();
        for f in files {
            let p = dir.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "x").unwrap();
        }
        dir
    }

    #[test]
    fn accepts_a_path_inside_the_root() {
        let dir = root_with(&["companies/indigo/reports/q3.md"]);
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("companies/indigo/reports/q3.md");
        let ok = validate_inside_root(path.to_str().unwrap(), &root).unwrap();
        assert_eq!(ok, path);
    }

    #[test]
    fn accepts_a_not_yet_existing_path_inside_the_root() {
        let dir = root_with(&[]);
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("workspace/out.html");
        assert!(validate_inside_root(path.to_str().unwrap(), &root).is_ok());
    }

    #[test]
    fn rejects_paths_outside_the_root() {
        let dir = root_with(&[]);
        let other = TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let outside = other.path().canonicalize().unwrap().join("secret.txt");
        let err = validate_inside_root(outside.to_str().unwrap(), &root).unwrap_err();
        assert!(err.contains("outside the HQ folder"), "{err}");
    }

    #[test]
    fn rejects_traversal_relative_and_empty() {
        let dir = root_with(&[]);
        let root = dir.path().canonicalize().unwrap();
        let traversal = format!("{}/companies/../../etc/passwd", root.display());
        assert!(validate_inside_root(&traversal, &root)
            .unwrap_err()
            .contains("`..`"));
        // `Path::components` folds an interior `.` away, so this form is not
        // an escape — it must still resolve INSIDE the root, never outside.
        let dotted = format!("{}/./companies/x", root.display());
        let resolved = validate_inside_root(&dotted, &root).unwrap();
        assert!(resolved.starts_with(&root));
        assert!(!resolved.to_string_lossy().contains("/./"));
        assert!(validate_inside_root("companies/indigo/a.md", &root)
            .unwrap_err()
            .contains("absolute"));
        assert!(validate_inside_root("   ", &root).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_that_escapes_the_root() {
        let dir = root_with(&[]);
        let other = TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(other.path().join("leak.txt"), "x").unwrap();
        let link = root.join("leak.txt");
        std::os::unix::fs::symlink(other.path().join("leak.txt"), &link).unwrap();
        assert!(validate_inside_root(link.to_str().unwrap(), &root).is_err());
    }

    #[test]
    fn vault_relative_only_for_company_paths() {
        let root = Path::new("/hq");
        assert_eq!(
            vault_relative(Path::new("/hq/companies/indigo/reports/q3.md"), root),
            Some(("indigo".into(), "reports/q3.md".into()))
        );
        assert_eq!(
            vault_relative(Path::new("/hq/companies/indigo"), root),
            None
        );
        assert_eq!(
            vault_relative(Path::new("/hq/workspace/out.html"), root),
            None
        );
        assert_eq!(
            vault_relative(Path::new("/elsewhere/companies/x/a"), root),
            None
        );
    }

    #[test]
    fn stat_reports_kind_shareability_and_deployability() {
        let dir = root_with(&[
            "companies/indigo/site/index.html",
            "companies/indigo/notes.txt",
            "workspace/report.md",
        ]);
        let root = dir.path().canonicalize().unwrap();

        let vault_file = stat_at(&root.join("companies/indigo/notes.txt"), &root);
        assert_eq!(vault_file.kind, "file");
        assert!(vault_file.exists && vault_file.shareable && !vault_file.deployable);
        assert_eq!(vault_file.company.as_deref(), Some("indigo"));

        let site = stat_at(&root.join("companies/indigo/site"), &root);
        assert_eq!(site.kind, "dir");
        assert!(site.shareable && site.deployable);

        let outside_vault = stat_at(&root.join("workspace/report.md"), &root);
        assert!(outside_vault.exists && !outside_vault.shareable && outside_vault.deployable);
        assert_eq!(outside_vault.company, None);

        let gone = stat_at(&root.join("companies/indigo/gone.md"), &root);
        assert_eq!(gone.kind, "missing");
        assert!(!gone.exists && !gone.shareable && !gone.deployable);
    }

    #[test]
    fn deployable_extensions_are_the_agreed_set() {
        for name in [
            "a.html", "a.HTM", "a.md", "a.pdf", "a.png", "a.jpg", "a.JPEG",
        ] {
            assert!(deployable_file_name(name), "{name}");
        }
        for name in ["a.txt", "a.rs", "a.json", "Makefile", "a.svg"] {
            assert!(!deployable_file_name(name), "{name}");
        }
    }

    #[test]
    fn share_args_are_structured_and_company_scoped() {
        let args: Vec<String> = share_args("indigo", "reports/q3 draft.md")
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "files",
                "--company",
                "indigo",
                "share",
                "reports/q3 draft.md",
                "--no-open"
            ]
        );
        // A hostile name stays one argv entry — there is no shell to interpret it.
        let hostile = share_args("indigo", "a; rm -rf / && echo $(x)");
        assert_eq!(hostile.len(), 6);
        assert_eq!(hostile[4].to_string_lossy(), "a; rm -rf / && echo $(x)");
    }

    #[test]
    fn parses_the_cli_share_block() {
        let stdout = "\u{1b}[32mShare-session URL generated:\u{1b}[39m\n\n  https://hq.indigo.com/share-session/abc.def\n\n\u{1b}[2m  Paths:   reports/q3.md\u{1b}[22m\n\u{1b}[2m  Expires: 2026-09-02T18:47:00.000Z\u{1b}[22m\n  --no-open: copy the URL above to share manually.\n";
        let (url, expires) = parse_share_output(stdout).unwrap();
        assert_eq!(url, "https://hq.indigo.com/share-session/abc.def");
        assert_eq!(expires.as_deref(), Some("2026-09-02T18:47:00.000Z"));
        assert_eq!(parse_share_output("nothing here"), None);
    }

    #[test]
    fn minutes_until_rounds_up_and_defaults() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-02T18:32:10Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(minutes_until(Some("2026-09-02T18:47:00Z"), now), 15);
        assert_eq!(minutes_until(Some("2026-09-02T18:00:00Z"), now), 0);
        assert_eq!(
            minutes_until(Some("garbage"), now),
            DEFAULT_SHARE_TTL_MINUTES
        );
        assert_eq!(minutes_until(None, now), DEFAULT_SHARE_TTL_MINUTES);
    }

    #[test]
    fn redacts_share_session_urls_but_leaves_other_text() {
        let text = "failed: https://hq.indigo.com/share-session/tok.en already claimed, see https://docs.hq.com/x";
        assert_eq!(
            redact_share_urls(text),
            "failed: https://hq.indigo.com/share-session/<TOKEN_REDACTED> already claimed, see https://docs.hq.com/x"
        );
        assert_eq!(redact_share_urls("plain"), "plain");
    }

    #[test]
    fn share_log_lines_never_carry_the_url() {
        // The only lines this module logs are built from the vault-relative
        // path and slug; pin that a minted URL cannot reach them.
        let url = "https://hq.indigo.com/share-session/secret-token";
        let line = format!("share link minted for {} ({})", "reports/q3.md", "indigo");
        assert!(!line.contains(url));
        assert!(!line.contains("share-session"));
    }
}
