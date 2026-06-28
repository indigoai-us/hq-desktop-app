//! Conflict resolution helpers.

/// Valid resolution strategies.
const VALID_STRATEGIES: &[&str] = &["keep-local", "keep-remote"];

/// Validate that a strategy string is one of the accepted values.
pub fn validate_strategy(strategy: &str) -> Result<(), String> {
    if VALID_STRATEGIES.contains(&strategy) {
        Ok(())
    } else {
        Err(format!(
            "Unknown strategy '{}'. Must be one of: {}",
            strategy,
            VALID_STRATEGIES.join(", ")
        ))
    }
}

/// Build the CLI args for `hq sync resolve`.
pub fn build_resolve_args(strategy: &str, path: &str, hq_folder: &str) -> Vec<String> {
    vec![
        "sync".to_string(),
        "resolve".to_string(),
        "--strategy".to_string(),
        strategy.to_string(),
        "--path".to_string(),
        path.to_string(),
        "--hq-path".to_string(),
        hq_folder.to_string(),
    ]
}

/// Build the full file path from HQ folder and relative path.
/// Returns an error if the resolved path escapes the HQ folder (path traversal).
pub fn build_full_path(hq_folder: &str, relative_path: &str) -> Result<String, String> {
    let mut full = std::path::PathBuf::from(hq_folder);
    full.push(relative_path);
    let full_str = full.to_string_lossy().to_string();

    // Canonicalize both paths to resolve .. and symlinks, then verify containment
    let hq_canon = std::path::PathBuf::from(hq_folder)
        .canonicalize()
        .map_err(|e| format!("Invalid HQ folder: {}", e))?;
    let full_canon = full
        .canonicalize()
        .map_err(|e| format!("Invalid path '{}': {}", full_str, e))?;

    if !full_canon.starts_with(&hq_canon) {
        return Err(format!("Path '{}' escapes HQ folder", relative_path));
    }

    Ok(full_canon.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Strategy validation ─────────────────────────────────────────────

    #[test]
    fn test_validate_strategy_keep_local() {
        assert!(validate_strategy("keep-local").is_ok());
    }

    #[test]
    fn test_validate_strategy_keep_remote() {
        assert!(validate_strategy("keep-remote").is_ok());
    }

    #[test]
    fn test_validate_strategy_unknown_rejected() {
        let result = validate_strategy("merge");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown strategy 'merge'"));
    }

    #[test]
    fn test_validate_strategy_empty_rejected() {
        let result = validate_strategy("");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown strategy ''"));
    }

    #[test]
    fn test_validate_strategy_case_sensitive() {
        let result = validate_strategy("Keep-Local");
        assert!(result.is_err());
    }

    // ── CLI args builder ────────────────────────────────────────────────

    #[test]
    fn test_build_resolve_args_keep_local() {
        let args = build_resolve_args("keep-local", "docs/readme.md", "/Users/test/HQ");
        assert_eq!(
            args,
            vec![
                "sync",
                "resolve",
                "--strategy",
                "keep-local",
                "--path",
                "docs/readme.md",
                "--hq-path",
                "/Users/test/HQ",
            ]
        );
    }

    #[test]
    fn test_build_resolve_args_keep_remote() {
        let args = build_resolve_args("keep-remote", "file.txt", "/tmp/hq");
        assert_eq!(
            args,
            vec![
                "sync",
                "resolve",
                "--strategy",
                "keep-remote",
                "--path",
                "file.txt",
                "--hq-path",
                "/tmp/hq",
            ]
        );
    }

    // ── Path construction + traversal protection ──────────────────────

    #[test]
    fn test_build_full_path_valid() {
        let dir = tempfile::tempdir().unwrap();
        let hq = dir.path().to_str().unwrap();
        let sub = dir.path().join("docs");
        std::fs::create_dir(&sub).unwrap();
        let file = sub.join("readme.md");
        std::fs::write(&file, "").unwrap();

        let result = build_full_path(hq, "docs/readme.md");
        assert!(result.is_ok());
        assert!(result.unwrap().ends_with("docs/readme.md"));
    }

    #[test]
    fn test_build_full_path_traversal_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let hq = dir.path().to_str().unwrap();

        let result = build_full_path(hq, "../../etc/passwd");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("escapes HQ folder") || err.contains("Invalid path"));
    }

    #[test]
    fn test_build_full_path_nonexistent_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let hq = dir.path().to_str().unwrap();

        let result = build_full_path(hq, "nonexistent/file.txt");
        assert!(result.is_err());
    }

    // ── Valid strategies constant ────────────────────────────────────────

    #[test]
    fn test_valid_strategies_list() {
        assert_eq!(VALID_STRATEGIES.len(), 2);
        assert!(VALID_STRATEGIES.contains(&"keep-local"));
        assert!(VALID_STRATEGIES.contains(&"keep-remote"));
    }
}
