//! Mandatory company-scope read gate for desktop file operations.
//!
//! Mirrors the CLI `mandatory-scope-authorizer` hook: when an active company is
//! bound on the desktop session, reads under `companies/{other}/` are rejected.
//! Unbound sessions may only touch `companies/manifest.yaml` and
//! `companies/_template/`.

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

fn company_slug_for_rel(rel: &str) -> Option<String> {
    let mut parts = rel.split('/');
    if parts.next()? != "companies" {
        return None;
    }
    parts.next().map(str::to_string)
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

    #[test]
    fn non_company_paths_always_allowed() {
        enforce_read_scope("core/docs/readme.md", Some("indigo")).unwrap();
        enforce_read_scope("personal/note.md", None).unwrap();
        enforce_read_scope("repos/public/hq-core/README.md", Some("indigo")).unwrap();
    }
}
