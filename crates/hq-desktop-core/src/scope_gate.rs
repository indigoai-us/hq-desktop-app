//! Mandatory company-scope read gate for desktop file operations.
//!
//! Mirrors the CLI `mandatory-scope-authorizer` hook: when an active company is
//! bound on the desktop session, reads under `companies/{other}/` are rejected.
//! Unbound sessions may only touch `companies/manifest.yaml` and
//! `companies/_template/`.
//!
//! `companies/` is not the only company-partitioned tree. The Idea Board's
//! local-only capture root (`workspace/ideas-local/{slug}/`, US-012) holds
//! screenshots, OCR text, and extracted fields per company, so it is gated on
//! exactly the same rule — see [`company_slug_for_rel`]. Any future
//! company-partitioned tree outside `companies/` has to be added there too;
//! putting tenant data somewhere this function does not recognise silently
//! turns the gate off for it.

/// Enforce company read scope for an HQ-relative path.
///
/// `active_company` is the desktop session's bound company slug, if any.
pub fn enforce_read_scope(rel_path: &str, active_company: Option<&str>) -> Result<(), String> {
    let normalized = normalize_rel_path(rel_path);
    if normalized.is_empty() {
        return Ok(());
    }

    if is_manifest_rel(&normalized) || is_template_rel(&normalized) {
        return Ok(());
    }

    let Some(target_company) = company_slug_for_rel(&normalized) else {
        return Ok(());
    };

    match active_company {
        None => Err(format!(
            "company scope not bound: reading companies/{target_company}/ requires an active company context"
        )),
        Some(bound) if bound == target_company => Ok(()),
        Some(bound) => Err(format!(
            "cross-company read blocked: active company is {bound:?}, path targets {target_company:?}"
        )),
    }
}

fn normalize_rel_path(rel_path: &str) -> String {
    let trimmed = rel_path.trim().replace('\\', "/");
    let mut segments: Vec<&str> = Vec::new();
    for segment in trimmed.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    segments.join("/")
}

/// The company a path belongs to, across every company-partitioned tree.
///
/// `companies/{slug}/…` is the obvious one. `workspace/ideas-local/{slug}/…` is
/// the Idea Board's sync-excluded capture root (US-012): excluded from *sync*,
/// but still per-company data on disk, and still reachable through the
/// renderer's authorized-preview command with a caller-supplied path. Omitting
/// it here would let a session bound to company A read company B's captures.
fn company_slug_for_rel(rel: &str) -> Option<String> {
    let mut parts = rel.split('/');
    // The TREE names are matched case-insensitively: macOS ships APFS
    // case-insensitive by default, so `Workspace/Ideas-Local/{other}/…`
    // opens the very same file a case-sensitive match would have gated.
    // The SLUG is left exactly as written — it is compared against the bound
    // company by the caller, and folding it here would let `Indigo` satisfy a
    // session bound to `indigo`, which is a different (looser) rule than the
    // one this gate is supposed to enforce.
    let root = parts.next()?.to_ascii_lowercase();
    if root == "companies" {
        return parts.next().map(str::to_string);
    }
    if root == crate::ignore::LOCAL_ONLY_PARENT_DIR {
        if parts.next()?.to_ascii_lowercase() != crate::ignore::LOCAL_ONLY_IDEAS_DIR {
            return None;
        }
        return parts.next().map(str::to_string);
    }
    None
}

fn is_manifest_rel(rel: &str) -> bool {
    matches!(
        rel,
        "companies/manifest.yaml" | "companies/manifest.yml" | "companies/manifest.json"
    )
}

fn is_template_rel(rel: &str) -> bool {
    rel == "companies/_template" || rel.starts_with("companies/_template/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bound_company_allows_same_company_and_blocks_other() {
        enforce_read_scope("companies/indigo/settings/x.yaml", Some("indigo")).unwrap();
        let err = enforce_read_scope("companies/liverecover/settings/x.yaml", Some("indigo"))
            .unwrap_err();
        assert!(err.contains("cross-company"));
    }

    #[test]
    fn unbound_allows_manifest_and_template_only() {
        enforce_read_scope("companies/manifest.yaml", None).unwrap();
        enforce_read_scope("companies/_template/readme.md", None).unwrap();
        assert!(enforce_read_scope("companies/indigo/x.md", None).is_err());
    }

    #[test]
    fn underscore_company_slug_is_not_blanket_exempt() {
        assert!(enforce_read_scope("companies/_archive/readme.md", Some("indigo")).is_err());
        assert!(enforce_read_scope("companies/_archive/readme.md", None).is_err());
    }

    /// US-012 moved per-company capture data out of `companies/` and into
    /// `workspace/ideas-local/{slug}/`. The gate has to follow it, or a session
    /// bound to one company can read another's screenshots and OCR text
    /// through the authorized-preview command.
    #[test]
    fn hq_idea_board_us_012_local_only_capture_root_is_company_scoped() {
        let mine = "workspace/ideas-local/indigo/01J0/image.png";
        let theirs = "workspace/ideas-local/liverecover/01J0/image.png";

        enforce_read_scope(mine, Some("indigo")).unwrap();
        let err = enforce_read_scope(theirs, Some("indigo")).unwrap_err();
        assert!(err.contains("cross-company"), "{err}");
        // Unbound sessions get the same treatment as the vault tree.
        assert!(enforce_read_scope(mine, None).is_err());
        // ...including via traversal spellings, which normalize first.
        assert!(enforce_read_scope(
            "workspace/ideas-local/indigo/../liverecover/01J0/image.png",
            Some("indigo")
        )
        .is_err());
        // The sidecar carries OCR text, so it is gated too.
        assert!(enforce_read_scope(
            "workspace/ideas-local/liverecover/01J0/capture.md",
            Some("indigo")
        )
        .is_err());
    }

    /// APFS is case-insensitive by default, so a spelling the gate does not
    /// recognise still opens the real file. Both company-partitioned trees must
    /// therefore match case-insensitively, or the gate is one shift key away
    /// from off.
    #[test]
    fn company_scoped_trees_are_matched_case_insensitively() {
        for path in [
            "Workspace/ideas-local/liverecover/01J0/image.png",
            "workspace/Ideas-Local/liverecover/01J0/image.png",
            "WORKSPACE/IDEAS-LOCAL/liverecover/01J0/capture.md",
            "Companies/liverecover/settings/x.yaml",
        ] {
            assert!(
                enforce_read_scope(path, Some("indigo")).is_err(),
                "{path} must not escape the cross-company gate on a case-insensitive volume"
            );
        }
        // The slug itself is NOT folded: scope is an exact-slug rule.
        assert!(enforce_read_scope("workspace/ideas-local/Indigo/01J0/image.png", Some("indigo"))
            .is_err());
    }

    /// Only `workspace/ideas-local/` is company-partitioned — the rest of
    /// `workspace/` is operator state and must stay readable.
    #[test]
    fn other_workspace_paths_are_not_company_scoped() {
        enforce_read_scope("workspace/threads/handoff.json", Some("indigo")).unwrap();
        enforce_read_scope("workspace/ideas-local", Some("indigo")).unwrap();
        enforce_read_scope("workspace", None).unwrap();
    }

    #[test]
    fn non_company_paths_always_allowed() {
        enforce_read_scope("core/docs/readme.md", Some("indigo")).unwrap();
        enforce_read_scope("personal/note.md", None).unwrap();
        enforce_read_scope("repos/public/hq-core/README.md", Some("indigo")).unwrap();
    }
}
